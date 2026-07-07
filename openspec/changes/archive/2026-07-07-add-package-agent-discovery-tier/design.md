## Context

`extensions/agent.ts` resolves an agent `.md` by name through three tiers:

```ts
export function resolveAgentMdPath(
  agentType: string,
  cwd: string,
  bundledDir: string = BUNDLED_AGENTS_DIR,
): ResolvedAgentMd | undefined {
  // path-traversal guard on agentType …
  // 1. <cwd>/.pi/agents/<type>.md        → "project"
  // 2. <getAgentDir()>/agents/<type>.md  → "user"
  // 3. <bundledDir>/<type>.md            → "bundled"   (this package only)
  return undefined;
}
```

The bundled tier is `<EXTENSION_ROOT>/agents/`, computed from `import.meta.url`. It is intrinsically self-scoped — no other package's `agents/` directory is ever consulted. The operator's only way to add agents from a third-party package is to hand-copy `.md` files into a project or user tier.

pi's package layer already resolves and tracks every installed package. `PackageManager.listConfiguredPackages()` returns `ConfiguredPackage[]`, each with `{ source, scope, installedPath? }`. `installedPath` is the package root — the same directory that would contain `agents/`. pi does not itself look for `agents/` (no native agent resource type), so this extension performs the agent-specific scan.

## Goals / Non-Goals

**Goals:**

- Any installed pi package can ship `agents/<name>.md` and have the `Agent` tool discover and spawn `<name>`, with no manual copying.
- Discovery is cheap per-spawn: scan once, cache, reuse; rebuild only on reload.
- Package agents flow through the **existing** `parseAgentMd` + spawn path unchanged — same frontmatter fields, same model resolution, same emission.
- The dashboard can tell a package-sourced agent apart via a `source: "package"` badge naming the originating package.
- Everything resolvable today keeps resolving identically (fully additive).

**Non-Goals:**

- Collapsing `bundled` into `package`. Kept separate for backward compatibility (see Decision 2).
- A dashboard picker, autocomplete, or `list_agents` tool. The index is internal (see Decision 6).
- Discovering project-scoped package agents. Only user-scoped packages are scanned; project scope is never indexed (see Decision 5).
- Namespaced spawn syntax `@pkg/name` (see Decision 4).
- Changing `parseAgentMd`, model resolution, inheritance, or emission.

## Decisions

### Decision 1: Package tier is #4, appended after bundled

```
  1. project   <cwd>/.pi/agents/<type>.md          (highest — local override)
  2. user      <agentDir>/agents/<type>.md
  3. bundled   <EXTENSION_ROOT>/agents/<type>.md    (this package's own)
  4. package   <installedPath>/agents/<type>.md     (any other package)   ← NEW (lowest)
```

Rationale: placing `package` last means no name that resolves today can be shadowed by a newly installed package. The operator (project/user tiers) and this package's own curation (bundled) always win. A package agent only fills a name that previously resolved to `undefined`. This is the maximally-additive placement.

Alternative considered: rank package **above** bundled so third-party curation can override this package's shipped agents. Rejected for a first cut — it lets an installed dependency silently change the meaning of a bundled agent name, which is surprising. Revisit if a real override use case appears.

### Decision 2: Do NOT collapse `bundled` into `package`

It is tempting to treat this package's own `agents/` as "just another package" and delete the bundled special-case. Rejected here:

- The `bundled-agents` capability has shipped requirements tied to the `import.meta.url`-derived directory and the `"bundled"` source discriminator. Collapsing would MODIFY/REMOVE those requirements — a larger, riskier delta.
- `import.meta.url` resolution works even when this package is loaded in ways `listConfiguredPackages()` might not report (local dev, linked, temporary). Keeping the self-scan independent is more robust.

**Resolved position (folded from Open Questions):** collapse is a named, deferred follow-up — NOT this change. Trigger to revisit: after the package tier has shipped and proven out in production for at least one release, open a follow-up `collapse-bundled-into-package-tier` that (a) rewrites the `bundled-agents` requirements to fold tier 3 into tier 4, (b) keeps an `import.meta.url` self-entry injected into the package index so local/linked/temporary loads still resolve this package's own agents, and (c) preserves the `"bundled"` source badge as an alias of `"package (self)"` for continuity. Until then, the two tiers stay separate by design.

### Decision 3: Enumerate via `listConfiguredPackages()`, not `resolve()`

`PackageManager` offers two enumeration paths:

| Path | Cost | Side effects |
|---|---|---|
| `listConfiguredPackages()` | synchronous, reads settings | none (but see below) |
| `resolve(onMissing?)` | async, may install/clone/pull | network, disk writes |

We use `listConfiguredPackages()`. Discovery must be a passive read — scanning for agent definitions must never trigger a package install or network call. Each returned `ConfiguredPackage` is `{ source, scope, filtered, installedPath? }`; `installedPath` is the root we scan (`<installedPath>/agents/*.md`). Packages with no `installedPath` (not yet installed) are skipped silently.

**Constructing the manager is not free** (verified against the SDK): `SettingsManager.create(cwd, agentDir)` performs a *synchronous, file-locking* settings read (`lockfile.lockSync`, up to 10×20ms retry) twice (global + project), independent of the main pi process's own `SettingsManager`. This is acceptable only because it runs **once, lazily, off the activation hot path** (see Decision 3b), and the result is cached.

**`listConfiguredPackages()` is wrapped defensively anyway.** In the installed SDK (`@earendil-works/pi-coding-agent@0.75.5`) it does **not** throw for trust reasons — there is no trust assert; `getInstalledPath` is a plain `existsSync` probe. But it reads settings, so the builder still wraps the call in try/catch and degrades to an empty index on any throw (Decision 7).

**Scope filter + de-dupe + `filtered` before scanning.** We keep only `scope === "user"` entries (project scope is never indexed — Decision 5), de-dupe by `source` (a source listed twice collapses to one, avoiding a spurious self-collision warning), and skip any package with `filtered === true`: the filter object form allowlists only `extensions | skills | prompts | themes` — there is no `agents` key — so a filtered package has not opted its agents in.

Construction mirrors the existing pattern where the extension reaches `pi.modelRegistry` (declared on ExtensionAPI but accessed via a narrow cast); here the package manager is not on ExtensionAPI at all, so we instantiate the SDK's default implementation directly.

### Decision 3b: Build lazily from `ctx`, never at `activate()`

`cwd` is **not available at `activate(pi)`** — verified: `ExtensionFactory = (pi: ExtensionAPI) => void`, and `ExtensionAPI` has no `cwd` (it lives on `ExtensionContext` and on event payloads; `SessionStartEvent` also has no `cwd`). So the index cannot be built at activation as the first draft claimed.

Build triggers, in order:

1. **`resources_discover` handler** — `ExtensionHandler` is `(event, ctx: ExtensionContext) => …`. Both `event.cwd` and `ctx.cwd` carry the working directory; there is **no** `ctx.isProjectTrusted()` (or any trust signal) to read — see Decision 5. We build on `reason` of *either* `"startup"` or `"reload"` (the first draft's `reason === "reload"`-only gate would leave the index empty for the whole first session). The handler is side-effect-only and returns `undefined` — legal, since the result type's fields are all optional (see Risk note on freeloading).
2. **First `Agent` spawn (fallback)** — if the index is unbuilt when a spawn runs, build it from the tool's `ctx.cwd`. Covers hosts that never fire `resources_discover`.

The cache is keyed by `cwd` so an in-process session switch to a different cwd rebuilds rather than serving stale project-scope results (mitigates the stale-cwd edge case). Rebuild also fires on `resources_discover` `reload`.

### Decision 4: Deterministic first-match collision handling, no namespacing

When two packages each ship `reviewer.md`:

- Package roots are scanned in a **stable order**: sorted ascending by the package `source` string.
- The first package to define a given basename wins; later duplicates are dropped.
- Each dropped duplicate is logged to stderr naming both package sources and the winning path, so the operator can diagnose.

Namespaced spawns (`Agent({ subagent_type: "@acme/reviewer" })`) are NOT introduced. The current path-traversal guard rejects any `agentType` containing `"/"`, `"\\"`, or `".."`; a namespace syntax would require loosening that guard, which is a security-sensitive change out of scope here. Deterministic ordering plus a warning is sufficient for a first cut; namespacing is an Open Question.

### Decision 5: User-scope-only discovery (the installed SDK exposes no project-trust API)

A package's `agents/<name>.md` can specify `prompt`, `tools`, and `model`, i.e. it defines what a spawnable subagent does. That is a real injection surface: a **cloned untrusted repo** could ship `.pi/settings.json` (declaring a local project-scoped package) plus `.pi/<pkg>/agents/pwn.md`, and have `pwn` become spawnable with attacker-chosen `model`/`tools`/`prompt` with no operator consent.

The original design closed this by threading `ctx.isProjectTrusted()` into `SettingsManager.create(cwd, agentDir, { projectTrusted })`. **Verified against the installed SDK (`@earendil-works/pi-coding-agent@0.75.5`), none of that API exists:** `ExtensionContext` has no `isProjectTrusted()`, `SettingsManager.create(cwd, agentDir?)` takes no options object, and `listConfiguredPackages()` performs no trust assert. No project-trust signal is surfaced to extensions at all.

Rather than gate on a trust signal we cannot read, discovery is **user-scope-only**: only packages with `scope === "user"` (installed into `<agentDir>` by the operator) are scanned; **project-scoped packages are never indexed for agents.** This is strictly more conservative than the original gate and needs no trust API:

- **User-scoped** package agents (installed into `<agentDir>` by the operator) are always discovered — installing a package into your own agent dir *is* the consent.
- **Project-scoped** package agents are **never** discovered, trusted or not. This fully closes the untrusted-checkout injection surface (a cloned repo declaring a project-scoped local package + `agents/pwn.md` contributes nothing), at the cost of not supporting trusted project-scoped package agents.

Transparency remains: `source: "package"` + the originating package `source` flow into `AgentDetails` (`reviewer (package: @acme/pi-reviewers)`), and any package agent can be shadowed by a higher-tier `.md` of the same name.

**Resolved position:** user-scope stays open-by-default (installing into `<agentDir>` is the consent, and gating it would break the primary "install a package, get its agents" workflow). Project scope is dropped entirely for this change. Two revisit triggers: (a) if the SDK later exposes a trust signal, add trusted project-scoped discovery back; (b) if a compromised-npm-package threat model becomes real, add a per-package agent allowlist rather than a blanket user-scope gate. Neither is built now.

### Decision 6: Internal cached index; enumeration API deferred

The scan result is a module-level `Map<type, { path, pkg }>` built lazily from an `ExtensionContext` (Decision 3b), cached by `cwd`, and rebuilt on `resources_discover` `reload` or a `cwd` change. Per-spawn `resolveAgentMdPath` consults the cached map for tier 4 — no filesystem walk per call (project/user/bundled remain cheap `existsSync` probes as today).

For testability, `resolveAgentMdPath` gains an optional `packageIndex` parameter (defaulting to the module cache), mirroring the existing `bundledDir` test seam. This keeps the resolver a pure function under test while production callers use the cache.

A public enumeration surface (dashboard picker, `list_agents` tool, autocomplete of available `subagent_type` values) is deliberately out of scope. The index makes such a feature easy later, but "deliver + spawn by name" is satisfied by resolution alone.

### Decision 7: Scan is defensive and never throws; degrades to empty-or-partial

Index build tolerates every failure mode without crashing:

- `SettingsManager.create` / `DefaultPackageManager` construction throws → log, empty index.
- `listConfiguredPackages()` throws (e.g. a settings read error) → caught; index is empty.
- A package `installedPath` is undefined or missing on disk → skip.
- `<installedPath>/agents` absent or not a directory → skip.
- A directory entry is not a `.md` file → ignore.

A broken discovery step must degrade to "no (or fewer) package agents", never break the project/user/bundled tiers that work today. The contract wording is **empty-or-partial**, not strictly "partial" — an early throw can legitimately yield empty.

## Risks / Trade-offs

- **[Risk]** Constructing a second `DefaultPackageManager` duplicates work pi's runner already did, and `SettingsManager.create` does a *synchronous file-locking* settings read (up to ~200ms under lock contention). → Bounded by building **once, lazily, off the activation path** and caching (Decision 3b). Never per spawn.
- **[Risk]** A malicious/careless package ships an agent that grants a broad `tools` set. → Bounded on two axes: (a) project-scoped package agents are never discovered — user-scope-only (Decision 5); (b) the spawn's own tool intersection drops any tool not in the parent session's active set. The `source` badge surfaces provenance.
- **[Risk]** Collision order feels arbitrary to operators. → Mitigated by de-dupe (project over user) + stable sort + explicit stderr warning naming both sources; deterministic across runs.
- **[Trade-off]** Keeping bundled separate from package (Decision 2) leaves two nearly-parallel tiers. Accepted for backward-compat; collapse deferred.
- **[Risk]** `resources_discover` may not fire in every host embedding this extension. → The **first `Agent` spawn** is a fallback build trigger (Decision 3b), so discovery works even with no lifecycle event; the event path is the optimization.
- **[Risk/Trade-off]** `resources_discover` is a *result-returning* event (`{ skillPaths, promptPaths, themePaths }`); using it side-effect-only is "freeloading". → Legal today (all result fields optional; returning `undefined` is fine). We treat the event purely as a `ctx` source; if pi ever validates results, the fallback spawn-time build still covers us.

## Migration Plan

Purely additive. After landing:

- Existing project / user / bundled agents resolve bit-for-bit as before.
- Existing callers that spawn a name resolving to `undefined` today still get `undefined` — unless an installed package now provides that name, which is the intended new behaviour.
- To ship agents from a package: add `agents/<name>.md`, include `"agents/"` in the package's `files[]`, publish/install. No config change required.

Rollback: revert the change. Tier 4 disappears; resolution returns to three tiers. No on-disk state to unwind.

## Open Questions

> User-scope trust (was OQ) and the bundled/package collapse (was OQ) are now **resolved positions** — see Decision 5 and Decision 2 respectively. Remaining genuinely-open items:

1. **Rank package above or below bundled?** This change picks below (Decision 1). If third-party override of a bundled agent name becomes a real need, a follow-up can add an explicit precedence setting.
2. **Namespaced spawns `@pkg/name` for explicit disambiguation?** Deferred (Decision 4) — requires loosening the path-traversal guard.
3. **Public enumeration API / dashboard picker?** Deferred (Decision 6). The cached index is the enabling primitive.
4. **Rebuild triggers beyond `resources_discover` reload + cwd-change?** e.g. a package install/remove during a live session with no reload. Out of scope; `/reload` covers it for now.
