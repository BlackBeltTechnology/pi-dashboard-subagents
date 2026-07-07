## MODIFIED Requirements

### Requirement: Agent resolution SHALL use a four-tier fallback

The extension SHALL resolve agent .md files in four tiers, first match wins:
1. `<cwd>/.pi/agents/<type>.md` — project-local override
2. `<getAgentDir()>/agents/<type>.md` — user-global override
3. `<extensionDir>/agents/<type>.md` — bundled fallback (this package's own agents)
4. `<installedPath>/agents/<type>.md` — package fallback (any other installed pi package), resolved via the cached package-agent discovery index

The result SHALL include a `source` discriminator (`"project"`, `"user"`, `"bundled"`, or `"package"`)
alongside the resolved path. When `source` is `"package"`, the result SHALL also carry the
originating package's `source` string (the `pkg` field) so the dashboard card can name the provider.

The package tier (4) SHALL be consulted only when tiers 1–3 all miss. No name that resolves via
tiers 1–3 SHALL be shadowed by a package agent.

#### Scenario: Project-local override wins over all lower tiers

- **GIVEN** `<cwd>/.pi/agents/reviewer.md` exists AND a package also ships `agents/reviewer.md`
- **WHEN** `resolveAgentMdPath("reviewer", cwd)` is called
- **THEN** the result SHALL be `{ path: "<cwd>/.pi/agents/reviewer.md", source: "project" }`
- **AND** the user, bundled, and package tiers SHALL NOT be checked (short-circuit on first match)

#### Scenario: Bundled wins over package for the same name

- **GIVEN** neither project nor user `reviewer.md` exists AND `<extensionDir>/agents/reviewer.md` exists AND a package also ships `agents/reviewer.md`
- **WHEN** `resolveAgentMdPath("reviewer", cwd)` is called
- **THEN** the result SHALL be `{ path: "<extensionDir>/agents/reviewer.md", source: "bundled" }`
- **AND** the package tier SHALL NOT be consulted

#### Scenario: Package fallback when all higher tiers miss

- **GIVEN** no `reviewer.md` exists at the project, user, or bundled tiers AND an installed package ships `<installedPath>/agents/reviewer.md`
- **WHEN** `resolveAgentMdPath("reviewer", cwd)` is called
- **THEN** the result SHALL be `{ path: "<installedPath>/agents/reviewer.md", source: "package", pkg: "<package source string>" }`

#### Scenario: All four tiers miss returns undefined

- **GIVEN** no `reviewer.md` exists at any tier and no package provides it
- **WHEN** `resolveAgentMdPath("reviewer", cwd)` is called
- **THEN** the result SHALL be `undefined`
- **AND** no error SHALL be thrown

#### Scenario: Path-traversal rejection still applies before any tier

- **GIVEN** `agentType` contains `"/"`, `"\\"`, or `".."`
- **WHEN** `resolveAgentMdPath` is called
- **THEN** the result SHALL be `undefined` before any filesystem access or package-index lookup

### Requirement: The AgentDetails payload SHALL include the resolution source

When `resolveAgentMdPath` returns a non-undefined result, `details.agentMdPath` SHALL
include the resolution source discriminator so the dashboard card can display the tier.
When the source is `"package"`, the payload SHALL additionally carry the originating
package's `source` string.

#### Scenario: Source discriminator in AgentDetails

- **GIVEN** the subagent was sourced from the bundled tier
- **WHEN** `AgentDetails` is built
- **THEN** the structure accessible from `details` SHALL include the `source` field from
  `resolveAgentMdPath`'s return value
- **AND** the dashboard card MAY render "Explore (bundled)" based on this field

#### Scenario: Package source discriminator in AgentDetails

- **GIVEN** the subagent was sourced from the package tier via `@acme/pi-reviewers`
- **WHEN** `AgentDetails` is built
- **THEN** the structure accessible from `details` SHALL include `source: "package"`
- **AND** it SHALL include the originating package source string (e.g. `pkg: "@acme/pi-reviewers"`)
- **AND** the dashboard card MAY render "reviewer (package: @acme/pi-reviewers)" based on these fields
