# Design

## Context

See proposal.md for motivation. The baseline is `extensions/agent.ts` **after** `manage-subagent-spawn-queue`:

```
activate(pi): registry = Map<agentId, AgentControl>     per activation
              pi.events.on("subagents:stop", …)          stops queued or running
runAgentTool(…, parentSignal, onUpdate, …)
  ctrl = per-agent AbortController linked to parentSignal ("parent")
  endReason latch: first of parent abort / stop wins
  emitSubagentCreated("queued", queuePosition, activeSlots, maxConcurrent, stoppable)
  acquireSpawnSlot(ctrl.signal)   FIFO, fair grant, 1 s live re-check while waiting
  … child session …
  outcome: completed | error | aborted (parent) | stopped (stopWith(phase))
```

Constraints:
- `pi.registerTool` has no unregister, so the tool surface is fixed at `activate()`.
- `pi` and any per-session state are per-activation.
- A listener may treat an `Agent` `tool_execution_end` carrying `details.agentId` as that run's end, so a background call's early end must not carry it.

## Goals / Non-Goals

**Goals:**
- Background runs reuse `runAgentTool` and the stop path unchanged: same events, same bounding, same slot accounting, same `stopped` outcome.
- One background registry per activation serves both the LLM tools and the plugin query events.
- Forgotten background work cannot block foreground calls or grow without bound.

**Non-Goals:**
- Persisting across `/reload`, `/resume` or restart.
- Pushing anything into the parent conversation.
- Steering a running subagent.
- Async interception hooks.
- Nested background spawning.

## Decisions

### D1. Background = the same `runAgentTool` promise, not awaited, without a parent link

`execute` with `run_in_background: true` calls `runAgentTool` with `parentSignal = undefined` (so the per-agent controller is not linked to the parent turn) and `onUpdate = record.sink`. It stores the promise and returns immediately. Interrupting the parent turn therefore does not stop background work. `AgentCancel`, `subagents:stop`, the timeout and shutdown do.

*Alternative:* a separate runner. Rejected because it would duplicate abort, slot, bounding and stop logic.

### D2. Background registry layered on the agent registry

The per-activation `AgentControl` registry from `manage-subagent-spawn-queue` stays the single place stops go through. A separate per-activation `BackgroundRegistry` holds records keyed by short id (`bg-` + 6 hex characters, collision-checked) and maps the full `agentId`. Lookups accept either, and a unique prefix is allowed. Each record holds `{ agentId, promise, latest details, stored terminal result, readAt, stoppedBy? }`. Terminal records stay after the `AgentControl` entry is removed.

### D3. Tool surface fixed by `allowBackground` at activation

When it is on: the `Agent` schema adds `run_in_background` and `timeout_s`, and the four tools are registered. When it is off: the surface is identical to the pre-change state.

### D4. Stored results

On a terminal state the record stores `{ status, stopReason?, stoppedBy?, result, error, details, tokens, durationMs, finishedAt }`. Before storing, `subagents:before_store` may patch `result`. Entries are cut with `cutEntry(entryFieldMaxChars)`. Nothing is sent to the parent.

### D5. `AgentStatus` wait semantics

- `none` returns snapshots; `any` and `all` wait as named.
- `timeout_s` caps the wait and cancels nothing.
- The tool's own signal ends only the wait.
- While waiting, `onUpdate` forwards snapshots.
- Output is bounded by `resultMaxChars` in total.

### D6. `AgentMessages` paging

Reads the record's live entries. Default is the last 20; returns `{ total, from, next_from, entries }`. The `kinds` filter is applied before paging. Output is bounded per field and in total.

`kinds` accepts any `SubagentTimelineEntry` kind, including `retry` from `surface-subagent-retries` (pi auto-retry attempts). The filter matches strings, so new kinds need no change here.

### D7. Cancellation = the existing stop path

`AgentCancel` resolves ids to `agentId`s and calls the same `AgentControl.stop()` the `subagents:stop` listener uses, tagging `stoppedBy: "tool"`. A `subagents:stop` received from the bus tags `stoppedBy: "event"`.

Outcomes:
- queued → removed, `stopped` + `stopReason: "queued"`, no slot used.
- running → child aborted, `stopped` + `stopReason: "running"`.

Per-id result is `stopped`, `already_finished` or `not_found`. `ids: "all"` with an optional `status` filter supports bulk cleanup. The call does not wait for the stop to finish. Partial timelines stay readable.

*Alternative:* a separate `aborted` path with a `subagents:cancelled` event. Rejected: it would give listeners two terminal shapes for the same intent.

### D8. Queue safeguards

- **Pending cap:** counts background records that are queued or running. At or over `maxBackgroundPending` (≠ 0), the spawn returns an error listing the outstanding ids. No record and no events are created.
- **Foreground-first lanes:** the waiter list from `manage-subagent-spawn-queue` gains a `lane`. Dispatch drains the foreground lane first, FIFO within each lane.
  - "Immediate grant only when nobody waits" applies across both lanes.
  - `queuePosition` numbers waiters in dispatch order (all foreground waiters, then background), so a foreground arrival renumbers background waiters through the existing batched push.
- **Run-time limit:** once the slot is granted, a timer calls `stop()` with `stoppedBy: "timeout"`. It is cleared on any terminal state.
- **Visibility:** the spawn result and `AgentList` include queue position plus running, queued and finished-unread counts.

### D9. Shutdown

The `session_shutdown` handler stops every non-terminal background record through `stop()` with `stoppedBy: "shutdown"`. It is idempotent.

### D10. Plugin hooks on `pi.events`

| Kind | Channel | Payload / contract |
|---|---|---|
| observe | existing `subagents:*` | `details.background`; stopped results also carry `details.stoppedBy` |
| observe | `subagents:result_read` | `{ id, agentId, via: "status"\|"messages" }` |
| intercept | `subagents:before_spawn` | mutable `{ args, background, veto?, reason?, patch? }` |
| intercept | `subagents:before_store` | mutable `{ id?, agentId, background, status, result, patch? }` |
| query | `subagents:list` | mutable `{ filter?, out? }` |
| query | `subagents:get` | mutable `{ id, from?, limit?, kinds?, out? }` |
| control | `subagents:stop` (existing) | unchanged; tags `stoppedBy: "event"` |

- Intercept handlers are synchronous with early-return; throwing handlers are caught and ignored.
- Query handlers answer only if `out` is unset, and only from their own activation.
- Helpers exported from `index.ts`: `onSubagentEvent`, `listBackgroundAgents`, `getBackgroundAgent`, `stopSubagent`.

### D11. The early tool result does not end the run

The background `Agent` tool result omits `agentId` and carries `{ background: true, id, status }`, so it cannot be mistaken for the run's end. The run's lifecycle is published on `subagents:*`, and `subagents:stop` stops it.

### D12. Children never manage background work

The child tool filter strips `Agent`, `AgentStatus`, `AgentMessages`, `AgentList` and `AgentCancel`.

## Risks / Trade-offs

- [The background `Agent` tool result does not carry `agentId`] → Listeners follow the run on `subagents:*`; `subagents:created` carries `details.background: true`.
- [Foreground-first renumbers background waiters] → Batched one frame per waiter (existing push).
- [Session-long retention grows memory] → Entries are cut on store, and the pending cap bounds new work.
- [Sync-only intercept hooks] → Documented; async can come later.
- [Results lost on `/reload`] → Documented. `AgentStatus` reports `not_found` with a hint.

## Migration Plan

Defaults turn the feature on. `"allowBackground": false` plus `/reload` restores the previous surface. Rollback means reverting the release.
