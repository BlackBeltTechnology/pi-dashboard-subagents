# Design

## Context

See proposal.md for motivation. Current shape (`extensions/agent.ts`):

```
execute(toolCallId, params, signal, onUpdate, ctx)
  └─ runAgentTool(cwd, args, signal, onUpdate, ctx, pi, toolCallId)   ← awaited
       acquireSpawnSlot(signal)        module-level FIFO, limit getMaxConcurrent()
       createChildLoader / createAgentSession / session.prompt()
       subagents:* events  +  throttled onUpdate  →  bounded tool result
```

Constraints:
- `pi.registerTool` has no unregister, so the tool surface is fixed at `activate()`. The precedent is `exposeInheritanceInTool`.
- `pi` must stay per-activation (lexical closure). Module-level state that touches `pi` is forbidden (spec `activation-handle-isolation`).
- `runAgentTool` already owns the whole lifecycle: abort, slot release, terminal events, bounding. Background mode should reuse it, not fork it.
- The dashboard (`toolRowFinalizer.onEnd`) marks a subagent `completed` when an `Agent` `tool_execution_end` carries `details.agentId`. A background call ends in milliseconds, so it must not carry that field.
- The bridge forwards only channels in an explicit map, so new `subagents:*` channels are local to the process unless the dashboard opts in.

## Goals / Non-Goals

**Goals:**
- Background runs reuse `runAgentTool` unchanged in behavior: same events, same bounding, same slot accounting.
- One registry per activation answers both the LLM tools and the plugin query events.
- Forgotten background work cannot block foreground calls or grow without bound.

**Non-Goals:**
- Persisting the registry across `/reload`, `/resume` or restart. Results live in memory for the session. A later change may add `pi.appendEntry`.
- Pushing anything into the parent conversation (`sendMessage`, `followUp`, `steer`).
- Steering a running subagent (sending it new instructions).
- Async interception hooks.
- Nested background spawning: children never get the management tools.

## Decisions

### D1. Background = the same `runAgentTool` promise, not awaited

`execute` with `run_in_background: true` creates a registry record holding an own `AbortController`, then calls `runAgentTool(..., controller.signal, onUpdate = record.sink, ...)`. It stores the promise and returns immediately. The record's `sink` keeps the latest `AgentDetails`, and any attached waiters forward it. Terminal results are written to the record in a `.then`.
- *Alternative:* a separate background runner. Rejected because it would duplicate abort, slot, bounding and terminal-event logic, which were just hardened.
- The parent tool-call `signal` is **not** wired. Interrupting the parent turn must not kill background work; `AgentCancel` and shutdown do.

### D2. Registry per activation, ids short

`activate(pi)` creates `createBackgroundRegistry(pi)` in its closure and passes it to every tool factory and to the query-event handlers. Records are keyed by a short id (`bg-` + 6 hex characters, collision-checked) and also map the full `agentId`. Lookups accept either. A unique-prefix match is allowed.
- *Alternative:* a module-level `Map`. Rejected for the same reason module-level `pi` is forbidden: nested re-activation clobbers it.

### D3. Tool surface fixed by `allowBackground` at activation

When it is on: the `Agent` schema adds `run_in_background` and `timeout_s`, and `AgentStatus`, `AgentMessages`, `AgentList` and `AgentCancel` are registered. When it is off: the schema and tools are exactly as today. Changing the setting needs `/reload`, as with `exposeInheritanceInTool`.

### D4. No push delivery; stored results

On a terminal state the record stores `{ status, result, error, details, tokens, durationMs, finishedAt }`. Before storing, `subagents:before_store` may patch `result`. Stored entries are cut with the existing `cutEntry(entryFieldMaxChars)` so memory per finished agent is bounded. The record keeps `readAt` so `AgentList` can show "finished, unread". Nothing is sent to the parent.

### D5. `AgentStatus` wait semantics

- `wait: "none"` (default) returns snapshots.
- `"any"` resolves on the first terminal state among `ids`.
- `"all"` resolves when every id is terminal.
- `timeout_s` caps the wait. On timeout the tool returns current snapshots and does not cancel anything.
- The tool's own `signal` cancels only the wait.
- While waiting, the tool's `onUpdate` forwards the throttled snapshot of a single waited id (or a compact multi-status line), so the pi card animates like a foreground run.
- Results are combined and bounded by `boundToolResult` against `resultMaxChars` in total.

### D6. `AgentMessages` paging

Reads `record.entries` (a live reference while running). Defaults: `limit` 20, counted from the tail when `from` is absent. Returns `{ total, from, next_from, entries }` with each field cut to `entryFieldMaxChars`, and the whole response bounded by `resultMaxChars`. An optional `kinds` filter is applied before paging.

### D7. Cancellation

`AgentCancel` calls `record.controller.abort()`. The existing paths handle the rest:
- queued → `SpawnAbortedError` → `aborted`, no slot used.
- running → `session.abort()` → `aborted`.

Per-id outcome is one of `cancelled`, `already_finished` or `not_found`. `ids: "all"` with an optional `status: "queued" | "running"` filter supports bulk cleanup. It emits `subagents:cancelled { agentId, id, by, reason }` with `by` = `tool`, `plugin`, `timeout` or `shutdown`. It does not wait for the stop.

### D8. Queue safeguards

- **Pending cap:** before registering, count records with status `queued` or `running`. If the count is ≥ `maxBackgroundPending` (and the cap is not 0), return an error result listing the outstanding ids and the remedy (`AgentStatus` / `AgentCancel`). No record and no events are created.
- **Foreground-first dispatch:** `spawnWaiters` keeps two FIFO lanes. `dispatchSpawnWaiters` drains the foreground lane first. `acquireSpawnSlot(signal, lane)`; background runs pass `"background"`. The cap is unchanged.
- **Run-time limit:** if the effective timeout (`timeout_s` ?? `backgroundTimeoutSec`) is > 0, a timer starts once the run leaves `queued` and aborts with `by: "timeout"`. The timer is cleared on any terminal state.
- **Visibility:** the spawn result and `AgentList` include queue position plus running, queued and finished-unread counts. These are tool output, not pushed messages.

### D9. Shutdown

A `session_shutdown` handler (idempotent) aborts every non-terminal record with `by: "shutdown"`. The dashboard's existing session-end heal covers any card whose terminal event is lost.

### D10. Plugin hooks on `pi.events`

| Kind | Channel | Payload / contract |
|---|---|---|
| observe | existing `subagents:*` | `details.background: boolean` added |
| observe | `subagents:cancelled` | `{ id, agentId, by, reason? }` |
| observe | `subagents:result_read` | `{ id, agentId, via: "status"\|"messages" }` |
| intercept | `subagents:before_spawn` | mutable `{ args, background, veto?, reason?, patch? }`; `veto` → `Agent` returns an error result and nothing is created; `patch` may override `prompt`, `model`, `description` |
| intercept | `subagents:before_store` | mutable `{ id, agentId, status, result, patch? }`; `patch.result` replaces the stored/returned text |
| query | `subagents:list` | mutable `{ filter?, out? }`; owner fills `out` |
| query | `subagents:get` | mutable `{ id, from?, limit?, kinds?, out? }` |
| query | `subagents:cancel` | mutable `{ ids, status?, reason?, out? }` |

- Intercept handlers are synchronous and follow the early-return idiom of `model:resolve`. A handler that throws is caught, logged once and ignored, and must never break a spawn.
- Intercept hooks run for foreground and background spawns. `before_store` runs on every terminal result before it is bounded (foreground: before it is returned; background: before it is stored).
- Query handlers answer only if `out` is unset, so a nested activation never overwrites its parent's answer.
- `index.ts` exports typed helpers: `onSubagentEvent`, `listBackgroundAgents`, `getBackgroundAgent`, `cancelBackgroundAgents`, plus payload types.
- *Alternative:* a registration API with async hooks. Deferred: it adds a second extension contract, and nothing needs async yet.

### D11. Dashboard compatibility

The background `Agent` tool result's `details` omits `agentId` and carries `{ background: true, id, status: "queued"|"running" }`, so `toolRowFinalizer.onEnd` returns early and the card is driven only by `subagents:*` (keyed by `agentId`). Showing a badge or forwarding `subagents:cancelled` is a dashboard follow-up and not required for correctness.

### D12. Children never manage background work

The child tool filter strips `Agent`, `AgentStatus`, `AgentMessages`, `AgentList` and `AgentCancel`.

## Risks / Trade-offs

- [The dashboard links the `Agent` chat row to the card via `agentId` in `tool_execution_update`/`end`; background calls send neither] → The card still renders from `subagents:*`. Row linkage is a dashboard follow-up (D11).
- [Foreground-first reorders the existing FIFO] → Only when background waiters exist. Order within a lane is unchanged. Covered by a spec scenario.
- [Finished timelines kept for the whole session grow memory] → Entries are cut to `entryFieldMaxChars` on store, and new work is capped by `maxBackgroundPending`. A retention cap can follow if needed.
- [Sync intercept hooks cannot do async policy] → Documented. Async is a later change.
- [A throwing plugin hook] → Caught per emit. The spawn proceeds as if the hook were absent.
- [Results lost on `/reload`] → Documented non-goal. `AgentStatus` on an unknown id says `not_found` and mentions that results are kept in memory only.

## Migration Plan

Defaults turn the feature on. Operators who want the old surface set `"allowBackground": false` in `~/.pi/agent/extensions/pi-dashboard-subagents/config.json` and `/reload`. Rollback means reverting the release, since no persisted data is involved.
