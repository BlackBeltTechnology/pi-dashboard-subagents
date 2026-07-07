# package-agent-discovery Specification

## Purpose
TBD - created by archiving change add-package-agent-discovery-tier. Update Purpose after archive.
## Requirements
### Requirement: The extension SHALL discover agents shipped by installed pi packages

The extension SHALL scan every installed pi package for an `agents/` directory and register
each `*.md` file found there as a spawnable agent type, keyed by the file's basename
(`reviewer.md` → type `reviewer`). Discovery SHALL use `PackageManager.listConfiguredPackages()`
to enumerate packages and SHALL scan `<installedPath>/agents/*.md` for each package that has a
defined `installedPath`.

Discovery SHALL be a passive read only. It SHALL NOT trigger a package install, clone, pull, or
any network activity (i.e. it SHALL NOT call `PackageManager.resolve()` with an installing
`onMissing`).

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

### Requirement: Package discovery SHALL be built lazily, cached, and rebuilt on reload

The extension SHALL NOT build the index at `activate(pi)` (the extension factory receives no `cwd`).
It SHALL build the index lazily from an `ExtensionContext` — from the `resources_discover` handler's
`ctx`/event (on `reason` `"startup"` or `"reload"`) and/or on the first `Agent` spawn's `ctx` — using
`cwd` (there is no trust signal to read — see the user-scope-only requirement). It SHALL cache the result (keyed by `cwd`) and reuse it for
per-spawn resolution, which SHALL NOT walk the filesystem across all packages on each call. It SHALL
rebuild when `cwd` changes or on `resources_discover` `reason: "reload"`.

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

Discovery SHALL scan ONLY packages with `scope === "user"` (installed into `<agentDir>` by the
operator). Project-scoped packages SHALL NOT be indexed for agents, regardless of any trust state.
The rationale is an SDK constraint: the installed `@earendil-works/pi-coding-agent` exposes no
project-trust signal to extensions (`ExtensionContext` has no `isProjectTrusted()`,
`SettingsManager.create(cwd, agentDir?)` takes no trust option, and `listConfiguredPackages()`
performs no trust assert), so trust cannot be read to gate project scope. User-scope-only is
strictly more conservative than a trust gate and closes the untrusted-checkout injection surface
entirely.

Provenance SHALL be surfaced: a package-sourced agent SHALL carry `source: "package"` and the
originating package `source` string through to `AgentDetails`, and the operator SHALL be able to
shadow any package agent by placing a project- or user-tier `.md` of the same name.

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

