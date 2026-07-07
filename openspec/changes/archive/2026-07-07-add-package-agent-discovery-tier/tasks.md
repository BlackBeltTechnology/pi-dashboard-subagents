## 1. Types + discriminator

- [x] 1.1 In `extensions/agent.ts`, extend `AgentMdSource` union with `"package"`.
- [x] 1.2 Extend `ResolvedAgentMd` with an optional `pkg?: string` (the originating package `source` string; set only when `source === "package"`).
- [x] 1.3 Thread `pkg` through `AgentDetails` (via `buildDetails` in `events.ts`) so the dashboard card can render "reviewer (package: <pkg>)". Keep it optional/back-compatible.

## 2. Package discovery index

- [x] 2.1 Add `PackageAgentIndex = Map<string, { path: string; pkg: string }>` type.
- [x] 2.2 Implement `buildPackageAgentIndex(cwd: string, agentDir: string): PackageAgentIndex`:
  - Construct `SettingsManager.create(cwd, agentDir)` (the installed SDK's `create` takes no trust option — no project-trust API exists) and `new DefaultPackageManager({ cwd, agentDir, settingsManager })`.
  - Call `listConfiguredPackages()` **inside try/catch** — degrade to an empty index on any throw (Decision 7).
  - **Keep only `scope === "user"` entries** — project-scoped packages are never indexed (Decision 5, user-scope-only).
  - **De-dupe** by `source` (a source listed twice collapses to one); this avoids a spurious self-collision warning (M2).
  - **Skip** any package with `filtered === true` (filter form has no `agents` key — not opted in) (M1).
  - Keep entries with a defined `installedPath`; sort ascending by `source` string (deterministic cross-package collision order).
  - For each, `readdirSync(<installedPath>/agents)` filtered to `*.md`; register basename→`{ path, pkg: source }` only if the key is not already present.
  - On duplicate basename across DIFFERENT packages, DROP the later one and `console.warn` naming both package sources and the winning path.
  - Wrap every per-package step defensively; never throw.
- [x] 2.3 Add a module-level cache `let packageAgentIndex: PackageAgentIndex | undefined` **plus the cwd it was built for** (`let indexedCwd: string | undefined`), and a `refreshPackageAgentIndex(cwd, agentDir)` setter. `ensurePackageAgentIndex(cwd, agentDir)` builds only when unbuilt or when `cwd !== indexedCwd` (rebuild on cwd change — m3).

## 3. Resolver wiring (tier 4)

- [x] 3.1 Add an optional `packageIndex: PackageAgentIndex = new Map()` parameter to `resolveAgentMdPath` (test seam mirroring `bundledDir`). Default to an **empty Map**, NOT the live module cache, so existing pure-function tests stay isolated from global state (m2). Production callers pass the cache explicitly.
- [x] 3.2 After the bundled miss, consult `packageIndex.get(agentType)`; on hit return `{ path, source: "package", pkg }`.
- [x] 3.3 Keep the path-traversal guard as the first check — it must still short-circuit before any index lookup.
- [x] 3.4 Confirm first-match precedence: project → user → bundled → package (package only reached when all three miss).

## 4. Build triggers (lazy — NOT at activate)

> `cwd` is NOT available at `activate(pi)` (`ExtensionFactory = (pi) => void`; `ExtensionAPI` has no `cwd`). Do NOT attempt to build the index in `activate()`.

- [x] 4.1 In `activate(pi)`, only register the tool and the `resources_discover` handler. No index build here.
- [x] 4.2 Register `pi.on("resources_discover", (event) => { refreshPackageAgentIndex(event.cwd, getAgentDir()); })` — fires on BOTH `reason: "startup"` and `"reload"` (do not gate on `reason`). `event.cwd` supplies the working directory (there is no trust signal to read). Return `undefined` (handler is side-effect-only; do not fabricate a `ResourcesDiscoverResult`).
- [x] 4.3 In the `Agent` tool `execute`, call `ensurePackageAgentIndex(ctx.cwd, getAgentDir())` before resolving — fallback build for hosts that never fire `resources_discover`, and the cwd-change rebuild path.
- [x] 4.4 Ensure a failed/empty index never blocks tool registration or a spawn.

## 5. Tests (`extensions/__tests__/package-discovery.test.ts`)

- [x] 5.1 Build index over a temp layout with two fake packages each exposing `agents/*.md`; assert every basename is registered with the correct `pkg`.
- [x] 5.2 Collision determinism: two packages both ship `reviewer.md`; assert the package with the lexicographically-smaller `source` wins, the loser is dropped, and a warning is emitted (spy on `console.warn`).
- [x] 5.3 Tier-4 resolution: with project/user/bundled all missing for `reviewer`, `resolveAgentMdPath("reviewer", cwd, bundledDir, index)` returns `{ source: "package", pkg }`.
- [x] 5.4 Precedence: when a project (or user, or bundled) `reviewer.md` exists, it wins over the package index entry (package tier not consulted).
- [x] 5.5 Path-traversal guard still short-circuits (`"../x"`, `"a/b"`, `"a\\b"`) before index lookup → `undefined`.
- [x] 5.6 Missing/empty `agents/` dir and non-`.md` entries are tolerated (no throw, not registered).
- [x] 5.7 Package with undefined `installedPath` is skipped.
- [x] 5.8 Builder never throws when `DefaultPackageManager` construction fails (inject a failing seam or point at a non-existent agentDir) → returns empty map.
- [x] 5.9 Scope: project-scoped package agents (`scope: "project"`) are NOT indexed; user-scoped (`scope: "user"`) ARE. (User-scope-only — the SDK exposes no project-trust API to gate on.)
- [x] 5.10 `filtered:true` package contributes no agents even if it ships `agents/*.md` (M1).
- [x] 5.11 Same `source` in both user and project scope: contributes a single entry from its user-scope form (project form never indexed), NO spurious collision warning (M2).
- [x] 5.12 `listConfiguredPackages()` throwing is caught → empty index, never a throw (M3/C5).
- [x] 5.13 `resolveAgentMdPath` default `packageIndex` is an empty Map: calling it with only `(type, cwd, bundledDir)` never consults module state (m2).
- [x] 5.14 cwd-change rebuild: `ensurePackageAgentIndex` rebuilds when `cwd !== indexedCwd` (m3).

## 6. Documentation

- [x] 6.1 `README.md`: new "Shipping agents from a package" section — the `agents/<name>.md` convention, `files[]` inclusion, tier ordering (project → user → bundled → package), collision rule, and the `source: "package"` badge.
- [x] 6.2 `CHANGELOG.md`: `[Unreleased] / Added` entry for the package discovery tier.
- [x] 6.3 Inline JSDoc on `buildPackageAgentIndex`, `refreshPackageAgentIndex`, the new `resolveAgentMdPath` param, and the `AgentMdSource`/`ResolvedAgentMd` additions.

## 7. Validation

- [x] 7.1 `npm test` — all pass, new `package-discovery.test.ts` green.
- [x] 7.2 `npm run typecheck` — clean.
- [x] 7.3 `npm run lint` — no new errors.
- [x] 7.4 `openspec validate add-package-agent-discovery-tier --strict` — green.
- [x] 7.5 `npm pack --dry-run` — unchanged file list (no new shipped files; `agents/` still optional).

## 8. End-to-end smoke (live pi) — operator follow-up

> Requires a pi restart so the extension re-activates and rebuilds the index.

- [ ] 8.1 Install a second pi package that ships `agents/demo-reviewer.md`. Restart pi.
- [ ] 8.2 Call `Agent({ subagent_type: "demo-reviewer", description: "smoke", prompt: "say PASS" })`. Verify it spawns and the dashboard card shows `source: package` naming the providing package.
- [ ] 8.3 Place `<cwd>/.pi/agents/demo-reviewer.md` and re-spawn: verify the project tier now wins (card shows `source: project`).
- [ ] 8.4 Ship the same basename from two installed packages; verify deterministic winner + a single stderr warning naming both.
