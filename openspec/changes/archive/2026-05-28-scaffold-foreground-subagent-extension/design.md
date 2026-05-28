## Context

`pi-dashboard-subagents` ships into a specific ecosystem hole: the
pi-agent-dashboard's `add-subagent-inspector` change defined a Tier-1
timeline contract (`entries: SubagentTimelineEntry[]`) but no producer
exists for it. `@tintinweb/pi-subagents` streams only summary data;
`pi-subagents` (Nico) streams rich data but creates session-list-clutter
via separate `pi` child processes.

This extension fills the gap: in-memory spawn AND rich timeline. The design
is bounded by what pi-coding-agent's public API actually supports.

## Goals / Non-Goals

**Goals:**

- Foreground subagent runs spawned via `createAgentSession` + `SessionManager.inMemory`.
- Per-event emission to pi's event bus (channels `subagents:*`), automatically
  forwarded to the dashboard by its bridge's emit intercept.
- Optional context inheritance with verbatim compression — operator-tunable
  via persistent config; LLM-overridable per-call only when the operator
  opts in.
- Zero new sessions on disk; zero entries in the dashboard's session list.
- Surface `agentMdPath` so the dashboard can render a "View source" link
  for custom agents.

**Non-Goals:**

- Background spawning. The whole "fire-and-forget" lifecycle (queue,
  persistence, `get_subagent_result`, `steer_subagent`) is omitted.
- Upstream prompt-cache fork. Requires SDK paths pi-coding-agent doesn't
  expose; tracked as v0.2.x work.
- LLM-based context summarization. The verbatim-compaction strategy is
  zero-hallucination and free; LLM summarization is more compression for
  more cost and risk.
- Chain / parallel / sub-task orchestration. Single-spawn only.
- TUI overlays (conversation viewer, schedule menu). The dashboard is the
  UI surface; the terminal pi widget is intentionally bare.

## Decisions

### Decision 1: Spawn via `createAgentSession + SessionManager.inMemory`

The only path through pi-coding-agent that keeps the subagent off disk
and lets the parent process subscribe to every event. `child_process.spawn`
of the `pi` CLI is explicitly forbidden — it creates new sessions on disk
that the dashboard's session-scanner picks up, defeating the whole purpose.

Reference pattern: `@tintinweb/pi-subagents/src/agent-runner.ts` lines
267-281 use this exact API. We follow it verbatim, minus the @tintinweb-
specific features (agent registry, memory, worktree isolation, etc.).

### Decision 2: Event bus emission via `pi.events.emit("subagents:*")`

The pi-agent-dashboard's bridge already maps `subagents:*` channels to
`subagent_*` protocol events via its emit intercept
(`packages/extension/src/bridge.ts:1094-1115`). Reusing this channel
namespace means zero work on the dashboard side — the inspector
infrastructure (`SubagentDetailView`, `SubagentPopoutPage`,
`AgentToolRenderer` expand button) lights up the moment we emit.

Alternative considered: defining our own channel namespace
(e.g. `dashagent:*`) and asking the dashboard to add a new map entry.
Rejected — duplicates the same purpose, requires coordinated dashboard
release.

### Decision 3: Inherit context by default (opt-out via setting)

Most foreground subagents are spawned mid-task and benefit from seeing
what the parent has been doing. Making isolation the default (as
`@tintinweb/pi-subagents` does today) hurts the common case to optimize
the rare case.

The setting is global because:
- Most users will set it once based on their workflow preference.
- The LLM doesn't need a per-call knob 95% of the time.
- The operator-firm-control mode is valuable enough to keep
  (`exposeInheritanceInTool: false`) as the default schema shape.

### Decision 4: Verbatim-compaction over LLM summarization

From research (web search: "AI Agent Context Compression" 2026 survey
and "Don't Break the Cache" paper):

| Strategy            | Compression | Hallucination | Cost  | Speed |
| ------------------- | ----------- | ------------- | ----- | ----- |
| Verbatim compaction | 50-70%      | 0             | free  | fast  |
| Token pruning       | 2-20×       | low           | free  | fast  |
| LLM summarization   | 70-90%      | medium        | $$    | slow  |

For our use case (short-lived foreground subagents inheriting parent
context up to ~6K tokens after compression), verbatim is the right
fit. Zero failure modes, no hallucination, no extra LLM calls.

Strategy: keep last N turn pairs verbatim; mask older tool outputs
and large text blobs; hard-cap by char count with middle-truncation
(preserves the first user turn + the most recent turns).

### Decision 5: `exposeInheritanceInTool` toggle defaults to OFF

Tradeoffs:
- ON: LLM gets per-call `isolated` parameter, can decide per task.
  Adds a knob the LLM doesn't usually need.
- OFF: Tool schema is lean. Operator controls inheritance globally
  via `inheritContext`. Predictable, no surprises.

Default OFF because most users will pick a strategy (inherit or not)
and stick with it. Power users who want per-task control flip the
setting on.

### Decision 6: Schema is fixed at extension activation

Forced by pi-coding-agent's `pi.registerTool` having no `unregisterTool`
counterpart. The `exposeInheritanceInTool` setting is therefore read
once at activation time. Changes apply on the next pi `/reload` or new
session start (both of which re-fire extension activation).

`inheritContext` and `inheritance.*` ARE re-read per-spawn (no schema
implication), but a setting-cache in `settings.ts` means they also
require `/reload` to take effect within the same pi session. This is
the same UX shape: one rule for everything.

### Decision 7: Subscribe to `session.subscribe()` for the timeline

Per-event capture for `tool_execution_end`, `message_update` (with
`text_end` / `thinking_end` / `error` substream events), and life-cycle
events (`turn_end`, `compaction_end`). Maps via `mapSessionEventToEntry`
in `events.ts` to the four `SubagentTimelineEntry` kinds the dashboard
renders.

Tool inputs are NOT in `tool_execution_end` — they only appear in
`tool_execution_start`. A small pairing tracker (`createToolCallTracker`)
matches starts with ends so the timeline entry has `input` populated.

### Decision 9: Read parent messages via `ReadonlySessionManager.getBranch()`, not a non-existent `getMessages()`

The currently shipped `buildInheritedContext` in `extensions/events.ts:393–394` reads:

```ts
const sm = (ctx as unknown as { sessionManager?: { getMessages?: () => unknown[] } }).sessionManager;
const raw = sm?.getMessages?.();
```

The JSDoc above this line admits the API is uncertain ("The exact API may differ across
pi-coding-agent versions; we read defensively"). The defensive shape was wrong: pi-coding-agent's
`ReadonlySessionManager` is a `Pick<SessionManager, ...>` and the picked methods are
`getCwd | getSessionDir | getSessionId | getSessionFile | getLeafId | getLeafEntry | getEntry |
getLabel | getBranch | getHeader | getEntries | getTree | getSessionName`
(`pi-coding-agent/dist/core/session-manager.d.ts:136`). No `getMessages()`. The optional-chained
call therefore silently returns `undefined` on every invocation, the `Array.isArray(raw)` check
fails, the function returns `""`, and **inheritance is dead-on-arrival** regardless of every other
knob.

The correct API is `sessionManager.getBranch(fromId?)` — documented as "Walk from entry to root,
returning all entries in path order. Includes all entry types (messages, compaction, model
changes, etc.). Use `buildSessionContext()` to get the resolved messages for the LLM"
(`session-manager.d.ts:240–244`). `buildSessionContext()` would be ideal but is NOT in the
`ReadonlySessionManager` pick set, so we use `getBranch()` and filter manually:

```ts
const branchEntries = ctx.sessionManager.getBranch();
const chronological = [...branchEntries].reverse();  // getBranch is leaf→root; we want root→leaf
const messages = chronological
  .filter((e): e is SessionMessageEntry => e.type === "message")
  .map(e => e.message)
  .filter(m => m.role === "user" || m.role === "assistant");
```

Why `getBranch()` and not `getEntries()`:

- `getEntries()` returns ALL entries across all branches — if the user has forked mid-session, the
  result contains both branches, producing a non-linear conversation that confuses compression.
- `getBranch()` walks the leaf-to-root path of the currently active branch only — exactly the
  conversation the LLM is seeing, which is the conversation the subagent should inherit.

Why not call `buildSessionContext()` even though it's not in the readonly view: the spec doesn't
forbid asking pi-coding-agent to widen the pick set in a future version, but doing so now would
be an upstream change with longer lead time than the fix needs. Manual filtering against the
public `SessionEntry` union is stable and one screen of code.

The defensive `as unknown as { ... }` cast in the current code can stay (the entry's `message`
field is `AgentMessage`, a union; the downstream `renderContent` already coerces shapes), but the
method name MUST switch from the non-existent `getMessages` to the real `getBranch`.

### Decision 8: Status taxonomy intentionally narrower than @tintinweb's

@tintinweb supports: `queued | running | completed | steered | aborted | stopped | error | background`.

We support: `queued | running | completed | aborted | stopped | error`.

Dropped values: `steered` (no steering API exposed in v0.1.x),
`background` (not supported by design).

The dashboard's `SubagentDetailView` handles unknown statuses via a
default-case fallback, so dropping values is safe forward-compat.

## Risks / Trade-offs

| Risk                                                                       | Mitigation |
| -------------------------------------------------------------------------- | ---------- |
| pi-coding-agent SDK changes break the events.ts contract                   | Pin the peer-dep range tightly. Test against multiple pi-coding-agent versions in CI. |
| Subagent inherits parent's auth/credentials by accident                    | Pi's `ExtensionAPI`/`ExtensionContext` is parent-scoped; subagent sessions created via `createAgentSession` inherit `modelRegistry` and credentials. This is the desired behavior. Document clearly. |
| Compression drops important context (e.g. critical file content past N=2 turns) | `inheritance.toolOutputWindow` is tunable. Default may need adjustment after real-world usage. |
| Tool nesting (subagent spawns Agent tool, recursion)                       | After `createAgentSession`, call `session.setActiveToolsByName(allActive.filter(t => t !== "Agent"))` to remove our own tool from the subagent's set. Matches @tintinweb's `EXCLUDED_TOOL_NAMES = ["Agent", "get_subagent_result", "steer_subagent"]` pattern. |
| Dashboard bridge isn't loaded in the parent — emissions go nowhere         | Acceptable: extension is dashboard-aware but not dashboard-dependent. Emissions become no-ops when `pi.events` is missing or no listener exists. The local pi session still works (the subagent runs; the parent just doesn't get the rich UI). |
| User edits config.json mid-session, gets confused why nothing changes      | Document `/reload` requirement clearly. Future: file-mtime invalidation in `settings.ts` (out of scope for v0.1.x; one-line change later). |
| `buildInheritedContext` shipped against a non-existent `ReadonlySessionManager.getMessages()` method (`events.ts:393–394`), making inheritance dead-on-arrival until fixed | Decision 9 specifies the correct API (`getBranch()` + manual filter to `type === "message"`). Task §9 in tasks.md tracks the code change + tests. Inheritance must remain dormant in dependent flows (the dashboard side) until §9 lands, because every `buildInheritedContext` call currently returns `""`. |

## Migration Plan

None. New extension, no existing users. v0.1.x is the first release.

## Open Questions

1. Should `inheritance.maxChars` be expressed as character count or token count?
   - Decision: chars. Token counting requires a tokenizer; chars are universal
     and ~4 chars/token is a fine heuristic. Documented as ~6K tokens default.

2. When the subagent fails, should we surface the partial entries[] collected
   so far in the `subagents:failed` emission, or just the error?
   - Decision: include partial entries. Lets the dashboard show "where it
     got to before crashing" — high-signal for debugging.

3. Should `agentMdPath` resolution be deferred (resolve at spawn time)
   or eager (resolve when the agent type is first invoked)?
   - Decision: resolve at spawn time. Cheap (two fs.existsSync calls),
     captures the right cwd-relative path for project-level `.pi/agents/`.

4. Should `buildInheritedContext` use `getBranch()` or `getEntries()` for parent
   message access?
   - Decision (Decision 9): `getBranch()`. It returns the linear root→leaf path of
     the currently active branch, which matches the conversation the LLM is
     seeing. `getEntries()` returns all entries across all forks and would
     produce non-linear input to the compression algorithm.

## Locked decisions (do not relitigate)

- No background spawning. v0.1.x = foreground only.
- No upstream prompt-cache fork. Token-savings-from-compression only.
- No LLM summarization. Verbatim compaction only.
- No `get_subagent_result` / `steer_subagent` tools.
- Tool schema is fixed at registration. `/reload` to apply schema changes.
- Inherit by default. Operator opts out via `inheritContext: false`.
- `exposeInheritanceInTool` defaults OFF. Lean schema.
