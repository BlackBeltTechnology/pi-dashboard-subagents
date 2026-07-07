## 1. Types + discriminator

- [ ] 1.1 In `extensions/agent.ts`, extend `AgentMdSource` union with `"package"`.
- [ ] 1.2 Extend `ResolvedAgentMd` with an optional `pkg?: string` (the originating package `source` string; set only when `source === "package"`).
- [ ] 1.3 Thread `pkg` through `AgentDetails` (via `buildDetails` in `events.ts`) so the dashboard card can render "reviewer (package: <pkg>)". Keep it optional/back-compatible.

## 2. Package discovery index

- [ ] 2.1 Add `PackageAgentIndex = Map<string, { path: string; pkg: string }>` type.
- [ ] 2.2 Implement `buildPackageAgentIndex(cwd: string, agentDir: string, projectTrusted: boolean): PackageAgentIndex`:
  - Construct `SettingsManager.create(cwd, agentDir, { projectTrusted })` (thread REAL trust — do NOT omit the option; omission defaults `projectTrusted:true` and bypasses pi's project-trust gate) and `new DefaultPackageManager({ cwd, agentDir, settingsManager })`.
  - Call `listConfiguredPackages()` **inside try/catch** — it can throw on the project-scope trust assert; on throw retain any user-scope subset, else empty (Decision 7).
  - **De-dupe** by `source`, keeping the `project`-scope entry over `user` (mirror pi's `dedupePackages`); this avoids a spurious self-collision warning (M2).
  - **Skip** any package with `filtered === true` (filter form has no `agents` key — not opted in) (M1).
  - Keep entries with a defined `installedPath`; sort ascending by `source` string (deterministic cross-package collision order).
  - For each, `readdirSync(<installedPath>/agents)` filtered to `*.md`; register basename→`{ path, pkg: source }` only if the key is not already present.
  - On duplicate basename across DIFFERENT packages, DROP the later one and `console.warn` naming both package sources and the winning path.
  - Wrap every per-package step defensively; never throw.
- [ ] 2.3 Add a module-level cache `let packageAgentIndex: PackageAgentIndex | undefined` **plus the cwd it was built for** (`let indexedCwd: string | undefined`), and a `refreshPackageAgentIndex(cwd, agentDir, projectTrusted)` setter. `ensurePackageAgentIndex(cwd, agentDir, projectTrusted)` builds only when unbuilt or when `cwd !== indexedCwd` (rebuild on cwd change — m3).

## 3. Resolver wiring (tier 4)

- [ ] 3.1 Add an optional `packageIndex: PackageAgentIndex = new Map()` parameter to `resolveAgentMdPath` (test seam mirroring `bundledDir`). Default to an **empty Map**, NOT the live module cache, so existing pure-function tests stay isolated from global state (m2). Production callers pass the cache explicitly.
- [ ] 3.2 After the bundled miss, consult `packageIndex.get(agentType)`; on hit return `{ path, source: "package", pkg }`.
- [ ] 3.3 Keep the path-traversal guard as the first check — it must still short-circuit before any index lookup.
- [ ] 3.4 Confirm first-match precedence: project → user → bundled → package (package only reached when all three miss).

## 4. Build triggers (lazy — NOT at activate)

> `cwd` is NOT available at `activate(pi)` (`ExtensionFactory = (pi) => void`; `ExtensionAPI` has no `cwd`). Do NOT attempt to build the index in `activate()`.

- [ ] 4.1 In `activate(pi)`, only register the tool and the `resources_discover` handler. No index build here.
- [ ] 4.2 Register `pi.on("resources_discover", (event, ctx) => { refreshPackageAgentIndex(ctx.cwd, getAgentDir(), ctx.isProjectTrusted()); })` — fires on BOTH `reason: "startup"` and `"reload"` (do not gate on `reason`). `ctx` supplies both cwd and trust. Return `undefined` (handler is side-effect-only; do not fabricate a `ResourcesDiscoverResult`).
- [ ] 4.3 In the `Agent` tool `execute`, call `ensurePackageAgentIndex(ctx.cwd, getAgentDir(), ctx.isProjectTrusted())` before resolving — fallback build for hosts that never fire `resources_discover`, and the cwd-change rebuild path.
- [ ] 4.4 Ensure a failed/empty index never blocks tool registration or a spawn.

## 5. Tests (`extensions/__tests__/package-discovery.test.ts`)

- [ ] 5.1 Build index over a temp layout with two fake packages each exposing `agents/*.md`; assert every basename is registered with the correct `pkg`.
- [ ] 5.2 Collision determinism: two packages both ship `reviewer.md`; assert the package with the lexicographically-smaller `source` wins, the loser is dropped, and a warning is emitted (spy on `console.warn`).
- [ ] 5.3 Tier-4 resolution: with project/user/bundled all missing for `reviewer`, `resolveAgentMdPath("reviewer", cwd, bundledDir, index)` returns `{ source: "package", pkg }`.
- [ ] 5.4 Precedence: when a project (or user, or bundled) `reviewer.md` exists, it wins over the package index entry (package tier not consulted).
- [ ] 5.5 Path-traversal guard still short-circuits (`"../x"`, `"a/b"`, `"a\\b"`) before index lookup → `undefined`.
- [ ] 5.6 Missing/empty `agents/` dir and non-`.md` entries are tolerated (no throw, not registered).
- [ ] 5.7 Package with undefined `installedPath` is skipped.
- [ ] 5.8 Builder never throws when `DefaultPackageManager` construction fails (inject a failing seam or point at a non-existent agentDir) → returns empty map.
- [ ] 5.9 Trust: with `projectTrusted:false`, project-scoped package agents are NOT indexed; user-scoped ARE. With `projectTrusted:true`, both are. Assert `SettingsManager.create` is called WITH the option (never omitted).
- [ ] 5.10 `filtered:true` package contributes no agents even if it ships `agents/*.md` (M1).
- [ ] 5.11 Same `source` in both user and project scope: de-duped to one entry, project wins, NO spurious collision warning (M2).
- [ ] 5.12 `listConfiguredPackages()` throwing mid-iteration is caught → partial (user-scope) or empty index, never a throw (M3/C5).
- [ ] 5.13 `resolveAgentMdPath` default `packageIndex` is an empty Map: calling it with only `(type, cwd, bundledDir)` never consults module state (m2).
- [ ] 5.14 cwd-change rebuild: `ensurePackageAgentIndex` rebuilds when `cwd !== indexedCwd` (m3).

## 6. Documentation

- [ ] 6.1 `README.md`: new "Shipping agents from a package" section — the `agents/<name>.md` convention, `files[]` inclusion, tier ordering (project → user → bundled → package), collision rule, and the `source: "package"` badge.
- [ ] 6.2 `CHANGELOG.md`: `[Unreleased] / Added` entry for the package discovery tier.
- [ ] 6.3 Inline JSDoc on `buildPackageAgentIndex`, `refreshPackageAgentIndex`, the new `resolveAgentMdPath` param, and the `AgentMdSource`/`ResolvedAgentMd` additions.

## 7. Validation

- [ ] 7.1 `npm test` — all pass, new `package-discovery.test.ts` green.
- [ ] 7.2 `npm run typecheck` — clean.
- [ ] 7.3 `npm run lint` — no new errors.
- [ ] 7.4 `openspec validate add-package-agent-discovery-tier --strict` — green.
- [ ] 7.5 `npm pack --dry-run` — unchanged file list (no new shipped files; `agents/` still optional).

## 8. End-to-end smoke (live pi) — operator follow-up

> Requires a pi restart so the extension re-activates and rebuilds the index.

- [ ] 8.1 Install a second pi package that ships `agents/demo-reviewer.md`. Restart pi.
- [ ] 8.2 Call `Agent({ subagent_type: "demo-reviewer", description: "smoke", prompt: "say PASS" })`. Verify it spawns and the dashboard card shows `source: package` naming the providing package.
- [ ] 8.3 Place `<cwd>/.pi/agents/demo-reviewer.md` and re-spawn: verify the project tier now wins (card shows `source: project`).
- [ ] 8.4 Ship the same basename from two installed packages; verify deterministic winner + a single stderr warning naming both.
