# Spec Delta

## MODIFIED Requirements

### Requirement: Package discovery SHALL be built lazily, cached, and rebuilt on reload

The extension SHALL NOT build the index in `activate(pi)`, because the factory receives no `cwd`. It SHALL build it lazily from a `cwd`: in the `resources_discover` handler (fired on `startup` and `reload`, using the event's `cwd`) and, as a fallback, on the first `Agent` spawn for a cwd with no cached entry. Every `resources_discover` SHALL drop all cached entries and rebuild the entry for the event's `cwd`.

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
- **THEN** the index SHALL be built from the subagent's resolved cwd before resolution

#### Scenario: Index rebuilds on reload

- **GIVEN** indexes are cached for `/repo` and `/repo/.worktrees/x` AND a new package shipping `agents/x.md` is installed
- **WHEN** `resources_discover` fires with `reason: "reload"`
- **THEN** all cached entries SHALL be dropped and the entry for the event's cwd rebuilt
- **AND** `x` SHALL become resolvable via the package tier at either cwd without a full process restart

### Requirement: Per-spawn resolution SHALL read the cached index

The extension SHALL cache built indexes keyed by `cwd`, holding up to 8 cwds and evicting the least recently used. It SHALL reuse the entry for every package-tier resolution at that `cwd`. Per-spawn resolution SHALL NOT walk the filesystem across all packages on each call.

#### Scenario: Cwd change rebuilds the cache

- **GIVEN** the index was built for `/a`
- **WHEN** an `Agent` call resolves for cwd `/b`
- **THEN** an index SHALL be built for `/b` before resolution
- **AND** the `/a` entry SHALL stay cached

#### Scenario: Alternating sibling cwds do not rebuild

- **GIVEN** indexes are cached for `/repo` and `/repo/.worktrees/x`
- **WHEN** `Agent` calls alternate between those two cwds
- **THEN** no index SHALL be rebuilt
