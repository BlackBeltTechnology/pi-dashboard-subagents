# package-agent-discovery Specification

## Purpose
Lets agents shipped inside installed pi packages (`agents/*.md`) be spawned by name, as the fourth and lowest-precedence agent resolution tier. Defines which packages are scanned, when the discovery index is built and cached, how name collisions resolve, and how discovery fails safely without affecting the other tiers.
## Requirements
### Requirement: The extension SHALL discover agents shipped by installed pi packages

The extension SHALL scan each eligible installed pi package (user scope, per the user-scope-only requirement) for an `agents/` directory and register each `*.md` file there as a spawnable agent type keyed by the file's basename (`reviewer.md` → type `reviewer`). It SHALL enumerate packages with `PackageManager.listConfiguredPackages()` and scan `<installedPath>/agents/*.md` for each package with a defined `installedPath`.

#### Scenario: A package's agents/*.md become spawnable

- **GIVEN** an installed package `@acme/pi-reviewers` whose `installedPath` contains `agents/reviewer.md`
- **WHEN** the discovery index is built
- **THEN** the index SHALL contain an entry keyed `"reviewer"` pointing at `<installedPath>/agents/reviewer.md`
- **AND** the entry SHALL record `pkg: "@acme/pi-reviewers"`
- **AND** `Agent({ subagent_type: "reviewer", … })` SHALL spawn that agent through the normal parse/spawn path

#### Scenario: Packages without an installed path are skipped

- **GIVEN** a configured package whose `installedPath` is undefined
- **WHEN** the discovery index is built
- **THEN** that package SHALL be skipped
- **AND** no error SHALL be thrown

#### Scenario: Missing or empty agents directory is tolerated

- **GIVEN** an installed package whose root has no `agents/` directory, or an empty one, or one containing non-`.md` files
- **WHEN** the discovery index is built
- **THEN** that package SHALL contribute no entries
- **AND** no error SHALL be thrown

#### Scenario: Filtered packages contribute no agents

- **GIVEN** a package configured in filtered form (`ConfiguredPackage.filtered === true`, i.e. an object source allowlisting only some of `extensions`/`skills`/`prompts`/`themes` — there is no `agents` filter key)
- **WHEN** the discovery index is built
- **THEN** that package SHALL be skipped for agent discovery even if it ships `agents/*.md`

#### Scenario: Same source in both scopes is de-duplicated (user entry kept, project ignored)

- **GIVEN** the same package `source` is configured in BOTH `user` and `project` scope, and both ship `agents/reviewer.md`
- **WHEN** the discovery index is built
- **THEN** the source SHALL contribute a single entry from its `user`-scope form (the `project`-scope form is never indexed — see the user-scope-only requirement)
- **AND** NO cross-package collision warning SHALL be emitted for this single logical package

### Requirement: Package discovery SHALL be a passive read

Discovery SHALL NOT trigger a package install, clone, pull, or any network activity. In particular it SHALL NOT call `PackageManager.resolve()` with an installing `onMissing`.

#### Scenario: Discovery never installs

- **GIVEN** a configured package whose `installedPath` is undefined because it is not installed
- **WHEN** the discovery index is built
- **THEN** no install, clone, pull or network call SHALL be made
- **AND** that package SHALL contribute no entries

### Requirement: Package discovery SHALL be built lazily, cached, and rebuilt on reload

The extension SHALL NOT build the index in `activate(pi)`, because the factory receives no `cwd`. It SHALL build it lazily from a `cwd`: in the `resources_discover` handler (fired on `startup` and `reload`, using the event's `cwd`) and, as a fallback, on the first `Agent` spawn (using `ctx.cwd`). It SHALL rebuild on every `resources_discover` and when `cwd` differs from the cwd the cached index was built for.

#### Scenario: Index is not built at activation

- **GIVEN** the extension's `activate(pi)` has run but no `resources_discover` event has fired and no spawn has occurred
- **WHEN** `activate` completes
- **THEN** the extension SHALL NOT have called `SettingsManager.create` / `DefaultPackageManager` (no `cwd` is available at activation)
- **AND** tool registration SHALL still have succeeded

#### Scenario: Index is built once and reused

- **GIVEN** the index has been built from a context
- **WHEN** multiple `Agent` tool calls resolve package-tier agents at the same `cwd`
- **THEN** each resolution SHALL consult the cached in-memory index
- **AND** no additional per-package filesystem scan SHALL occur per call

#### Scenario: Index builds on first spawn when no lifecycle event fired

- **GIVEN** the host never fires `resources_discover` AND the index is unbuilt
- **WHEN** the first `Agent` tool call runs with `ctx`
- **THEN** the index SHALL be built from `ctx.cwd` before resolution

#### Scenario: Index rebuilds on reload

- **GIVEN** the index has been built AND a new package shipping `agents/x.md` is installed
- **WHEN** `resources_discover` fires with `reason: "reload"`
- **THEN** the index SHALL be rebuilt
- **AND** `x` SHALL become resolvable via the package tier without a full process restart

### Requirement: Per-spawn resolution SHALL read the cached index

The extension SHALL cache the built index keyed by `cwd` and reuse it for every package-tier resolution at that `cwd`. Per-spawn resolution SHALL NOT walk the filesystem across all packages on each call.

#### Scenario: Cwd change rebuilds the cache

- **GIVEN** the index was built for `/a`
- **WHEN** an `Agent` call runs with `ctx.cwd === "/b"`
- **THEN** the index SHALL be rebuilt for `/b` before resolution

### Requirement: Package-vs-package name collisions SHALL resolve deterministically

When two or more installed packages ship an agent `.md` with the same basename, the extension SHALL
scan packages in a stable order (ascending by package `source` string) and the first package to
define a given basename SHALL win. Later duplicates SHALL be dropped from the index. Each dropped
duplicate SHALL be logged to stderr naming both the winning and losing package sources and the
winning path.

#### Scenario: Deterministic winner on collision

- **GIVEN** packages `@acme/pkg` and `@corp/pkg` both ship `agents/reviewer.md`
- **WHEN** the discovery index is built
- **THEN** the entry for `"reviewer"` SHALL come from `@acme/pkg` (lexicographically-smaller source)
- **AND** the `@corp/pkg` duplicate SHALL be dropped
- **AND** a warning SHALL be logged to stderr naming both `@acme/pkg` and `@corp/pkg`
- **AND** the winner SHALL be identical across repeated builds

### Requirement: Package discovery SHALL degrade safely and never break higher tiers

Any failure in the discovery step SHALL degrade to an empty index and SHALL NOT throw
(package-manager construction failure, unreadable directory, settings errors, or a throw from
`listConfiguredPackages()`). The project, user, and bundled resolution tiers SHALL
continue to function even when package discovery fails entirely.

#### Scenario: Discovery failure yields empty index, higher tiers still work

- **GIVEN** constructing the package manager throws (e.g. settings cannot be read)
- **WHEN** the discovery index is built
- **THEN** the index SHALL be empty
- **AND** no error SHALL propagate to the caller (activation, event handler, or spawn)
- **AND** `resolveAgentMdPath` SHALL still resolve project, user, and bundled agents normally

#### Scenario: listConfiguredPackages throwing mid-iteration is contained

- **GIVEN** `listConfiguredPackages()` throws during enumeration (e.g. a settings read error)
- **WHEN** the discovery index is built
- **THEN** the throw SHALL be caught
- **AND** the index SHALL be empty
- **AND** no error SHALL propagate

### Requirement: Package discovery SHALL be user-scope-only and SHALL surface provenance

Discovery SHALL scan ONLY packages with `scope === "user"` (installed into `<agentDir>` by the operator). Project-scoped packages SHALL NOT be indexed for agents, regardless of trust state. This is a deliberate choice, not an SDK limitation: skipping them closes the untrusted-checkout injection surface without reasoning about trust. A future opt-in MAY gate project scope on `ExtensionContext.isProjectTrusted()`.

#### Scenario: Project-scoped package agents are never discovered

- **GIVEN** a project-scoped local package declares `agents/pwn.md`
- **WHEN** the discovery index is built
- **THEN** `pwn` SHALL NOT be registered in the index
- **AND** `Agent({ subagent_type: "pwn" })` SHALL NOT spawn a package-sourced agent

#### Scenario: User-scoped package agents are discovered

- **GIVEN** a user-scoped package (installed under `<agentDir>`) ships `agents/reviewer.md`
- **WHEN** the discovery index is built
- **THEN** `reviewer` SHALL be registered with `source: "package"`

#### Scenario: Operator shadows a package agent locally

- **GIVEN** an installed package provides `reviewer` via the package tier
- **WHEN** the operator creates `<cwd>/.pi/agents/reviewer.md`
- **THEN** `resolveAgentMdPath("reviewer", cwd)` SHALL return `source: "project"`
- **AND** the package-tier definition SHALL NOT be used

### Requirement: Package-sourced agents SHALL carry provenance and be shadowable

A package-sourced agent SHALL carry `source: "package"` and the originating package `source` string through to `AgentDetails` (`agentMdSource`, `agentMdPkg`). The operator SHALL be able to shadow any package agent by placing a project- or user-tier `.md` of the same name.

#### Scenario: Provenance reaches AgentDetails

- **GIVEN** an agent resolved from package `@acme/pi-reviewers`
- **WHEN** `AgentDetails` is built
- **THEN** `details.agentMdSource` SHALL be `"package"`
- **AND** `details.agentMdPkg` SHALL be `"@acme/pi-reviewers"`
