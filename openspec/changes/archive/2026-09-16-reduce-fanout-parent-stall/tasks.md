## 0. Baseline (performance-optimization: measure first)

- [x] 0.1 Keep `spike/spawn-spike.mjs` (copied from the investigation). Run `node spike/spawn-spike.mjs <cwd> default 7` with `PARENT=1 PI_DASHBOARD_SOCKET=`; record `maxLoopLagMs`, per-spawn ms, RSS in `design.md` as the pre-change baseline (already tabulated; re-confirm on the implementing machine). The `shared` mode stays in the spike as the rejected-variant evidence — do NOT implement it (design Decision 1).
- [x] 0.2 Extend `extensions/__tests__/agent.test.ts` SDK mock with `DefaultResourceLoader` (class with `reload: vi.fn()`), `getAgentDir`.

## 1. Isolated lean child resource loader

- [x] 1.1 Tests (red): two spawns receive *different* `resourceLoader` objects; each constructed with `{cwd, agentDir, noSkills:true, noPromptTemplates:true, noThemes:true}` and `reload()`ed once; a rejecting `reload()` surfaces as the tool's error result and retains nothing.
- [x] 1.2 Implement `createChildLoader(cwd)` (design Decision 1) and pass `resourceLoader` in `createAgentSession` (`extensions/agent.ts` ~L1082). No module-level loader cache — sharing is rejected.
- [x] 1.3 Verify: tests green; `node spike/spawn-spike.mjs <cwd> default 7` RSS ≤ 350 MB (was ~630 MB); loop lag unchanged until the dashboard `npm root -g` memo lands, then ≤ 300 ms.

## 2. Throttle the `onUpdate` leg

- [x] 2.1 Tests (red): burst of 100 session events within 250 ms → `onUpdate` ≤ 2 calls; terminal `completed`/`error`/`aborted` → last `onUpdate` carries that status, delivered before the tool result resolves; `snapshotDetails` not evaluated for coalesced events (spy on `buildDetails`).
- [x] 2.2 Refactor `createProgressEmitter` to take a sink `(details) => void` (fan-out to `emitSubagentProgress` + `onUpdate`); move `snapshotDetails` inside the throttled path; `flush()` before every terminal emission (design Decision 2). Update existing emitter tests to the new signature.
- [x] 2.3 Verify: tests green; unchanged 4/s cap on `subagents:started` (existing throttle scenario still passes).

## 3. Concurrency cap

- [x] 3.1 Settings: add `maxConcurrent: number` to `DashboardAgentSettings`, `DEFAULT_SETTINGS.maxConcurrent = 3`; `loadSettings` coerces non-number/negative to default. Tests in `settings.test.ts`.
- [x] 3.2 Tests (red): cap 2 + 5 calls → ≤ 2 `createAgentSession` in flight, FIFO start order, waiting calls emitted `subagents:created` with `status: "queued"`; cap 0 → all spawn; abort while queued → `aborted` result, no `createAgentSession`, slot not consumed; slot released on `completed`, `error`, and `aborted`.
- [x] 3.3 Implement FIFO semaphore (module scope, limit read via `loadSettings()` per acquire); acquire after `emitSubagentCreated`, before `createChildLoader`; release in the existing `finally` (design Decision 3).
- [x] 3.4 Verify: tests green.

## 4. Live verification + docs

- [x] 4.1 doubt-driven-review on the `maxConcurrent` default of 3 (observable scheduling change for users relying on N-way parallelism): confirm 3 vs 4, and that `0` is documented as the opt-out. Record outcome in `design.md` Risks. (The shared-loader question is already closed by spike — see design Decision 1.)
- [x] 4.2 Live 7-way fan-out: verified in session `01a0a68f` (`judo-ng`) — all 7 cards `completed`, parent responsive, 21.3 s wall, durations show 4 immediate + 3 queued (see design.md "Live run result"). Bridge counters not sampled directly; no `watchdog_force_close` observable (no card stalled or force-closed).
- [x] 4.3 README: document `maxConcurrent` (default 4, 0 = unlimited, `queued` card state) and that children load extensions but not skills/prompt-templates/themes.
- [x] 4.4b Cross-repo (DONE — companion merged as PR #671, memo verified active: `npm root -g` spawns once per process, not per child; spike re-run at n=1/2/4/7 shows the residual stall is extension re-instantiation, ~215 ms/child, NOT the memo — see design.md "Re-run after the companion memo landed"): verify the companion `pi-agent-dashboard` change `heal-orphaned-tool-cards-on-session-end` (memoized `npm root -g`) is installed before claiming the spawn-latency numbers; re-run 1.3 after it lands.
- [x] 4.4 CHANGELOG `[Unreleased]`: Fixed (parent stall on fan-out), Added (`maxConcurrent`).
- [x] 4.5 `extensions/AGENTS.md` rows for `agent.ts`, `settings.ts` (`See change: reduce-fanout-parent-stall`).
- [x] 4.6 review-code pass over the diff.
