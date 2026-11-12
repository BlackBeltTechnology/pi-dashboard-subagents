# Tasks

> TDD: each implementation task writes failing tests first, then the minimal code. Section 1 runs first; spike findings may revise `design.md` (D3 especially) before section 2 starts. Section 10 always runs last.

## 1. Verification spikes

- [x] 1.1 Child in a foreign cwd. A faux-provider spike (pattern: `entry-stream-faux.test.ts`) spawns a child with `cwd` set to a temp repo. Confirm that built-in `read` / `bash`, context files and `.pi/agents/<type>.md` resolve against the child cwd, and that `process.cwd()` is unchanged. Verify: finding recorded in `design.md` (D3 / Context).
- [x] 1.2 Untrusted cwd. Record what pi trust does for a headless in-memory `DefaultResourceLoader` on an untrusted cwd: project extensions loaded, skipped, or a prompt attempted. Verify: D3 confirmed or revised in `design.md`.
- [x] 1.3 Multi-run session. On a kept-alive in-memory child with settlement handlers stripped, a second `session.prompt()` completes. During a run, `session.steer()` lands after the current tool calls and `session.followUp()` lands at the end of the run. Verify: finding recorded in `design.md` (D5 / D6).

## 2. Settings

- [x] 2.1 Failing tests in `__tests__/settings.test.ts` for `notifyParent` (default true), `backgroundIdleTtlSec` (default 600, `0`, coercion), `maxIdleBackground` (default 4) and `cwdScope` (`"repo"` default, `"any"`, invalid falls back to `"repo"`). Then add the keys, merge logic and getters in `settings.ts`. Verify: `npm test -- settings` green.
- [x] 2.2 Export the new getters and types from `index.ts`. Verify: `npm run typecheck`.

## 3. `cwd` parameter and validation (subagent-cwd)

- [x] 3.1 Failing tests for a pure `resolveSubagentCwd(parentCwd, arg, scope)`:
  - absent → parent cwd;
  - relative → resolved;
  - missing → `cwd_not_found`;
  - file → `cwd_not_dir`;
  - symlink escape → `cwd_out_of_scope`;
  - foreign repo rejected under `"repo"`;
  - a sibling worktree with the same git common dir accepted;
  - non-git parent limited to its subtree;
  - `"any"` accepts.

  Then implement it (git via argv, no shell). Verify: tests green.
- [x] 3.2 Add `cwd` to the `Agent` schema and description ("give each parallel editor its own worktree; preparing the worktree is your job"). Validate before `before_spawn`, the record and the queue. A rejected cwd emits no events. Verify: spawn-path test asserts no `subagents:created` on rejection.
- [x] 3.3 Thread the resolved cwd into `SessionManager.inMemory`, `createChildLoader` and agent `.md` resolution. Add `cwd` to every `subagents:*` payload, the record, `status` and `list`. Verify: `events.test.ts` and `background.test.ts` assertions on `cwd`.
- [x] 3.4 D3 trust for **every** child. Failing tests:
  - a temp cwd with a `.pi/extensions/x.ts` and no trust entry → extension not loaded, no prompt;
  - a `ProjectTrustStore` entry `true` on the parent dir → loaded in `repo/.worktrees/x`;
  - `defaultProjectTrust: "always"` → loaded;
  - no trust-requiring resources → trusted.

  Then build `SettingsManager.create(cwd, agentDir, { projectTrusted })` and pass it to the loader and `createAgentSession`. CHANGELOG: children no longer bypass project trust. Verify: tests green; `entry-stream-faux` green.

## 4. Per-cwd package-agent index

- [x] 4.1 Failing tests in `package-discovery.test.ts`: an LRU of 8; alternating cwds don't rebuild; `resources_discover` drops all entries and rebuilds the event cwd. Then replace the single-slot cache. Verify: tests green.

## 5. Idle lifecycle (background)

- [x] 5.1 Failing tests in `background.test.ts`:
  - new status `idle` and a `run` counter;
  - idle releases the semaphore slot;
  - TTL eviction (fake timers);
  - `maxIdleBackground` evicts the oldest;
  - `backgroundIdleTtlSec: 0` disposes immediately;
  - `idle` satisfies `status` with `wait: any|all`;
  - `maxBackgroundPending` ignores idle children.

  Then implement them in `background.ts` and the spawn path in `agent.ts`: no `dispose()` on a background finish; store the result, post the outcome, release the slot, set idle. Verify: tests green; `spawn-queue.test.ts` and `fanout-memory` still green.
- [x] 5.2 `cancel` disposes idle children (`disposed`), filters `status: idle`, and settles pending asks. Shutdown disposes idle children, settles asks, and cancels pending pushes. Verify: updated cancel and shutdown tests.
- [x] 5.3 Liveness line in `status` / `list`: status, run, turn, tokens, last tool, cwd, `asking`. Idle counts appear in `list`. Verify: snapshot tests within `resultMaxChars`.

- [x] 5.4 One `AgentControl` tool (D0). Failing tests:
  - with `allowBackground` on, exactly `Agent` + `AgentControl` are registered;
  - `status` / `list` / `messages` / `cancel` actions behave as the old tools, with the same parameters;
  - an unknown action → error listing the valid actions;
  - missing parameters → error naming them;
  - children exclude `Agent` and `AgentControl`.

  Then replace the four `makeAgent*Tool` registrations with one `makeAgentControlTool` dispatching to the existing handlers. Migrate the existing suites (`background-spawn`, `plugin-hooks`, `agent`, `entry-stream-faux`) to the action form. Verify: full suite green.

## 6. Mailbox, `wait`, push

- [x] 6.1 Failing tests for the mailbox:
  - per-activation isolation;
  - entry shape;
  - an outcome posted on every run end (`done` / `failed` / `stopped`, summary ≤500 chars);
  - overflow drops the oldest outcomes and never questions.

  Then implement them in `background.ts` or a new `mailbox.ts`. Verify: tests green.
- [x] 6.2 `AgentControl({ action: "wait", ids?, timeout_s? })`: batch drain, ~250 ms coalescing, default `timeout_s` 300, timeout returns empty, abort ends only the wait, `wait_in_progress` on a second call. `AgentStatus wait` also defaults to 300. Add it as an `AgentControl` action. Verify: tests green (fake timers).
- [x] 6.3 Push (`notifyParent`). Tests use a fake parent `pi` / `ctx`:
  - no push while `wait` is active;
  - 1 s batching yields one `sendMessage`;
  - streaming parent → `deliverAs: "followUp"`, no `triggerTurn`;
  - idle parent → `triggerTurn: true`;
  - idleness re-checked at flush;
  - pushed entries never returned by `wait`;
  - `notifyParent: false` → zero `sendMessage` / `sendUserMessage`;
  - no push after shutdown.

  Then implement them. Verify: tests green.

## 7. `ask_parent` and `reply`

- [x] 7.1 Failing tests:
  - `ask_parent({ question })` is in background children's active tools only, and never with the parent-side tools;
  - an ask posts a question and blocks with **no timeout** (an hour of fake time later, a reply still delivers);
  - `reply` returns the answer as the tool result;
  - double reply gets `not_pending`.

  Then implement the `ask_parent` tool via `createAgentSession({ customTools })`, and the single-form `reply`. Verify: tests green.
- [x] 7.2 Manual kill while asking. Failing tests that each of these settles the ask with `via: cancel`, ends the child `stopped`, and leaves no slot or pending re-acquire:
  - `cancel` from the parent;
  - `subagents:stop` from an external emitter;
  - the run time limit;
  - shutdown;
  - the tool signal.

  Verify: tests green; `spawn-queue.test.ts` slot accounting green.
- [x] 7.3 Slot release while asking (D12). Failing tests: parallel askers free their slots so queued children start; an answered asker re-acquires ahead of ordinary background waiters and behind foreground ones; a stop during re-acquire cancels it. Then implement the semaphore hook. Verify: tests green.
- [x] 7.4 Batch `AgentControl({ action: "reply", replies[] })` with per-entry results; one bad entry does not fail the others. Verify: tests green.
- [x] 7.5 Reply instructions (D14):
  - the full form in `wait` entries and pushed messages (BLOCKED, age, cwd, full question, exact `reply` call, batch line when more than one question is pending);
  - the short form in `status` / `list` (question cut to 120 characters plus `AgentControl(reply id q)`).

  Verify: snapshot tests.

## 8. `steer`

- [x] 8.1 Failing tests covering the D6 routing table, for a single `id` and for `ids[]` broadcast (per-id results; one bad id does not fail the others):
  - running + steer / followUp → `session.steer` / `followUp`, `queued`;
  - idle → new run, `started`, or `queued` when the lane is full; `run` increments; a new outcome is posted;
  - queued child → `not_started`;
  - foreground child → `foreground`;
  - disposed child → `not_alive`;
  - unknown id → `not_found`.

  Then implement it. The tool description says only background children can be steered and points questions to `reply`. Verify: tests green.
- [x] 8.2 The per-run `timeout_s` / `backgroundTimeoutSec` applies to every run, not just the first. Verify: fake-timer test on run 2.

## 9. Persistence and events

- [x] 9.1 Each finished background run → `pi.appendEntry("subagents:run", { id, run, cwd, ...boundedDetails })`. After a simulated reload, `steer` / `reply` on a persisted id return `not_alive`. Verify: tests with a fake `pi.appendEntry` and registry reset.
- [x] 9.2 Emit every orchestration event (D11), one per affected id (batch and broadcast fan out), with ids, kinds and results only and no text: `question`, `answer` (`reply` / `cancel`), `slot`, `steer`, `idle`, `disposed` (reason), `mail`, `mail_dropped`, `wait` (start / end), `push`. Export all payload types from `index.ts`. Verify: `plugin-hooks.test.ts` and `events.test.ts` assert order, payloads and the absence of text.
- [x] 9.3 The `AgentControl` description marks `messages` as debug-only and points orchestration to `wait` / `status` / `steer`. Verify: description test.
- [x] 9.4 Gate: `npm run lint && npm run typecheck && npm test` all green. Run the `review-code` pass over the diff.

## 10. Docs (last)

- [x] 10.1 Update `README.md` with the final spec at the end of implementation:
  - "Background subagents" section: the orchestration model (bus up, answer/steer down), `ask_parent`, `wait`, `reply`, `steer`, the idle lifecycle and eviction, `notifyParent`, persistence (children in memory, parent JSONL is the record, not steerable after reload).
  - New "Working directory (`cwd`)" section: what follows the child cwd, `cwdScope`, validation errors, trust behaviour, worktree usage (one worktree per parallel editor, the parent prepares it), what stays the parent's (`process.cwd()`, env).
  - "Scope" section: remove "no steer" and "never pushed to parent"; list what remains out of scope (worktree create/remove, child↔child messaging, surviving reload).
  - Settings table: `notifyParent`, `backgroundIdleTtlSec`, `maxIdleBackground`, `cwdScope`. Parent waits default to 300 s; `ask_parent` has no timeout; a manual kill (`cancel`, `subagents:stop`) clears waiting children.
  - Parallel questions: batch `reply`, broadcast `steer`, slot release while asking, the reply-instruction formats.
  - Events: the full D11 table and the `cwd` field.
  - The content must match the final specs (`subagent-orchestration`, `subagent-cwd` and the modified capabilities).

  Verify: every new tool, setting and event in the specs appears in the README; README renders and links resolve.
- [x] 10.2 Update `extensions/AGENTS.md` rows for every touched or new file. Add `CHANGELOG.md` entries, including the BREAKING never-push reversal and the `notifyParent: false` migration. Verify: rows present, with `See change: add-subagent-orchestration`.
