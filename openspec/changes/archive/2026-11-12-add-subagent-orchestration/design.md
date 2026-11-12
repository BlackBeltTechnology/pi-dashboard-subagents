# Design

## Context

- **Children are in-memory and in-process.** Each `Agent` call builds an `AgentSession` with `SessionManager.inMemory(cwd)` and a per-child `DefaultResourceLoader(cwd)` that has settlement handlers stripped. It runs one `session.prompt()` and then calls `dispose()`. Nothing is written to a child JSONL.
- **What survives a run.**
  - Foreground: the `Agent` tool result in the parent JSONL.
  - Background: the per-activation registry (`background.ts`), memory only.
- **Coordination today is pull-only.** The parent has `status` (with `wait: any|all`), `messages`, `list` and `cancel`. The background-subagents spec forbids any push into the parent.
- **Relevant pi primitives** (verified in the `agent-session.d.ts` / `sdk.d.ts` typings):
  - `session.steer()`, `session.followUp()` and `session.prompt()`;
  - `session.abort()` and `session.subscribe()`;
  - `createAgentSession({ cwd, customTools })`;
  - `pi.sendMessage(msg, { deliverAs, triggerTurn })` and `pi.appendEntry()`.
- **Delivery timing.**
  - A steer lands after the child's current turn and its tool calls.
  - A follow-up lands when the run has no more tool calls.
  - After a run settles, pi no longer reads its follow-up queue.
- **Concurrency is gated by the `maxConcurrent` semaphore**, with a foreground lane and a background lane.

## Goals / Non-Goals

**Goals:**
- The parent can steer a running background child and continue a finished one, without reading its transcript.
- A child can ask the parent a question and get a correlated answer.
- The parent learns of outcomes and questions without polling, and is never interrupted mid-run.
- Each child can work in a chosen cwd (typically a git worktree).
- The parent JSONL remains the only durable record. There are no extra processes and no child JSONL files.

**Non-Goals:**
- Creating, initialising, merging or removing worktrees.
- Child↔child messaging, nested orchestration, or a broadcast bus.
- Steering foreground children. A blocking tool call makes that impossible for the parent; the human dashboard path is unaffected.
- Children surviving a reload, `/resume` or process restart, or being rebuilt from the JSONL.
- Free-form progress or "tell" messages from children.

## Decisions

### D0. One `AgentControl` tool, not one tool per operation

Each registered tool's name, description and JSON schema enter the parent's context on every turn. So every parent-side operation is an `action` of a single `AgentControl` tool: `status`, `list`, `messages`, `cancel`, `wait`, `reply`, `steer`. The parent sees exactly `Agent` + `AgentControl`, and children see only `ask_parent`.

- **Schema:** one flat `Type.Object` with a required `action` enum, plus every action's parameters as optionals. Discriminated unions render poorly in many providers' tool-schema dialects.
- **Validation:** `execute` validates per action and returns an error result naming the missing parameters or the valid actions.
- **Description:** one compact line per action, plus the orchestration rules (only background children can be steered; answer questions with `reply`; `messages` is debug-only).
- **Breaking:** `AgentStatus`, `AgentMessages`, `AgentList` and `AgentCancel` disappear. Parameters are unchanged, so migrating is mechanical.
- **Query channels and events are unchanged.** `subagents:list` / `subagents:get` still serve the same data, and `subagents:result_read` keeps `via: status | messages`.
- **Rejected alternative:** keep the four tools and add three. That makes eight parent tools (`Agent` plus seven), most of them rarely used.

### D1. Bus up, answer + steer down

```
child ──ask_parent (blocks)──► mailbox ◄── outcome (auto, per run)
                                  │ drained by AgentControl wait / pushed when parent not waiting
parent ──AgentControl reply(qid)──► resolves child's ask_parent promise (immediate)
parent ──AgentControl steer(mode)──► session.steer / followUp / prompt
```

- **Questions are answered by resolving the blocked tool call, not by steering.** A steer is delivered only after the child's current tool calls finish. A blocked `ask_parent` waiting for that steer would therefore deadlock.
- **Rejected alternatives:**
  - Symmetric bus: children would get an escape hatch, the parent would be interrupted, and message ordering becomes a problem.
  - Parent reads transcripts: wastes context and duplicates the child's work.

### D2. `cwd` scope: `cwdScope: "repo" | "any"`, default `"repo"`

The `cwd` argument is untrusted model input. In `"repo"` mode it is accepted only if its realpath is one of:
- the parent cwd, or below it;
- inside the parent's git toplevel;
- a worktree sharing the parent's git common dir (`git rev-parse --git-common-dir`). This covers worktrees outside the repo, such as `../wt-x`.

Non-git parent: only the parent cwd or below it. `"any"` accepts any existing directory.

Validation happens before the spawn queue, so no record, event or slot is created for a rejected cwd. A relative cwd resolves against the parent cwd. Symlinks are resolved before the check.

- **Rejected alternatives:**
  - Unrestricted by default: a prompt-injected parent could load another project's extensions in-process.
  - Dashboard access grants: would add a dependency on the dashboard server, which this package does not need.

### D3. Untrusted cwd: resolve pi trust explicitly; never prompt *(settled by spike 1.2)*

**Finding.** Our child loader does not pass a `settingsManager` or `resolveProjectTrust`. pi then builds `SettingsManager.create(cwd, agentDir)`, and `projectTrusted` **defaults to `true`**. So today every child loads project settings, project extensions and `SYSTEM.md` from its cwd **without any trust check**.
- This is harmless only while the cwd is the parent's own cwd.
- It is a latent issue even now: an untrusted parent's children load project extensions anyway.
- With `cwd` as model input it becomes a real hole.

**Decision.** Compute trust per child with pi's exported pieces, mirroring pi's non-interactive `resolveProjectTrusted`, which is not exported:
1. `!hasTrustRequiringProjectResources(cwd)` → trusted. There is nothing that needs trust.
2. `new ProjectTrustStore(agentDir).get(cwd)` is not null → use that decision. The store resolves the nearest ancestor entry, so `repo/.worktrees/x` inherits a trusted `repo`.
3. Otherwise `settings.getDefaultProjectTrust()`: `"always"` → trusted; `"never"` or `"ask"` → **untrusted**. There is no UI, so we never prompt.

Pass `SettingsManager.create(cwd, agentDir, { projectTrusted })` to both the `DefaultResourceLoader` and `createAgentSession`. An untrusted child still gets context files (pi loads them without trust), built-in tools and global extensions, but no project settings, extensions or `SYSTEM.md`. This applies to **every** child, including the default parent-cwd case. That closes the latent issue too; it's a behaviour fix to call out in the CHANGELOG.

### D4. No worktree-init check

Preparing the worktree is the parent's job. The `Agent` / `cwd` tool description says so. This keeps the package independent of the dashboard's `worktreeInit` hook.

### D5. Lifecycle: `queued → running → idle ⇄ running → disposed`

- **When a background run finishes:**
  - store the outcome;
  - persist the run timeline (D8);
  - post an `outcome` to the mailbox;
  - **release the semaphore slot**;
  - set the status to `idle`, keeping the session alive.
- **`steer` on an idle child** re-acquires a background slot (queued if the lane is full) and calls `session.prompt(message)` without awaiting it, so it returns `started` or `queued`. `run` increments.
- **The child is disposed on any of:**
  - `backgroundIdleTtlSec` (default 600, `0` = dispose immediately, which is the old behaviour);
  - `maxIdleBackground` (default 4, oldest idle evicted);
  - `cancel`;
  - `session_shutdown`.
- **Status vocabulary.** A disposed child keeps its last outcome readable, with status `completed` / `error` / `stopped` as today. `idle` is non-terminal for steering but counts as finished for `status wait` (`any` / `all`), so existing waits keep their meaning.
- **Budgets.**
  - `maxBackgroundPending` counts `queued` + `running` only; idle children do not count.
  - `backgroundTimeoutSec` / `timeout_s` applies per run.

### D6. `steer` routing

`steer` accepts a single `id` or `ids[]` (broadcast). Each id is routed independently and gets its own result; one bad id never fails the others.

| child state | `mode: steer` | `mode: followUp` |
|---|---|---|
| running | `session.steer` → `queued` | `session.followUp` → `queued` |
| idle | new run via `prompt` → `started` / `queued` | same |
| queued (not started) | error `not_started` | error `not_started` |
| foreground | error `foreground` | error `foreground` |
| disposed / reloaded | error `not_alive` | error `not_alive` |

A child blocked in `ask_parent` is `running`: a steer is accepted and lands after `ask_parent` returns. The tool description tells the model to use `reply` for questions.

### D7. Mailbox, `wait` and push

- **One mailbox per parent activation.** Entries are `{ seq, id, kind: question|outcome, question_id?, text, run, ts, delivered }`. It is bounded by `maxMailbox` (internal constant 100). Overflow drops the oldest **outcome** entries (still readable via `status`); questions are never dropped.
- **`AgentControl({ action: "wait", ids?, timeout_s? })`** resolves as soon as an undelivered entry matches, after a ~250 ms coalescing window, and returns **all** matching undelivered entries, marking them delivered.
  - Default `timeout_s` is **300**; `status` with `wait` uses the same default. A parent wait never blocks forever. A timeout returns an empty list.
  - An abort ends only the wait.
  - Only one wait at a time per activation. A second call is rejected with `wait_in_progress`.
- **Push (`notifyParent: true`).** When an entry is posted and no `wait` is active, start a 1 s batch window, then:
  - always `pi.sendMessage({ customType: "subagents:mail", content }, { deliverAs: "followUp", triggerTurn: true })`.
  - pi applies `triggerTurn` only when the parent is idle; while it streams, the follow-up just queues. So one call covers both cases and no idleness check (or race) is needed. *(Settled during implementation.)*

  Pushed entries are marked delivered, so a later `wait` never returns them twice. Content stays bounded: one line per entry, with summaries cut to `outcomeSummaryChars` (internal 500).
- **`notifyParent: false`** keeps everything pull-only (today's contract).

### D8. Persistence

- Each finished background run calls `pi.appendEntry("subagents:run", details)` with the same bounded `AgentDetails` shape the foreground `Agent` result uses. It is stored in the parent JSONL and kept out of the model's context.
- Questions, answers, steers and pushes are already parent tool calls or custom messages, so the conversation needs no extra storage.
- After a reload, the registry is empty. `steer` / `reply` on an unknown `bg-` id return `not_alive` when the id appears in a persisted `subagents:run` entry, and `not_found` otherwise.

### D9. `ask_parent` semantics

- Injected via `customTools` into **background** children only. Foreground children never get it.
- `ask_parent({ question })` takes no timeout parameter.
- `execute` posts a `question` entry with a fresh `question_id`, then awaits a promise that settles on one of:
  - **`reply`:** returns the answer text;
  - **stop, cancel, run time limit or shutdown:** rejects, which ends the child's tool call with an error.
- **There is no ask timeout.** The child waits until the parent replies.
  - How the parent produces the answer, and how long it takes, is the parent's business. This package only delivers the question and the reply.
  - Waiting forever is cheap: the slot is released while asking (D12).
  - A forgotten question is visible: `asking` in `status` / `list`, the undelivered or pushed mailbox entry, and the `subagents:question` event.
  - An optional background run time limit (`timeout_s` / `backgroundTimeoutSec`) still applies.
- The child's tool-call `signal` abort also settles the promise.
- **Manual kill always works while asking.** Both `cancel` (from the parent) and `subagents:stop` (from any plugin or the dashboard on the bus) settle the pending ask with `via: cancel`, cancel a pending slot re-acquire, and stop the child through the shared stop path. This is how stuck askers are cleared.
- Rejected alternative: an ask timeout returning "proceed with an assumption". It makes the child guess while the parent is legitimately still deciding.

### D12. Asking releases the concurrency slot; it is re-acquired with priority

A child blocked in `ask_parent` makes no model calls, so holding its slot would let parallel askers starve the queue.

```
maxConcurrent: 3   bg-a ⏸ bg-b ⏸ bg-c ⏸  → slots free → bg-d, bg-e start
reply(q1) → bg-a re-acquires at the FRONT of the background lane
```

- On ask: release the slot; status stays `running` with the `asking` flag.
- On reply: re-acquire **before** `ask_parent` returns. Re-acquirers go ahead of all ordinary background waiters, but foreground waiters still go first (the existing lane rule). Positions follow that order.
- Stop or cancel while re-acquiring cancels the acquire; no slot leaks.
- `maxConcurrent` therefore means "children actively running a model turn or tool". The background run-time limit (`timeout_s`) keeps counting while asking.
- Rejected alternative: keep the slot. Simpler, but N parallel askers block the whole queue until the timeout.

### D14. Questions reach the parent with reply instructions

Every time a question is shown to the parent, the text tells it the child is blocked and gives the exact call to unblock it.

**Full form** in `wait` results and pushed messages:
```
⏸ bg-a is BLOCKED until you answer (asked 12s ago, cwd .worktrees/auth)
  q1: "JWT or session cookie?"
  → reply now: AgentControl({ action: "reply", id: "bg-a", question_id: "q1", answer: "…" })
```
When more than one question is pending, add a closing line: `answer all at once: AgentControl({ action: "reply", replies:[…] })`.

**Short form** in `status` / `list`, one line per child:
```
bg-a running ⏸asking q1 "JWT or session cookie?" (12s) → AgentControl(reply bg-a q1)
```
The question text in the short form is cut to 120 characters. The full text is always in the full form.

### D13. Batch reply

`reply` accepts either the single form `{ id, question_id, answer }` or `{ replies: [{ id, question_id, answer }, ...] }`. Each entry settles independently and gets its own result (`answered` / `not_pending` / `not_found` / `not_alive`). A typical turn after `wait` returns N questions is a single `reply` call. To give the same answer to children that have not asked yet, the parent uses `AgentControl({ action: "steer", ids })`.

### D10. Per-cwd package-agent index

The single-slot cache (rebuilt on every cwd change) becomes a map keyed by cwd. It is bounded (LRU, 8 entries), so siblings in different worktrees don't thrash it. `resources_discover` still rebuilds the current entry.

### D11. Events: every orchestration action is observable

Every state change and parent action introduced here emits exactly one observe event per affected child (batch and broadcast calls fan out to per-id events). Payloads carry ids, kinds and results only. Question, answer, steer and summary **text** is never put on the bus.

| Channel | Payload | When |
|---|---|---|
| `subagents:question` | `{ id, agentId, question_id, run }` | `ask_parent` posts |
| `subagents:answer` | `{ id, agentId, question_id, via: reply \| cancel }` | an ask settles |
| `subagents:slot` | `{ id, agentId, action: released \| reacquire_queued \| reacquired, queuePosition? }` | the D12 slot hand-off |
| `subagents:steer` | `{ id, agentId, mode, result }` | each id of a `steer` |
| `subagents:idle` | `{ id, agentId, run }` | a run ends and the child stays alive |
| `subagents:disposed` | `{ id, agentId, reason: ttl \| cap \| cancel \| shutdown }` | an idle child is freed |
| `subagents:mail` | `{ id, agentId, seq, kind: question \| outcome, outcome? }` | a mailbox entry is posted |
| `subagents:mail_dropped` | `{ id, agentId, seq }` | overflow drops an outcome |
| `subagents:wait` | `{ phase: start \| end, ids?, returned?, timedOut? }` | `wait` begins / ends |
| `subagents:push` | `{ seqs, count, triggerTurn }` | a batched push is sent |

Every `subagents:*` lifecycle payload also gains `cwd`. All new payload types are exported from `index.ts`.

## Spike Findings (tasks 1.1–1.3)

Run against pi with a faux provider, a real `DefaultResourceLoader` with settlement handlers stripped, and a real `createAgentSession`. The scratch test was deleted afterwards.

| # | Check | Result |
|---|---|---|
| 1.1 | `read notes.txt` in the child cwd | ✅ child file read, not the parent's |
| 1.1 | `bash pwd` | ✅ child cwd |
| 1.1 | Child `AGENTS.md` in the system prompt | ✅ present; the sibling parent's `AGENTS.md` is absent (pi walks up the cwd's own ancestors only) |
| 1.1 | `process.cwd()` | ✅ unchanged |
| 1.2 | Trust for the in-memory child loader | ⚠ always trusted by default (see D3) |
| 1.3a | Second `prompt()` on an idle kept-alive session | ✅ completes; run 2's request contains run 1's history; `isStreaming` is false between runs |
| 1.3b | `steer()` during a tool call | ✅ returns `queued`; the next request is `… toolResult, user:STEER` (after the tool result, before the next model call) |
| 1.3b | `followUp()` during a tool call | ✅ returns `queued`; it is absent from the post-steer request and delivered in a third request after the run's last assistant message (same `prompt()` call) |
| 1.3c | Blocking `customTools` tool (`ask_parent` shape) | ✅ active by default; the session stays streaming while it awaits; resolving the promise externally delivers the answer as the tool result to the next request |

Consequences:
- D5, D6 and D9 hold as designed.
- `customTools` are active by default, so the tool allowlist must keep `ask_parent` for background children and drop it for foreground ones (already specified).
- A worktree nested inside the repo (`repo/.worktrees/x`) will load both its own and the repo's `AGENTS.md`, because the repo is an ancestor. That's expected and documented. A sibling worktree (`../wt-x`) loads only its own.

## Known Limitations (found in review)

- A steer message that pi treats as an extension command makes `session.steer` throw; it is reported as `not_alive`.
- A stop while a continuation (run 2+) is still queued reports the generic "removed from queue before starting" text.

## Risks / Trade-offs

- **Memory held by idle sessions.** Bounded by the TTL and `maxIdleBackground`. Mitigation: `backgroundIdleTtlSec: 0` restores dispose-on-finish.
- **Unanswered asks.** A child can wait indefinitely if the parent never replies. It holds no slot (D12), only memory, and is visible as `asking`. It is freed by `cancel`, the run time limit, or shutdown.
- **Push at the parent's run boundary.** A follow-up sent exactly as the parent's run settles may wait for the next turn. The entry is already marked delivered, so `wait` won't return it twice. Acceptable.
- **Reversing the never-push rule.** Behavioural break for anyone who relied on a silent parent. Mitigation: `notifyParent: false`.
- **The cwd is untrusted input.** Mitigated by D2 and D3, with path tests (symlink escape, `..`, foreign repo, non-existent path).
- **Extensions in other projects.** A trusted foreign cwd loads that project's extensions in the parent process. This is inherent to the in-process design and is documented.
- **pi API drift.** `steer`, `followUp` and `customTools` are public SDK surface. The spikes pin their behaviour, and tests use fakes that mirror the documented semantics.
