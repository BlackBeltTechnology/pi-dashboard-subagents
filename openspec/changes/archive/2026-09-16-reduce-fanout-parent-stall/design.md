## Context

`runAgentTool` (`extensions/agent.ts`) spawns each child with
`createAgentSession({ cwd, sessionManager, modelRegistry, authStorage, model, thinkingLevel })`.
With no `resourceLoader`, `sdk.js` L75–78 does
`new DefaultResourceLoader({cwd, agentDir, settingsManager}); await reload()` —
a full extension/skill/theme/package scan per child, synchronous, in the
parent's loop. Then every child event triggers `pushUpdate("running")`, which
throttles the `subagent_progress` leg but not the `onUpdate` leg. N parallel
`Agent` calls run N children at once.

Spike (`/tmp/spawn-spike.mjs`, pi 0.85.1, cwd `judo-ng`, 27 extensions,
parent-warm jiti cache):

| Variant | Spawn block / child | n=7 concurrent max loop lag | RSS |
|---|---|---|---|
| today (fresh loader per child) | 745–895 ms | ~7 s cumulative | 630 MB |
| shared loader, reused | 8–26 ms | 12 ms | 302 MB |
| `noExtensions` loader | ~35 ms | 1.2 s | 181 MB |

Second spike (`/tmp/perchild-cost-spike.mjs`, 7 concurrent, warm parent), per
child loader strategy — all with 7 distinct `runtime` objects:

| Strategy | wall n=7 | max loop block | RSS |
|---|---|---|---|
| full `DefaultResourceLoader.reload()` | 4.56 s | 4.47 s | 660 MB |
| lean (`noSkills/noPromptTemplates/noThemes`) | 4.46 s | 4.39 s | 307 MB |
| re-run cached factories only, 27 ext | 3.37 s | 3.29 s | 306 MB |
| same, minus `flows-anthropic-bridge-plugin` | **0.22 s** | **0.13 s** | 309 MB |

`/tmp/factory-cost-spike.mjs`: 524 ms per-child factory total, 508 ms in
`flows-anthropic-bridge-plugin` (`spawnSync` `npm root -g` × 2 via
`resolvePiPackageEntry` → `rootGlobalOr`). CPU profile: `spawn` 97 %. Fixed
dashboard-side (memoized resolver root, change
`heal-orphaned-tool-cards-on-session-end`).

Shared-loader safety spike (`/tmp/shared-loader-spike.mjs`, 3 concurrent,
inline probe extension): one `extensionsResult` / one `runtime`;
`pi.setSessionName("X")` from the probe landed on child 2 (last `bindCore`);
`pi.appendEntry` wrote to child 2's session; after child 0 `dispose()` every
captured `pi.*` call throws "extension ctx is stale" — bridge
`session_start` → `registerAskUserTool` threw, pi-mcp-adapter logged
`MCP initialization failed`. Per-child loaders: all three checks correct.

Re-confirmed baseline on the implementing machine (task 0.1, pi 0.85.x,
`PARENT=1 PI_DASHBOARD_SOCKET= node spike/spawn-spike.mjs ~/Project/judo-ng default 7`):

| metric | value |
|---|---|
| `parentLoadMs` | 5755 |
| `wallMs` (7 children) | 11055 (~1.58 s/child) |
| `maxLoopLagMs` | 11 |
| `rssMB` | 315 |
| `toolsPerChild` | 28 |

Note: `maxLoopLagMs` is already low on this machine because the installed
`@blackbelt-technology/pi-dashboard-shared` routes `npm root -g` through the
`ToolRegistry` binary cache (the companion memo, task 4.4b), so the
`spawnSync` block no longer dominates. The remaining cost is wall-clock spawn
time and RSS — which the lean loader addresses.

Post-change verification (task 1.3, `perchild-cost-spike.mjs <cwd> <strategy> 7`,
same machine — this is the strategy the implementation now uses):

| strategy | wall n=7 | max loop lag | RSS | distinct `runtime` | tools/child |
|---|---|---|---|---|---|
| `full` (old behaviour) | 5.75 s | 5.66 s | 319 MB | 7 | 28 |
| `lean` (implemented) | 5.34 s | 5.25 s | **308 MB** | 7 | 28 |

RSS target (≤ 350 MB) met; tool surface and per-child runtime isolation
unchanged.

### Re-run after the companion memo landed (task 4.4b)

The companion change shipped: `pi-agent-dashboard` PR **#671**
(`heal-orphaned-tool-cards-on-session-end`, merged 2026-09-16), which adds the
process-wide `cachedNpmRoot` memo in `packages/shared/src/pi-package-resolver.ts`
(design D6). `packages/shared` exports source directly
(`"./*.js": "./src/*.ts"`), so the memo is live as soon as the checkout is on
`develop` — no build step.

**Memo confirmed active:** a `lean` n=7 run now spawns `npm root -g` exactly
**once** per process (was once per child).

**But the ≤ 300 ms loop-lag target is still NOT met**, and the memo is not the
reason. Re-measured on the same machine, `perchild-cost-spike.mjs`:

| n | `lean` max loop lag | per-child `loaderMs` |
|---|---|---|
| 1 | 178 ms | 196 |
| 2 | 418 ms | ~436 |
| 4 | 855 ms | ~873 |
| 7 | 1330 ms | ~1347 |

Cost scales linearly at **~215 ms of CPU-bound work per child**, serialized on
the event loop. That residual is extension module re-instantiation inside
`DefaultResourceLoader.reload()` — not the `npm root -g` `spawnSync`.

Attribution is proved by the `wrapper` strategy, which reuses the parent's
cached jiti factories: n=7 → **118 ms** loop lag, 137 ms/child, still 7 distinct
runtimes and 28 tools/child. So ~94 % of the remaining stall is re-parse /
re-instantiate cost that a factory cache would remove; `wrapper` reaches the
target but depends on pi's private `loadExtensionsCached`, so it is not shipped.

**Net effect of what ships here** (lean loader + `maxConcurrent: 4`): worst-case
loop lag ~855 ms at cap 4, against 1452 ms for the old uncapped `full` path at
n=7 — a **41 % reduction**, plus RSS 303 MB vs 632 MB. The ≤ 300 ms goal remains
open and needs an upstream per-child extension-factory cache; it is not
achievable from this extension alone. Stated as-measured rather than claimed.

Fix reproducer: `openspec/changes/reduce-fanout-parent-stall/spike/spawn-spike.mjs`
(copied in by task 0.1) — keep it; tasks re-run it for the verification delta.

## Goals / Non-Goals

Goals
- Child spawn cost ≤ 50 ms after the first spawn in a process.
- `onUpdate` cadence per child bounded by `PROGRESS_THROTTLE_MS` (250 ms →
  ≤ 4/s), terminal snapshots always delivered.
- At most `maxConcurrent` children running at once; rest `queued`, FIFO.
- No change to the child tool surface, agent resolution, model inheritance, or
  emitted event schema.

Non-goals
- Out-of-process children (worker_threads / child_process). Separate proposal.
- Reducing what extensions do per child turn (hook cost). Bounded by the cap
  instead.
- Dashboard-side card healing (companion change in `pi-agent-dashboard`).

## Decisions

### Decision 1: a fresh, lean `DefaultResourceLoader` per child

```ts
async function createChildLoader(cwd: string): Promise<DefaultResourceLoader> {
  const loader = new DefaultResourceLoader({
    cwd, agentDir: getAgentDir(),
    noSkills: true, noPromptTemplates: true, noThemes: true,
  });
  await loader.reload();
  return loader;
}
```

- One loader → one `Extension[]` + one `runtime` per child. Exactly what the
  SDK does today when `resourceLoader` is omitted, minus resources a headless
  child never reads (skills are surfaced to the model through the parent's
  system prompt only when the loader wires them; children get `agentMd` +
  tools; themes/prompt templates are TUI concerns). −350 MB RSS at n=7.
- Extension set is unchanged → tool surface unchanged (28 tools, `Agent`
  stripped as today).
- **Rejected — shared loader per (process, cwd)** (the original D1): the
  spike in Context proves `extensionsResult.runtime` is a single mutable object
  that `ExtensionRunner.bindCore` overwrites per session and
  `runtime.invalidate()` poisons on the first dispose. pi's model is strictly
  one live runner per loader (`agent-session.js` `reload()` invalidates the old
  runner). Not fixable from this extension without forking the SDK.
- **Rejected — `noExtensions` loader**: drops 24 tools from every child; user
  chose to keep the tool surface.
- The spawn-time cost that motivated sharing is one extension's `npm root -g`
  shell-out; memoized in the dashboard change. After that, per-child isolation
  costs ~30 ms/child, so sharing buys nothing worth its risk.
- If a child ever needs skills, drop `noSkills` — measured cost is ~0 ms; the
  flag exists for memory, not time.

### Decision 2: throttle `onUpdate` through the existing emitter

`createProgressEmitter(pi, agentId, windowMs)` becomes
`createProgressEmitter(sink, windowMs)` where `sink: (details) => void`, and
`pushUpdate` uses two emitters (one wrapping `emitSubagentProgress`, one
wrapping `onUpdate`) — or one emitter whose sink fans out to both. Pick the
one-emitter/fan-out form: same cadence for both legs, one timer per child.
`flush()` before every terminal emission (already done for progress; now covers
`onUpdate` too). Keeps the exported signature test-compatible via an overload
or by updating the 3 existing call sites in tests.

Cost model: `snapshotDetails` copies `entries` (`entries.slice()`) and
`usage.totals()` twice per call — moving it inside the throttled path also
removes the per-delta snapshot allocation. Net: ~7949 forwarded ticks →
≤ 4/s per child.

### Decision 3: semaphore before `createAgentSession`, `queued` until acquired

```ts
const gate = createSemaphore(() => loadSettings().maxConcurrent); // 0 = unlimited
```

- Acquire AFTER `emitSubagentCreated` (card appears immediately, status
  `queued` — an existing `AgentStatus`) and BEFORE the loader/`createAgentSession`.
- Release in `finally` alongside `session.dispose()`.
- Parent `signal` abort while waiting: reject the acquire, emit `aborted`, do
  not spawn. Waiting entries are removed from the FIFO.
- Default `4` (see Risks — doubt-driven-review, task 4.1): at ~0.75 s/child
  measured, 4 keeps worst-case sync work per parent tick under ~3 s — below the bridge watchdog's 60 s
  silence threshold with margin, and matches typical 2–4-way fan-outs.
- Setting: `maxConcurrent: number` in `DashboardAgentSettings`
  (`~/.pi/agent/extensions/pi-dashboard-subagents/config.json`), `DEFAULT_SETTINGS.maxConcurrent = 4`.
  Read per call via `loadSettings()` (cached; fits the existing pattern), so no
  `/reload` needed to change it.
- Nested subagents are impossible (`Agent` stripped from children) → one
  semaphore per process is the right scope.

## Risks / Trade-offs

- Spawn cost stays ~0.6 s/child until the dashboard change (memoized
  `npm root -g`) ships; this change is still correct and useful without it
  (throttle + cap address the runtime term that dominates the 240 s stall).
- `noSkills` on children: if a future child prompt relies on a skill being
  auto-listed, it will not be. Skills are still reachable by path if the parent
  passes them in the prompt.
- Throttled `onUpdate` delays the tool-call detail the parent's own TUI shows
  by ≤ 250 ms. Acceptable; terminal state is exact.
- Cap changes observable scheduling for users who relied on 7-way parallelism —
  they set `maxConcurrent: 0` (documented opt-out, README).
- **doubt-driven-review outcome (task 4.1): default is `4`, not `3`.** Both
  values sit far under the bridge's 60 s silence watchdog (worst-case
  synchronous work per parent tick: ~2.3 s at 3, ~3 s at 4 with the measured
  ~0.75 s/child spawn cost). `4` was chosen to preserve more parallelism for
  fan-out-heavy users at no measurable additional stall risk; `0` remains the
  unlimited opt-out and `1` the serial setting.

## Verification shape

- Unit (vitest, mocked SDK): every `createAgentSession` receives a distinct
  `resourceLoader` constructed with `{cwd, noSkills:true, noPromptTemplates:true,
  noThemes:true}` and `reload()`ed once; a rejected `reload()` surfaces as the
  tool's error result. `onUpdate`
  call count ≤ ceil(elapsed/250 ms)+1 under a burst of 100 events, last call
  carries terminal status. Semaphore: with cap 2 and 5 calls, ≤ 2 `createAgentSession`
  in flight; FIFO start order; abort while queued → `aborted`, no spawn.
- Spike re-run (`spike/spawn-spike.mjs default 7` with the dashboard memo
  landed): loop lag ≤ 300 ms at n=7, RSS ≤ 350 MB; without the memo, RSS only.
- Live: 7-way `Agent` fan-out from a dashboard-attached session in `judo-ng`;
  bridge metrics show no `watchdog_force_close`, `eventLoopMaxMs < 5000`,
  all 7 cards reach `completed`.

### Live run result (task 4.2)

Session `01a0a68f` (cwd `judo-ng`), user-global `packages` entry temporarily
repointed at this worktree, 7 parallel `Agent` calls (`@fast`) in one tool
block. All 7 returned `completed`, distinct `agentId`s, no errors, parent stayed
responsive and answered in the same turn. Wall clock 21.3 s
(`19:34:49.9` → `19:35:11.2`).

Per-child `durationMs` shows the `maxConcurrent: 4` semaphore working:

| probe | 1 | 2 | 3 | 4 | 5 | 6 | 7 |
|---|---|---|---|---|---|---|---|
| ms | 10776 | 12411 | 11548 | 9610 | 20672 | 21286 | 20843 |

Probes 1-4 ran immediately (~9.6-12.4 s each); probes 5-7 clock ~20.7-21.3 s —
their own ~10 s of work plus the queue wait for a wave-1 slot. Two waves, FIFO,
no starvation. Cost of the run: $0.21.
