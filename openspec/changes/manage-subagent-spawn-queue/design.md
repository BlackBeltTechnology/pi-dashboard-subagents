# Design

## Context

See proposal.md for motivation. Today (`extensions/agent.ts`):

```
runAgentTool(…, signal /* parent tool signal */, onUpdate, …)
  startedAt = now; emitSubagentCreated("queued")
  releaseSlot = await acquireSpawnSlot(signal)   module FIFO: spawnWaiters[{ start, onAbort }]
  … createChildLoader / createAgentSession; signal → session.abort()
  outcome → failWith("aborted") if signal.aborted, else completed/error
  finally: releaseSlot?.(), session.dispose()
```

- `AgentStatus` already includes `"stopped"`, though nothing produces it yet.
- `getMaxConcurrent()` is read only on acquire and release.
- `pi` and any per-session state must be per-activation (spec `activation-handle-isolation`). The semaphore is process-wide on purpose.

## Goals / Non-Goals

**Goals:** the dashboard contract (stop, queue info, live limit) with no change to today's results when nobody sends a stop.

**Non-Goals:** see proposal.md, Non-Goals.

## Decisions

### D1. Per-agent controller linked to the parent

`runAgentTool` creates `const ctrl = new AbortController()`.
- If `signal?.aborted`, it calls `ctrl.abort("parent")` at once.
- Otherwise it adds `signal.addEventListener("abort", onParent, { once: true })` and removes it in `finally`.
- `ctrl.signal` replaces `signal` for `acquireSpawnSlot`, the `throwIfAborted` checkpoints and the `session.abort()` wiring.

The *reason* is recorded separately (D3), not inferred from `signal.aborted`.

### D2. Registry and listener, scoped to the activation

`activate()` creates `const registry = new Map<agentId, AgentControl>()` and passes it into `runAgentTool`, where `AgentControl` is `{ phase: "queued"|"running"|"terminal", stop(): StopOutcome }`. The entry is added before `emitSubagentCreated` and deleted in `finally`.

`activate()` registers `pi.events.on("subagents:stop", ({ agentId }) => …)`, which looks up only its own registry, so a stop on one session's bus cannot reach another session's subagents.
- Unknown or terminal id → log `{agentId, outcome:"ignored"}` and do nothing.
- Every request logs `{agentId, phase, outcome}` with `console.warn` and the `[pi-dashboard-subagents]` prefix.

*Alternative:* a module-level registry. Rejected because it allows cross-session control and conflicts with activation isolation.

### D3. First reason wins

Each run has `let endReason: "parent" | { stop: "queued"|"running" } | undefined`. Whichever of the parent listener or `stop()` comes first sets it, then aborts `ctrl`. The second one sees `endReason` set and does nothing.

At the outcome site:
- `endReason === "parent"` → `failWith("aborted", …)`, unchanged.
- `endReason?.stop` → `stopWith(phase)`.

### D4. Stopping a queued call

Waiters become records `{ agentId, start, remove(), onPosition }`. `stop()` in phase `queued` calls `remove()`, which splices the record out, detaches listeners and rejects with `SpawnStoppedError`. No slot is used and no child session is created. Removal triggers the position push (D7).

### D5. Stopping a running call

`stop()` in phase `running` aborts `ctrl`, which calls `session.abort()` on the existing wiring. `prompt()` returns, the outcome site sees `endReason.stop`, and `finally` releases the slot so `dispatchSpawnWaiters()` starts the next waiter.

Slot release is guaranteed by `finally` whenever a slot was acquired. This covers a stop that lands after the slot is granted but before `throwIfAborted`: the checkpoint throws `SpawnStoppedError` and the slot is still released.

### D6. `stopWith(phase)`

- Builds the `"stopped"` snapshot with `stopReason: phase` and emits **`subagents:completed`**. The `result` is the message below; `tokens` and `toolUses` are whatever ran.
- Sends the terminal `onUpdate`.
- Returns a bounded result with **no `isError`**:
  - queued → `"Subagent removed from queue before starting."`
  - running → `"Subagent stopped by user."` plus the last assistant text, if any.

The parent turn therefore continues normally. `before_store`-style hooks are not part of this change.

### D7. Queue info and batched push

`AgentDetails` gains optional fields:
- `queuePosition` (1-based, no gaps), `activeSlots`, `maxConcurrent`: set only while `queued`.
- `slotGrantedAt`: set when the slot is granted.
- `stoppable: true`: set on every snapshot.
- `stopReason`: set on stopped results.

`startedAt` stays the creation time, so `durationMs` keeps its meaning.

Any change to the queue (push, grant, remove, limit change) sets a module flag and schedules one `queueMicrotask(flushPositions)`. `flushPositions` walks the remaining waiters and calls each `onPosition(i+1, activeSpawns, limit)`. That updates the snapshot and pushes it through the run's existing `pushUpdate("queued")` path, which feeds `onUpdate` and the progress bus emitter. The result is one frame per waiter per task.

### D8. Fair granting and live re-check

- `acquireSpawnSlot` grants immediately only if `spawnWaiters.length === 0` and a slot is free. Otherwise it enqueues.
- While `spawnWaiters.length > 0`, a `setInterval(dispatchSpawnWaiters, 1000).unref()` runs. It starts on the first push and is cleared when the queue empties (checked in dispatch and remove).
- `dispatchSpawnWaiters` reads `getMaxConcurrent()`, which already refreshes on config mtime. A raised limit therefore starts waiters within about 2 s, and a limit change triggers a position push.
- Lowering only affects future grants.

### D9. Clamp

`coerceMaxConcurrent` clamps finite values to `[0, 64]`, after the existing rejection of negatives and non-numbers.

## Risks / Trade-offs

- [An abort landing between stop and parent abort could double-emit] → A single `endReason` and the existing single terminal path. A test covers stop followed by parent abort.
- [The 1 s interval keeps work alive] → `unref()`, and it exists only while something is queued.
- [Fair granting changes timing for a call arriving right after a release] → It only waits when others are already waiting, which the spec already required ("start in the order they were invoked").
- [`subagents:completed` with `status: "stopped"` reaching an older dashboard] → It is treated as completed with a result message. The dashboard contract asks for exactly this.

## Migration Plan

Additive, minor version bump. No config migration. Values of `maxConcurrent` above 64 are clamped (CHANGELOG note).
