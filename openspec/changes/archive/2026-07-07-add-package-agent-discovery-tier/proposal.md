## Why

Today the `Agent` tool resolves an agent `.md` by name across three fixed tiers (`resolveAgentMdPath`): project (`<cwd>/.pi/agents/<type>.md`) → user (`<agentDir>/agents/<type>.md`) → bundled (`<EXTENSION_ROOT>/agents/<type>.md`). The bundled tier is hard-wired to **this package only**, via `import.meta.url`. There is no way for another installed pi package to ship an agent definition and have the `Agent` tool discover and spawn it.

The desired workflow is simple and matches how pi already distributes skills, prompts, and themes: **drop `agents/<name>.md` into a package, install the package, and the `Agent` tool can spawn `<name>`.** This turns any pi package into an agent-definition provider without the operator having to hand-copy `.md` files into `<cwd>/.pi/agents/` or `<agentDir>/agents/`.

pi already knows where every installed package lives (`PackageManager.listConfiguredPackages()` → each `ConfiguredPackage` carries an `installedPath`). What's missing is the agent-specific discovery step: scan each package root for an `agents/` directory and make those `.md` files resolvable by the same parse/spawn path used today. pi has **no native "agent" resource type** (`resources_discover` yields only `skillPaths`, `promptPaths`, `themePaths`), so this extension — which already invented the `agents/*.md` convention — owns the discovery.

## What Changes

- **ADDED** a fourth agent-resolution tier, `package`, appended after `bundled`. For each installed pi package with an `installedPath`, the extension scans `<installedPath>/agents/*.md` and registers each file under its basename (`reviewer.md` → type `reviewer`) with `source: "package"` and the originating package `source` string.
- **ADDED** a package-agent discovery index built **lazily and cached** — `cwd` is NOT available at `activate(pi)` (the factory receives only `pi`; `cwd` lives on `ExtensionContext`/event payloads). The index is built from the `resources_discover` handler's event/`ctx` (`event.cwd`), on both `reason: "startup"` and `"reload"`; and, as a fallback for hosts where that event does not fire, lazily on the first `Agent` spawn using the tool's own `ctx.cwd`. The result is cached (keyed by cwd) so per-spawn resolution stays cheap and the one-time settings I/O (a synchronous, file-locking read) stays off the activation hot path. Enumeration constructs a `DefaultPackageManager` from `SettingsManager.create(cwd, agentDir)` — the same "reach past the declared ExtensionAPI" pattern already used for `pi.modelRegistry`.
- **MODIFIED** `resolveAgentMdPath` to consult the package index as tier 4 (after project → user → bundled miss). First match wins across tiers; the existing path-traversal guard on `agentType` is unchanged. A new test seam (`packageIndex` param) mirrors the existing `bundledDir` seam.
- **ADDED** user-scope-only discovery: the installed SDK (`@earendil-works/pi-coding-agent@0.75.5`) exposes no project-trust API (`ExtensionContext` has no `isProjectTrusted()`, `SettingsManager.create(cwd, agentDir?)` takes no trust option, `listConfiguredPackages()` performs no trust assert). Since trust cannot be read, only packages with `scope === "user"` (installed into `<agentDir>` by the operator) are scanned; **project-scoped packages are never indexed for agents.** This is strictly more conservative than a trust gate and fully closes the untrusted-checkout injection surface (a cloned repo shipping `.pi/settings.json` + `.pi/x/agents/*.md` contributes nothing).
- **ADDED** `source: "package"` to the `AgentMdSource` discriminator, carried through `ResolvedAgentMd` into `AgentDetails` so the dashboard card can render "reviewer (package)" and show which package supplied it.
- **ADDED** deterministic collision handling: packages are de-duplicated first (a source configured in both user and project scope collapses to one entry, project winning, mirroring pi's `dedupePackages`), then scanned in a stable order (sorted by package `source` string); the first package to define a given `<name>` wins; subsequent cross-package duplicates are dropped and logged to stderr with both sources named.
- **ADDED** `filtered`-package handling: a package configured in filtered form (object source with an `extensions`/`skills`/`prompts`/`themes` allowlist — there is no `agents` filter key) is skipped for agent discovery, so a partially-opted-in package does not silently contribute agents.
- **ADDED** defensive enumeration: `listConfiguredPackages()` reads settings and could throw, so the call is wrapped in try/catch and any throw degrades to an empty index rather than propagating.

Non-changes (deliberate):

- The existing project / user / bundled tiers keep their exact current precedence and behaviour. Package agents rank **below** this package's own bundled agents, so nothing that resolves today changes.
- No collapse of `bundled` into `package`. The current bundled special-case (self via `import.meta.url`) is retained as-is for full backward compatibility; unifying the two tiers is called out as a future option, not done here.
- No dashboard picker / autocomplete UI, no `list_agents` tool. The discovery index is internal; surfacing it as a first-class enumeration API is deferred.
- Discovery is **user-scope-only**: user-scoped package agents are open-by-default (the operator installed them into `<agentDir>`); project-scoped package agents are never discovered (the SDK exposes no trust signal to gate them safely). The `source: "package"` badge remains the transparency mechanism for what did load. Restoring trusted project-scoped discovery once the SDK exposes a trust signal, or adding a per-package allowlist, are follow-ups, not part of this change.
- No namespaced spawn syntax (`@pkg/name`). Collisions resolve by deterministic first-match + warning; namespacing is deferred (and would collide with the current `"/"` path-traversal guard).

## Capabilities

### New Capabilities

- `package-agent-discovery`: scanning installed pi packages for `agents/*.md`, building a cached discovery index, deterministic collision handling, and rebuild-on-reload.

### Modified Capabilities

- `bundled-agents`: the "Agent resolution SHALL use a three-tier fallback" requirement is amended to a **four-tier** fallback (project → user → bundled → package). The `source` discriminator gains `"package"`.

## Impact

- **Code (`extensions/agent.ts`):**
  - Extend `AgentMdSource` with `"package"`; extend `ResolvedAgentMd` to optionally carry the originating package source string.
  - Add a package-scan builder (`buildPackageAgentIndex(cwd, agentDir)`) returning `Map<type, { path, pkg }>`, using `SettingsManager.create(cwd, agentDir)` + `DefaultPackageManager.listConfiguredPackages()` (wrapped in try/catch) + user-scope filter + de-dupe by source + `filtered` skip + stable sort + `readdirSync` over `<installedPath>/agents`.
  - Add a module-level index cache keyed by cwd, populated **lazily** on the first `resources_discover` (startup or reload, which carry `cwd`) and, as a fallback, on the first `Agent` spawn using `ctx.cwd`. Expose an optional `packageIndex` param on `resolveAgentMdPath` defaulting to an **empty Map** (pure-function test seam; production callers pass the cache).
  - Consult the index as tier 4 in `resolveAgentMdPath`.
- **Tests (`extensions/__tests__/`):** new file `package-discovery.test.ts` — index build over a temp package layout, collision determinism + warning, tier-4-after-miss resolution, tier precedence (project/user/bundled still win over package), path-traversal guard still short-circuits, empty/missing `agents/` dir tolerated.
- **Docs:** `README.md` gains a "Shipping agents from a package" section; `CHANGELOG.md` additive `[Unreleased]` entry.
- **No breaking changes.** Everything resolvable today resolves identically; the package tier only adds new names that previously returned `undefined`.
- **No new runtime dependencies** (uses SDK exports already available: `SettingsManager`, `DefaultPackageManager`, `getAgentDir`).
