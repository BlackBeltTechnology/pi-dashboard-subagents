# Tasks

## 1. Settings clamp

- [x] 1.1 Failing test in `__tests__/settings.test.ts`: `maxConcurrent: 10000` → 64; existing coercion cases unchanged. Then clamp in `coerceMaxConcurrent`. Verify: `npm test -- settings` green.

## 2. Per-agent controller, registry, first-reason-wins

- [x] 2.1 Failing spawn-path tests: a parent abort still yields `aborted` for running and queued calls; an already-aborted parent at call start yields `aborted` without a session; the parent listener is removed after the run (no leak across 50 runs).
- [x] 2.2 Implement in `runAgentTool`:
  - per-agent `AbortController` linked to the parent signal (`{ once: true }`, removed in `finally`), used for `acquireSpawnSlot`, the checkpoints and the `session.abort()` wiring
  - an `endReason` latch
  - the per-activation registry (created in `activate()`, entry removed in `finally`)

  Verify: 2.1 plus existing abort, semaphore and activation-isolation tests green.

## 3. `subagents:stop` and `stopWith`

- [x] 3.1 Failing tests:
  - queued stop: removed, positions renumber, no `createAgentSession`, no slot used
  - running stop: only that child aborts, the next waiter starts
  - stop after slot grant but before child start: no prompt, slot released
  - stop then parent abort: the stopped one stays `stopped` with one terminal event, the others end `aborted`
  - unknown or finished id: no change, logged
  - another activation's id: ignored
  - stopped outcome: `subagents:completed` with `status: "stopped"` and `stopReason`; result has no `isError`; running stop includes partial text
- [x] 3.2 Implement:
  - waiter records with `remove()` and a `SpawnStoppedError`
  - the `subagents:stop` listener in `activate()` with logging
  - `stopWith(phase)`
  - `stoppable: true` and `stopReason` on `AgentDetails` (`events.ts`)

  Verify: 3.1 green.

## 4. Queue info and batched push

- [x] 4.1 Failing tests:
  - queued snapshot has `queuePosition`, `activeSlots`, `maxConcurrent`
  - running snapshot has `slotGrantedAt` and no `queuePosition`
  - `startedAt` unchanged
  - re-push after a slot grant and after a middle removal
  - a grant and a removal in one task send exactly one frame per waiter via `onUpdate`
- [x] 4.2 Implement the optional `AgentDetails` fields, the per-waiter `onPosition` callback and the `queueMicrotask` flush through the existing `pushUpdate` path. Verify: 4.1 plus `events.test.ts` green.

## 5. Live limit and fairness

- [x] 5.1 Failing tests (fake timers):
  - raising 4 → 6 with 3 waiting starts 2 within 2 s, in order
  - a new call after the raise waits behind earlier ones
  - lowering aborts nobody
  - the interval is cleared when the queue empties (no pending timers)
- [x] 5.2 Implement fair granting in `acquireSpawnSlot` (immediate only when the queue is empty) and an `unref()`'d 1 s `dispatchSpawnWaiters` interval that lives only while waiters exist and triggers a position push. Verify: 5.1 plus the existing semaphore suite green.

## 6. Docs, integration, release

- [x] 6.1 Faux end-to-end in `entry-stream-faux.test.ts`: `maxConcurrent: 1`, 3 parallel calls; stop the running one mid-stream and one queued one. Expect 1 completed and 2 `stopped`, consistent `subagents:*` streams, and a non-error parent result.
- [x] 6.2 Update `extensions/AGENTS.md` rows (`agent.ts`, `events.ts`, `settings.ts`, tests) with `See change: manage-subagent-spawn-queue`. In the README, document the `subagents:stop` contract, the new `AgentDetails` fields and the live limit.
- [x] 6.3 CHANGELOG entry (minor): per-subagent stop, queue info fields, live limit, clamp to 64. Bump the minor version in `package.json`.
- [x] 6.4 Full gate: `npm run lint && npm run typecheck && npm test` green.

## Workflow follow-up

- Dashboard: the separate change that adds the plugin route sending `subagents:stop` and the stop button on the card.
- Rebase `add-background-subagents` on this change: `AgentCancel` should reuse `subagents:stop`, the per-agent controller and the `stopped` outcome.
- Archive after release.
