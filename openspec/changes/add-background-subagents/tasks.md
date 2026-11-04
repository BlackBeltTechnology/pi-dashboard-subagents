# Tasks

## 1. Settings

- [ ] 1.1 Write failing tests in `__tests__/settings.test.ts` for `allowBackground` (default true), `maxBackgroundPending` (default 8, coercion, `0`), `backgroundTimeoutSec` (default 0, coercion), and mtime refresh of the two numeric keys; then add the keys, merge/save logic and getters in `settings.ts`. Verify: `npm test -- settings` green.
- [ ] 1.2 Export the new getters and types from `index.ts`, and update the `settings.ts` row in `extensions/AGENTS.md`. Verify: `npm run typecheck`.

## 2. Two-lane semaphore (foreground-first)

- [ ] 2.1 Add a failing spawn-path test: `maxConcurrent: 1`, 3 background waiters queued, then a foreground call. The foreground call starts next and background order is preserved. Existing FIFO, cap-0 and abort-while-queued tests stay green.
- [ ] 2.2 Split `spawnWaiters` into foreground and background lanes, add a `lane` argument to `acquireSpawnSlot`, and make `dispatchSpawnWaiters` drain foreground first. Verify: 2.1 plus the existing semaphore suite green.

## 3. Background registry and `Agent(run_in_background)`

- [ ] 3.1 Failing tests for the registry (new `extensions/background.ts`):
  - short `bg-` id generation with collision check
  - lookup by short id, full `agentId` and unique prefix
  - status transitions queued→running→terminal from the `onUpdate` sink
  - stored result with entries cut to `entryFieldMaxChars`
  - `readAt` tracking
  - counts helper (running, queued, finished-unread)
  - per-activation isolation (two `activate()` calls get separate registries)
- [ ] 3.2 Implement `createBackgroundRegistry(pi)` created inside `activate()` closure (no module-level registry). Verify: 3.1 green, activation-handle-isolation tests green.
- [ ] 3.3 Failing tests for the schema:
  - `allowBackground: true` adds `run_in_background` and `timeout_s`
  - `false` leaves the schema identical to today and registers only `Agent`
- [ ] 3.4 Implement the background branch of `execute`. It:
  - checks the pending cap
  - creates the record with its own `AbortController` and calls `runAgentTool(..., controller.signal, record.sink, ...)` unawaited
  - returns id, position and counts with `details: { background: true, id, status }` and no `agentId`
  - sets `details.background` on every emitted `AgentDetails`

  Tests: immediate return, events still emitted, parent signal abort leaves the run alive, `details` has no `agentId`, pending cap rejection creates no events.
- [ ] 3.5 Strip `AgentStatus`, `AgentMessages`, `AgentList` and `AgentCancel` from child tool sets alongside `Agent`. Test: child active tools exclude all five.
- [ ] 3.6 Update the `agent.ts` row and add a `background.ts` row in `extensions/AGENTS.md`.

## 4. Read tools: `AgentStatus`, `AgentMessages`, `AgentList`

- [ ] 4.1 Failing tests for `AgentStatus`:
  - snapshot
  - `wait: "all"`, `wait: "any"`
  - `timeout_s` returns without cancelling
  - its own signal abort ends only the wait
  - unknown id → `not_found`
  - combined output bounded by `resultMaxChars`
  - `onUpdate` forwards snapshots while waiting
- [ ] 4.2 Implement `AgentStatus`. Verify: 4.1 green.
- [ ] 4.3 Failing tests for `AgentMessages`:
  - default last 20
  - `from` and `next_from` incremental read on a running subagent
  - `kinds` filter before paging
  - per-field and total bounding
  - queued subagent returns empty with `total: 0`

  Then implement it. Verify: green.
- [ ] 4.4 Failing test for `AgentList` (mixed states, counts line, unread flag), then implement it. Verify: green.
- [ ] 4.5 Extend `entry-stream-faux.test.ts` with a real-session background run: the spawn returns early, `AgentStatus wait:"all"` yields the same final text a foreground run would, and the `subagents:entry` stream is identical to foreground.

## 5. Cancellation, timeout, shutdown

- [ ] 5.1 Failing tests for `AgentCancel`:
  - running → `cancelled`, then `aborted` + `subagents:failed`, entries still readable
  - queued → never takes a slot
  - `ids: "all", status: "queued"` bulk
  - finished → `already_finished`
  - unknown → `not_found`
  - emits `subagents:cancelled { by: "tool" }`

  Then implement. Verify: green.
- [ ] 5.2 Failing tests for the run-time limit: `timeout_s` aborts with `by: "timeout"`; queue time is not counted; timer cleared on terminal; `backgroundTimeoutSec` default applies when `timeout_s` is absent. Then implement. Verify: green (fake timers).
- [ ] 5.3 Failing test for the `session_shutdown` handler: aborts queued and running with `by: "shutdown"`, idempotent on a second fire, no slot left held. Then implement. Verify: green.

## 6. Plugin hooks

- [ ] 6.1 Failing tests for `subagents:before_spawn`: veto → error result and no `subagents:created`; patch prompt/model/description applied; throwing handler ignored; applies to foreground and background. Then implement. Verify: green.
- [ ] 6.2 Failing tests for `subagents:before_store`: patch replaces the result for foreground (returned) and background (stored); throwing handler ignored. Then implement. Verify: green.
- [ ] 6.3 Failing tests for `subagents:result_read` emission (status and messages) and for the `background` flag on every lifecycle event. Then implement in `events.ts`. Verify: `events.test.ts` green.
- [ ] 6.4 Failing tests for the query channels `subagents:list`, `subagents:get` and `subagents:cancel`: same data as the tools, an existing `out` not overwritten, plugin cancel emits `by: "plugin"`. Then wire the registry handlers. Verify: green.
- [ ] 6.5 Export typed helpers and payload types from `index.ts` (`onSubagentEvent`, `listBackgroundAgents`, `getBackgroundAgent`, `cancelBackgroundAgents`). Add a helper round-trip test. Update the `events.ts` and `index.ts` rows in `extensions/AGENTS.md`.

## 7. Docs and integration

- [ ] 7.1 README:
  - replace "No background spawning" in Scope
  - document the new tools, settings (`allowBackground`, `maxBackgroundPending`, `backgroundTimeoutSec`) and the hook channel table
  - note that results are in memory only

  Verify: README renders and links resolve.
- [ ] 7.2 CHANGELOG entry noting the BREAKING behavioral items (more tools by default, foreground-first queue) and the `allowBackground: false` opt-out.
- [ ] 7.3 Full gate: `npm run lint && npm run typecheck && npm test` green.
- [ ] 7.4 Manual check in a live pi and dashboard session:
  - spawn 3 background agents and confirm cards stream live and are not finalized early
  - check `AgentList`, `AgentMessages` mid-run, `AgentStatus wait:"all"`, and `AgentCancel` on one

## Workflow follow-up

- Dashboard repo (`pi-agent-dashboard`): optionally forward `subagents:cancelled`, show a "background" badge on cards, and link the `Agent` chat row to the card via `details.id`.
- Archive this change after release.
