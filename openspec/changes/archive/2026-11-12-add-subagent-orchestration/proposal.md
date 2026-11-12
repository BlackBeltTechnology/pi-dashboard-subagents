# Proposal

## Why

Background subagents today are fire-and-poll. The parent can only read status, page through the full transcript, or cancel. A child cannot ask for a decision, the parent cannot correct a running child or continue a finished one, and every child works in the parent's cwd. That last point makes parallel editing agents unsafe, because siblings overwrite each other's files. Orchestration needs a small, explicit channel in each direction plus a per-child cwd. Reading transcripts must not be the coordination mechanism; that would defeat the context savings subagents exist for.

## What Changes

- **Optional `cwd` on `Agent`.** Absent means `ctx.cwd` (unchanged behavior). Relative paths resolve against the parent cwd. The path must exist and be a directory; otherwise the call fails before spawning. The cwd is fixed for the child's lifetime and drives:
  - the in-memory session manager;
  - the resource loader: context files, `.pi/settings.json`, project extensions;
  - `.pi/agents/<type>.md` resolution;
  - built-in tool path resolution.

  `process.cwd()` is never changed (shared process). Allowed paths follow a new setting `cwdScope`:
  - `"repo"` (default): the parent cwd, anything below it, or any worktree of the parent's git repository;
  - `"any"`: any existing directory. The package-agent index cache becomes keyed per cwd. The cwd is reported in status lines, outcomes and events. Primary use case: pointing a child at an existing git worktree. Creating and removing worktrees stays out of scope.
- **Upstream bus: per-parent in-process mailbox.** Children post messages, the parent drains them. Two message kinds:
  - `question`: from the child's `ask` call; carries a correlation id.
  - `outcome`: automatic when a child run ends; `done` / `failed` / `stopped`, with a bounded summary. A child that needs a decision uses `ask_parent`, not a special outcome.

  No server, no IPC: an in-memory queue scoped to the parent activation.
- **New child-side tool `ask_parent({ question })`.** Injected only into background children via `customTools`. It posts a `question` and blocks until the parent replies. There is no ask timeout: the parent handles the question however it likes and can reply at any time. While asking, the child releases its concurrency slot and re-acquires it with priority on reply. A manual kill always clears a waiting child: `cancel` from the parent, or a `subagents:stop` event from the dashboard or any plugin. The run time limit and shutdown do the same.
- **Every question shown to the parent carries reply instructions.** It states that the child is blocked, and gives the exact `reply` call (with the batch form when several are pending). `status` / `list` show a one-line short form.
- **Parent waits always time out.** The `wait` action and `status` with `wait` default to `timeout_s: 300`. A timeout never cancels a child.
- **Parallel questions.**
  - Each ask has its own `question_id`.
  - `wait` returns all pending questions in one batch.
  - `reply` accepts a `replies[]` batch.
  - `steer` accepts `ids[]` to broadcast a decision to children that have not asked yet.
- **One parent tool, `AgentControl({ action, ... })`**, replaces every background management tool (registered only when `allowBackground` is on). The parent's tool surface becomes exactly `Agent` + `AgentControl`; each tool definition costs context on every turn. Actions:
  - `status`, `list`, `messages`, `cancel`: today's `AgentStatus`, `AgentList`, `AgentMessages` and `AgentCancel`, as actions.
  - `AgentControl({ action: "wait", ids?, timeout_s? })`: blocks until the mailbox holds a message for the given children (or any child), then drains and returns **all** pending messages in one batch. A timeout returns empty without cancelling anything.
  - `AgentControl({ action: "reply", id, question_id, answer } | { replies: [...] })`: resolves each targeted open `ask_parent` call. The answer arrives as that tool's result, immediately, with no turn boundary.
  - `AgentControl({ action: "steer", id | ids[], message, mode: "steer" | "followUp" })`, with a result per id:
    - running child: `session.steer` / `session.followUp`;
    - idle child: `session.prompt` (a new run on the same history);
    - foreground or disposed child: an error.
- **Background children stay alive after a run** (new status `idle`), so they can be continued. They are disposed when any of these happen:
  - idle TTL `backgroundIdleTtlSec` (default 600);
  - count cap `maxIdleBackground` (default 4; the oldest idle child is evicted first);
  - `cancel`;
  - `session_shutdown`.

  `steer` / `reply` on a disposed child returns `not_alive`.
- **Outcome delivery when the parent is not waiting.** Outcomes and questions still pending when the parent's run settles are pushed as a single batched custom message via `pi.sendMessage(..., { deliverAs: "followUp", triggerTurn: <parent idle> })`. A push never interrupts a parent run, and finished work never sits unread. Controlled by a new setting `notifyParent` (default true).
- **BREAKING (tool surface):** `AgentStatus`, `AgentMessages`, `AgentList` and `AgentCancel` are no longer registered; use `AgentControl` with `action: "status" | "messages" | "list" | "cancel"` and the same parameters.
- **BREAKING (spec-level):** reverses the background-subagents requirement "results SHALL never be pushed to the parent". With `notifyParent: false`, nothing is pushed into the parent; results and questions stay pull-only.
- **Persistence model unchanged.** Children stay `SessionManager.inMemory`, in the parent process, never in their own JSONL. Every interaction (wait results, reply, steer, pushed outcome) is a parent tool call or a custom message, so the parent JSONL is the durable record. Each finished child run persists its bounded timeline with `pi.appendEntry` (stored, kept out of the model's context). Children do not survive a reload or `/resume`; their ids remain readable but not steerable.
- **`messages` is repositioned as a debug view.** Its description tells the orchestrator not to read transcripts routinely. `status` / `list` gain a one-line liveness summary: turn, tokens, last tool, cwd.

## Capabilities

### New Capabilities
- `subagent-orchestration`: the mailbox, `ask_parent`, `wait`, `reply`, `steer`, the idle lifecycle with eviction, and outcome push.
- `subagent-cwd`: the per-child working directory (parameter, validation, what follows it, per-cwd agent index, reporting).

### Modified Capabilities
- `background-subagents`: the four background tools become actions of one `AgentControl` tool (requirements renamed); the never-push requirement is replaced by the `notifyParent` rule; terminal states gain `idle` (non-terminal, continuable); `status` / `list` add the liveness line; `messages` is described as debug-only; `cancel` and shutdown also dispose idle children and reject open asks.
- `subagent-emission`: the `Agent` schema gains `cwd`; child sessions get `ask_parent` (background only) while still excluding every parent-side management tool; finished background runs persist their timeline via `appendEntry`.
- `package-agent-discovery`: the index cache is keyed per cwd instead of rebuilt on every cwd change.
- `subagent-plugin-hooks`: `subagents:*` events carry `cwd`. Every orchestration action emits an observe event, with ids only and no text: `question`, `answer`, `slot`, `steer`, `idle`, `disposed`, `mail`, `mail_dropped`, `wait`, `push`.

## Impact

- **Code:**
  - `extensions/agent.ts`: `cwd` param, child `customTools`, lifecycle (no dispose on finish for background children), per-cwd index.
  - `extensions/background.ts`: `idle` status, mailbox, eviction.
  - `extensions/background-tools.ts`: `wait`, `reply`, `steer`, liveness line.
  - `extensions/settings.ts`: `notifyParent`, `backgroundIdleTtlSec`, `maxIdleBackground`, `cwdScope`.
  - `extensions/events.ts`: new channels and the `cwd` field.
- **Memory:** idle children hold live sessions in the parent process. This is bounded by the TTL and the count cap.
- **Docs:** README "Background subagents" and "Scope" sections; `extensions/AGENTS.md`; tool descriptions (steer only works on background children; give parallel editors separate worktrees).
- **Consumers:** the dashboard subagents plugin may render new events and the `idle` status. Unknown events are ignored, so nothing breaks.
- **Dependencies:** none new. Uses pi `AgentSession.steer` / `followUp` / `prompt`, `createAgentSession({ cwd, customTools })`, `pi.sendMessage`, `pi.appendEntry`.

## Open Questions

Resolved in `design.md`: D2 covers cwd scope, D3 untrusted cwd, D4 the worktree-init check. D3 is provisional until spike 1.2.

## Verification Spikes (first tasks)

1. A child in a foreign cwd: tools, context files and `.pi/agents` all follow it.
2. Untrusted cwd: actual pi trust behavior for a headless in-memory child loader.
3. Idle child, then `session.prompt()` again with settlement handlers stripped: the second run completes cleanly, and `steer` / `followUp` during a run deliver as documented.

## Discipline Skills

`doubt-driven-review` (reverses a SHALL NOT and adds public tools; the lifecycle becomes long-lived), `security-hardening` (`cwd` is untrusted tool input that loads project extensions in-process), `systematic-debugging` (blocking ask, wait and lifecycle races), `performance-optimization` (memory held by idle in-process sessions).
