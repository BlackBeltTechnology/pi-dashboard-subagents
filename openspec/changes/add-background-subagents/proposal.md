# Proposal

## Why

Every `Agent` call blocks the parent until the subagent finishes. The parent cannot fan out long-running work and keep going, check on it later, read its messages, or stop it. The README lists background spawning as out of scope; users now need it. Other packages also have no supported way to gate or query subagents beyond the dashboard's `subagents:*` stream and the `subagents:stop` control event.

**Depends on:** `manage-subagent-spawn-queue`. That change supplies the per-agent abort controller, the per-activation agent registry, the `subagents:stop` event with its `stopped` outcome, queue info fields, fair granting and the live limit re-check. This change builds on those and does not redefine them.

## What Changes

- New setting `allowBackground` (default **true**), read once at activation. When off, the `Agent` schema has no `run_in_background` parameter and no background tools are registered. The feature is invisible to the LLM.
- `Agent` gains optional `run_in_background: boolean`. When true, the call registers the subagent and returns at once with a short id, its queue position and outstanding counts. The run continues unawaited. `subagents:*` events, queue info and `subagents:stop` work exactly as for a foreground run.
- New tools (registered only when `allowBackground` is on):
  - `AgentStatus({ ids, wait?: "none"|"any"|"all", timeout_s? })`: status plus stored result; can block until any or all finish.
  - `AgentMessages({ id, from?, limit?, kinds? })`: paged, bounded read of a subagent's timeline, live or finished.
  - `AgentList()`: every background subagent of this session with status, age and tokens.
  - `AgentCancel({ ids: string[] | "all", status? })`: stops queued or running background subagents through the same path as `subagents:stop`. They end `stopped` (not an error) and report a per-id outcome.
- **No delivery into the parent.** A finished result is stored and read only on request. No `sendMessage`, `followUp` or `steer`.
- Several background subagents may run at once, bounded by the existing `maxConcurrent` semaphore. Queue safeguards:
  - `maxBackgroundPending` (default 8, `0` = unlimited) caps outstanding (queued + running) background subagents. A spawn beyond it is rejected with the outstanding ids.
  - Foreground waiters are dispatched before background waiters. Order is FIFO within each lane, and queue positions follow dispatch order.
  - Optional per-agent run-time limit `backgroundTimeoutSec` (default `0` = off), overridable per call with `timeout_s`.
- Background subagents are stopped on `session_shutdown`. Finished results and timelines stay readable for the rest of the session (in memory).
- Every stop records who caused it: `details.stoppedBy` is `"tool" | "event" | "timeout" | "shutdown"`, alongside the existing `stopReason`.
- Plugin hooks on `pi.events`:
  - **Observe**: existing `subagents:*` events gain `details.background`. New `subagents:result_read`.
  - **Intercept** (synchronous, `model:resolve`-style): `subagents:before_spawn` (veto or patch any spawn) and `subagents:before_store` (patch a terminal result).
  - **Query**: `subagents:list` and `subagents:get`.
  - **Control**: stopping stays the existing `subagents:stop`; no second cancel event.
  - Typed helpers exported from `index.ts`.
- **BREAKING (behavioral):** activation registers more than one tool by default, and the queue is no longer strictly FIFO across foreground and background calls (it stays FIFO within each class). Setting `allowBackground: false` restores the previous tool surface.

## Capabilities

### New Capabilities
- `background-subagents`: background spawning, the background registry, the `AgentStatus`/`AgentMessages`/`AgentList`/`AgentCancel` tools, the pending cap, the run-time limit, retention and shutdown behavior.
- `subagent-plugin-hooks`: event-bus contract for observing, intercepting and querying subagents.

### Modified Capabilities
- `subagent-emission`: activation registers the background tools when enabled; child sessions exclude every subagent-management tool, not only `Agent`.
- `subagent-spawn-cost`: semaphore dispatch order becomes foreground-first, FIFO within each lane.
- `subagent-spawn-queue`: stopped results carry `stoppedBy`.

## Impact

- **Code:**
  - `extensions/agent.ts`: schema, the `run_in_background` path, the new tools, lanes, the timeout, the shutdown handler.
  - `extensions/settings.ts`: `allowBackground`, `maxBackgroundPending`, `backgroundTimeoutSec`.
  - `extensions/events.ts`: `background`, `stoppedBy`, new channels.
  - `extensions/index.ts`: hook helpers and types.
  - Possibly a new `extensions/background.ts`.
- **Docs:**
  - README "Scope" section.
  - `extensions/AGENTS.md`.
- **Dashboard (`pi-agent-dashboard`, follow-up):**
  - The background `Agent` result omits `details.agentId`, so the card is not finalized early.
  - Optional "background" badge.
  - The stop button already works through `subagents:stop`.
- **Dependencies:** none new.

## Discipline Skills

`doubt-driven-review` (new public tool and hook API surface), `security-hardening` (other plugins can veto or rewrite spawns and results), `systematic-debugging` (if lifecycle races surface).
