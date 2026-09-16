# Reduce parent event-loop stall during Agent fan-out

## Why

A parent session that fans out 7 parallel `Agent` calls (dashboard session
`01a0a23d-…`, `zeta-pi-only-agent-docs`, cwd `judo-ng`) froze its own event loop
(`eventLoopMaxMs=120326`, `tickDrift=240s`), was force-closed by the bridge
watchdog twice (`silent=148s` / `125s`), and ended with 14 `Agent` tool calls
and zero tool results. The 14 subagent cards stayed `running` forever.

Subagents run **in the parent process** (`createAgentSession`, one V8 heap, one
event loop). Three compounding costs, measured with `/tmp/spawn-spike.mjs`
against pi 0.85.1 in `judo-ng` (27 extensions in `~/.pi/agent/settings.json`):

| Cost | Where | Measured |
|---|---|---|
| Per-spawn resource reload — `createAgentSession` is called without `resourceLoader`, so the SDK builds a fresh `DefaultResourceLoader` and `reload()`s every extension/skill/theme/package for each child | `extensions/agent.ts` ~L1082 | **0.75–0.9 s solid block per child** with a warm jiti cache (production case); 11 s cold. 7 children ≈ 6 s. RSS 630 MB vs 300 MB. |
| Unthrottled `onUpdate` — `pushUpdate("running")` fires on **every** child session event (text/thinking deltas included) and calls `onUpdate({details})` synchronously; `details` carries the full `entries` slice, which the bridge then serializes and forwards. Only the `emitSubagentProgress` leg is throttled (`PROGRESS_THROTTLE_MS`). | `extensions/agent.ts` L984–995 | Bridge metrics for the stalled session: `tickForwarded: 7949`, `tickCoalesced: 0`; >100k transcript frames dropped at the browser hop. |
| Unbounded parallelism — N parallel `Agent` calls in one assistant message all spawn and run at once | `runAgentTool` | 7 concurrent children × 27 extensions' hooks per turn. With extensions loaded, 7 trivial one-tool child turns added ~6 s of extra synchronous work vs ~0 without. |

Second spike (`/tmp/perchild-cost-spike.mjs`, `/tmp/factory-cost-spike.mjs`):
of the per-child cost, discovery/skills/themes are ~150 ms; **~450 ms is one
extension factory** — `flows-anthropic-bridge-plugin` shells out to
`npm root -g` (`spawnSync`, twice) on every activation via
`@blackbelt-technology/pi-dashboard-shared` `resolvePiPackageEntry`. With that
memoized (dashboard change `heal-orphaned-tool-cards-on-session-end`), 7
isolated per-child loaders cost **0.22 s wall / 0.13 s block** total, all 28
tools intact.

A shared loader was spiked and **rejected** (`/tmp/shared-loader-spike.mjs`):
`DefaultResourceLoader.getExtensions()` returns one `extensionsResult` whose
`runtime` every child's `ExtensionRunner.bindCore` overwrites, so extension
`pi.setSessionName/appendEntry` land on the last-bound sibling, and the first
child's `dispose()` marks the shared runtime stale — observed: bridge
`registerAskUserTool` throws, `MCP initialization failed` in the survivors.

## What Changes

- **Lean per-child resource loader.** `runAgentTool` builds a fresh
  `DefaultResourceLoader({ cwd, agentDir, noSkills, noPromptTemplates, noThemes })`
  per spawn and passes it as `resourceLoader` — full extension isolation (own
  `Extension[]` + `runtime` per child), same tool surface as today, −350 MB RSS
  at n=7. Skills/prompt templates/themes are not consumed by headless children.
  The spawn-time win itself comes from the companion dashboard change
  (memoized `npm root -g`); this change only stops paying for unused resources.
- **Throttle the `onUpdate` leg.** `pushUpdate` routes `onUpdate` through the
  same coalescing window as `emitSubagentProgress` (`createProgressEmitter`
  gains a second sink, or a sibling emitter). Terminal states (`completed`,
  `error`, `aborted`) still flush synchronously — unchanged.
- **Concurrency cap on parallel spawns.** A module-level semaphore limits
  simultaneously *running* children (default `4`, configurable via
  `subagents.maxConcurrent` in settings; `0` = unlimited). Excess calls wait in
  `queued` status (already an `AgentStatus`; the card shows it) and start FIFO.
  Parent abort drains the queue.

Non-goals: moving children out of process (worker/child_process) — larger
change, separate proposal; changing the child tool surface (user chose to keep
all tools); dashboard-side healing of orphaned `running` cards — companion
change in `pi-agent-dashboard`.

## Capabilities

### New Capabilities
- `subagent-spawn-cost`: isolated lean resource loader per child session;
  bounded parallel spawn via `subagents.maxConcurrent`.

### Modified Capabilities
- `subagent-emission`: the `onUpdate` (`tool_execution_update`) leg of progress
  reporting is coalesced within the same throttle window as
  `subagent_progress`; terminal snapshots always flush.

## Impact

- `extensions/agent.ts` — lean child loader, semaphore, `pushUpdate` throttle.
- `extensions/settings.ts` (or wherever settings are read) — `maxConcurrent`.
- `extensions/__tests__/agent.test.ts` — mocks gain `DefaultResourceLoader`; new
  tests for per-spawn loader options, throttle, semaphore ordering + abort drain.
- `README.md` — document `subagents.maxConcurrent` + `queued` semantics.
- Companion: `pi-agent-dashboard` change `heal-orphaned-tool-cards-on-session-end`
  — memoizes `npm root -g` in `pi-package-resolver` (the actual spawn-cost
  root cause), flips `subagentTickThrottleMs` default on, heals `running`
  subagent cards when the parent goes `ended`.

## Discipline Skills

- `performance-optimization` — measure-first: the spike numbers above are the
  baseline; tasks re-run the spike after each step and record the delta.
- `doubt-driven-review` — already applied to the shared-loader idea (rejected
  by spike, see design Decision 1). Remaining candidate: the `maxConcurrent`
  default of 3 changes observable scheduling; confirm before it stands.
- `review-code` — non-trivial change to the spawn path + new concurrency
  primitive.
