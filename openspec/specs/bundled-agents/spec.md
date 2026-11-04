# bundled-agents Specification

## Purpose
Defines the bundled tier of agent `.md` resolution: a directory inside this package that supplies agent definitions after the project and user tiers, and before package-shipped agents. Also defines the four-tier lookup order and the source metadata the dashboard card uses to show which tier supplied an agent. The package currently ships no bundled agents.

## Requirements

### Requirement: The package SHALL support a bundled agents directory and ship none by default

The bundled tier SHALL read agent definitions from `<extensionDir>/agents/<type>.md`, and the package's `"files"` list in `package.json` SHALL include `"agents/"` so such a directory is distributed when present. The package SHALL NOT currently ship any bundled agent file: the former bundled `Explore.md` was removed and is now provided by the dashboard as a project-level agent.

#### Scenario: Bundled file is resolved at tier 3

- **GIVEN** `<extensionDir>/agents/helper.md` exists AND no project or user `helper.md` exists
- **WHEN** `resolveAgentMdPath("helper", cwd)` is called
- **THEN** the result SHALL be `{ path: "<extensionDir>/agents/helper.md", source: "bundled" }`

#### Scenario: Missing bundled directory is tolerated

- **GIVEN** `<extensionDir>/agents/` does not exist
- **WHEN** `resolveAgentMdPath("Explore", cwd)` is called and no other tier has an `Explore.md`
- **THEN** the result SHALL be `undefined`
- **AND** no error SHALL be thrown

### Requirement: The extension directory SHALL be computed from import.meta.url

The bundled agents directory SHALL be resolved at module load time using
`import.meta.url` and Node's `fileURLToPath`. It SHALL NOT depend on `__dirname`,
`process.cwd()`, or any runtime state.

#### Scenario: Extension dir is stable across runs

- **WHEN** the extension module is loaded
- **THEN** the resolved `extensionDir` SHALL point to the directory containing the extension's `package.json`
- **AND** the bundled directory SHALL be `${extensionDir}/agents`
- **AND** the path SHALL be valid regardless of which directory pi was started from

### Requirement: The AgentDetails payload SHALL include the resolution source

When `resolveAgentMdPath` returns a non-undefined result, `details.agentMdPath` SHALL be set to the resolved path and `details.agentMdSource` SHALL carry the tier discriminator so the dashboard card can display it. When the source is `"package"`, `details.agentMdPkg` SHALL additionally carry the originating package's `source` string.

#### Scenario: Source discriminator in AgentDetails

- **GIVEN** the subagent was sourced from the bundled tier
- **WHEN** `AgentDetails` is built
- **THEN** `details.agentMdSource` SHALL be `"bundled"`
- **AND** `details.agentMdPkg` SHALL be undefined
- **AND** the dashboard card MAY render "<type> (bundled)" based on this field

#### Scenario: Package source discriminator in AgentDetails

- **GIVEN** the subagent was sourced from the package tier via `@acme/pi-reviewers`
- **WHEN** `AgentDetails` is built
- **THEN** `details.agentMdSource` SHALL be `"package"`
- **AND** `details.agentMdPkg` SHALL be `"@acme/pi-reviewers"`
- **AND** the dashboard card MAY render "reviewer (package: @acme/pi-reviewers)" based on these fields

### Requirement: Agent resolution SHALL use a four-tier fallback

The extension SHALL resolve agent .md files in four tiers, first match wins:
1. `<cwd>/.pi/agents/<type>.md` — project-local override
2. `<getAgentDir()>/agents/<type>.md` — user-global override
3. `<extensionDir>/agents/<type>.md` — bundled fallback (this package's own agents)
4. `<installedPath>/agents/<type>.md` — package fallback (any other installed pi package), via the cached package-agent discovery index

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

### Requirement: The resolution result SHALL carry a source discriminator

The result of `resolveAgentMdPath` SHALL include a `source` discriminator (`"project"`, `"user"`, `"bundled"`, or `"package"`) alongside the resolved path. When `source` is `"package"`, the result SHALL also carry the originating package's `source` string in the `pkg` field so the dashboard card can name the provider.

#### Scenario: Only package results carry pkg

- **WHEN** `resolveAgentMdPath` resolves a project, user or bundled agent
- **THEN** the result SHALL have the matching `source` and no `pkg` field
- **AND WHEN** it resolves a package agent
- **THEN** the result SHALL have `source: "package"` and `pkg` set

### Requirement: The package tier SHALL be consulted only after tiers 1-3 miss

The package tier (4) SHALL be consulted only when the project, user and bundled tiers all miss. No name that resolves via tiers 1-3 SHALL be shadowed by a package agent.

#### Scenario: A package cannot shadow a user agent

- **GIVEN** `<getAgentDir()>/agents/reviewer.md` exists AND a package also ships `agents/reviewer.md`
- **WHEN** `resolveAgentMdPath("reviewer", cwd)` is called
- **THEN** the result SHALL have `source: "user"`
