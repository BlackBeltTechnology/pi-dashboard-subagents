# Proposal

## Why

Every subagent runs on the parent tool call's abort signal, and the extension listens for no control events. The only way to stop a subagent is to abort the whole parent turn, which ends every subagent: queued ones, running ones, and the parent's own work. A forgotten 20-deep fan-out can't be trimmed. The dashboard (change `subagent-queue-visibility`) wants a stop button per card, but this package offers no event to trigger it.

Queue state is also invisible at the source. The dashboard works out queue positions and slot use itself, and a raised `maxConcurrent` doesn't start calls that are already waiting until some other slot frees.

This change adds an event-driven control and reporting surface to the existing foreground spawn queue. Background subagents are out of scope (`add-background-subagents` builds on this).

## What Changes

- **`subagents:stop { agentId }` control event.** Stops one subagent, queued or running, without touching the parent turn or other subagents.
  - Queued: the call leaves the queue without taking a slot or creating a child session.
  - Running: only that child session is aborted and its slot is released, so the next waiter starts.
  - The result is `status: "stopped"` with `stopReason: "queued" | "running"`, emitted on **`subagents:completed`**. The tool result is **not** an error, so the parent turn continues. A running stop includes any partial output.
  - Unknown or finished ids do nothing (logged). Every stop request is logged.
  - A stop and a parent abort are reconciled: the first one wins, so a parent abort still yields today's `aborted`.
  - A stop is honored only by the session that owns the subagent.
- **Each subagent gets its own abort controller**, linked to the parent signal. It drives both slot acquisition and the child session.
- **Capability flag:** every `AgentDetails` snapshot carries `stoppable: true`.
- **Queue info on `AgentDetails`:**
  - `queuePosition`, `activeSlots` and `maxConcurrent` while queued.
  - `slotGrantedAt` once running.
  - `startedAt` stays the call-creation time.
  - After any queue change, each remaining waiter gets a fresh queued snapshot. Changes within one task are batched to one frame per waiter.
- **Live limit:**
  - Waiting calls are re-checked every second while anything is queued, so a raised `maxConcurrent` starts them within about 2 s.
  - A new call is granted a slot immediately only when nobody is waiting, so it can't jump ahead of earlier waiters.
  - `maxConcurrent` is clamped to 0–64.
  - Lowering the limit never stops running subagents.
- **Release:** minor version bump with a CHANGELOG entry. All new fields and events are additive. The dashboard detects them and falls back when they are missing.

## Capabilities

### New Capabilities
- `subagent-spawn-queue`: per-subagent stop via `subagents:stop`, the stopped outcome, queue info on snapshots and its batched re-push, and the stoppable flag.

### Modified Capabilities
- `subagent-spawn-cost`: the `maxConcurrent` requirement gains clamping, fair granting and live re-check of waiting calls.

## Non-Goals

These are deferred because nothing consumes them yet:
- A queue depth cap (`maxQueued`).
- A wait timeout.
- A `/subagents` slash command.
- Bulk-stop or queue-query events.
- An LLM-facing stop tool.

## Impact

- **Code:**
  - `extensions/agent.ts`:
    - per-agent controller and registry
    - `subagents:stop` listener
    - `stopWith`
    - semaphore: waiter records, remove, fairness, re-check interval, position push
  - `extensions/events.ts`: new optional `AgentDetails` fields.
  - `extensions/settings.ts`: 0–64 clamp.
- **Tests:** stop, queue positions and live-limit suites in `__tests__/agent.test.ts`, plus a settings clamp test.
- **Docs:** `extensions/AGENTS.md`, README (event contract), CHANGELOG.
- **Dashboard:** works with or without this release. Its own follow-up adds the route that sends `subagents:stop`.

## Discipline Skills

`doubt-driven-review` (shared process-wide semaphore and abort races), `security-hardening` (incoming control event must stay scoped to its session), `observability-instrumentation` (stop logging), `systematic-debugging` (if abort/release races surface).
