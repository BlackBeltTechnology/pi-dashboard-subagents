# Proposal

## Why

Every `Agent` call blocks the parent until the subagent finishes. The parent cannot fan out long-running work and keep going, check on it later, read its messages, or stop it. The README lists background spawning as out of scope; users now need it. Other packages also have no supported way to observe, gate or query subagents beyond the dashboard's `subagents:*` stream.

## What Changes

- New setting `allowBackground` (default **true**), read once at activation. When off, the `Agent` schema has no `run_in_background` parameter and no background tools are registered. The feature is invisible to the LLM.
- `Agent` gains optional `run_in_background: boolean`. When true, the call registers the subagent and returns at once with a short id, its queue position and outstanding counts. The run continues unawaited; `subagents:*` events and the dashboard card keep streaming as for a foreground run.
- New tools (registered only when `allowBackground` is on):
  - `AgentStatus({ ids, wait?: "none"|"any"|"all", timeout_s? })`: status plus stored result; can block until any or all finish.
  - `AgentMessages({ id, from?, limit?, kinds? })`: paged, bounded read of a subagent's timeline, live or finished.
  - `AgentList()`: every background subagent of this session with status, age and tokens.
  - `AgentCancel({ ids: string[] | "all", status? })`: aborts queued or running background subagents; per-id outcome.
- **No delivery into the parent.** A finished result is stored and read only on request. No `sendMessage`, `followUp` or `steer`.
- Several background subagents may run at once, bounded by the existing `maxConcurrent` semaphore. Queue safeguards:
  - `maxBackgroundPending` (default 8, `0` = unlimited) caps outstanding (queued + running) background subagents; spawns beyond it are rejected with the outstanding ids.
  - Foreground waiters are dispatched before background waiters.
  - Optional per-agent run-time limit `backgroundTimeoutSec` (default `0` = off), overridable per call with `timeout_s`.
- Background subagents are aborted on `session_shutdown`. Finished results and timelines stay readable for the rest of the session (in memory).
- Plugin hooks on `pi.events`:
  - **Observe**: existing `subagents:*` events gain `details.background`; new `subagents:cancelled` and `subagents:result_read`.
  - **Intercept** (synchronous, `model:resolve`-style): `subagents:before_spawn` (veto or patch any spawn, foreground or background) and `subagents:before_store` (patch a result before it is stored or returned).
  - **Query**: `subagents:list`, `subagents:get`, `subagents:cancel`, answered by the same handlers as the tools.
  - Typed helpers exported from `index.ts`.
- **BREAKING (behavioral):** activation registers more than one tool by default, and the queue is no longer strictly FIFO across foreground and background calls (it stays FIFO within each class). Setting `allowBackground: false` restores the previous tool surface.

## Capabilities

### New Capabilities
- `background-subagents`: background spawning, the per-session registry, the `AgentStatus`/`AgentMessages`/`AgentList`/`AgentCancel` tools, the pending cap, the run-time limit, retention and shutdown behavior.
- `subagent-plugin-hooks`: event-bus contract that lets other packages observe, intercept and query subagents.

### Modified Capabilities
- `subagent-emission`: activation registers the background tools when enabled; child sessions exclude every subagent-management tool, not only `Agent`.
- `subagent-spawn-cost`: semaphore dispatch order becomes foreground-first, FIFO within each class.

## Impact

- **Code:**
  - `extensions/agent.ts`: schema, `run_in_background` path, registry, new tools, dispatch order, timeout, shutdown handler.
  - `extensions/settings.ts`: `allowBackground`, `maxBackgroundPending`, `backgroundTimeoutSec`.
  - `extensions/events.ts`: `background` flag, new channels.
  - `extensions/index.ts`: hook helpers and types.
  - Possibly a new `extensions/background.ts` for the registry.
- **Docs:**
  - README "Scope" section (removes "No background spawning").
  - `extensions/AGENTS.md`.
- **Dashboard (`pi-agent-dashboard`, follow-up):**
  - The background `Agent` result omits `details.agentId`, so the card is not finalized early.
  - Optional: add `subagents:cancelled` to the bridge forward map and show a "background" badge.
- **Dependencies:** none new.

## Discipline Skills

`doubt-driven-review` (new public tool and hook API surface), `security-hardening` (other plugins can veto or rewrite spawns and results), `systematic-debugging` (if lifecycle races surface).
