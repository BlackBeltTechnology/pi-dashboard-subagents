# bundled-agents Specification

## Purpose
TBD - created by archiving change add-agent-md-frontmatter-and-bundled-explore. Update Purpose after archive.
## Requirements
### Requirement: The extension SHALL ship a bundled `Explore.md` agent

The package SHALL include `agents/Explore.md` in its npm distribution (`"files"` in
package.json MUST include `"agents/"`). The file SHALL be a valid Markdown file with
YAML frontmatter.

#### Scenario: Explore.md is discoverable via the bundled tier

- **GIVEN** the extension is installed and activated
- **WHEN** the LLM invokes `Agent({ subagent_type: "Explore", ... })` and no project or user-level `Explore.md` exists
- **THEN** `resolveAgentMdPath("Explore", cwd)` SHALL return `{ path: "<extensionDir>/agents/Explore.md", source: "bundled" }`

### Requirement: The bundled Explore agent SHALL use a role alias for its model

The bundled `Explore.md` SHALL specify `model:` as the role alias `"@fast"`. Operators
pick the actual model behind `@fast` via the dashboard's roles plugin (Settings → Roles),
which edits `~/.pi/agent/providers.json` — the same store consulted by the `model:resolve`
event-bus handler that pi-agent-dashboard (or pi-flows) registers on `pi.events`.

This intentionally makes the bundled Explore dependent on a registered `model:resolve`
handler: model choice is operator-controlled at runtime, not baked into the shipped file.
The in-process fallback does NOT resolve `@role` (that requires reading `providers.json`),
so `@fast` fails cleanly when no handler is present.

#### Scenario: Bundled Explore resolves @fast through a model:resolve handler

- **GIVEN** a `model:resolve` handler is registered and `~/.pi/agent/providers.json#roles.fast` is assigned (e.g. `"anthropic/claude-haiku-4-5"`)
- **WHEN** the bundled Explore agent is spawned
- **THEN** `pi.events.emit("model:resolve", probe)` SHALL be called with `probe.ref === "@fast"`
- **AND** after the emit returns, the handler SHALL have filled `probe.model` with a Model object
- **AND** `probe.resolved` SHALL be the canonical `"provider/model-id"` literal the role resolved to
- **AND** that Model SHALL be passed to `createAgentSession({ model, thinkingLevel })`

#### Scenario: Bundled Explore hard-fails when no model:resolve handler is registered

- **GIVEN** NO `model:resolve` handler is registered on `pi.events` (silent emit)
- **WHEN** the bundled Explore agent is spawned
- **THEN** the in-process fallback SHALL NOT attempt to read `~/.pi/agent/providers.json`
- **AND** the tool call SHALL return `isError: true`
- **AND** the error message SHALL name `"@fast"` and the resolved Explore.md path
- **AND** the error message SHALL state that `@role` resolution requires a `model:resolve` handler
- **AND** the error message SHALL suggest installing pi-agent-dashboard or pi-flows OR overriding the bundled file with a literal model reference (per the override mechanic below)

#### Scenario: Operator overrides @fast to a literal model id via user-global tier

- **GIVEN** the user has copied the bundled `Explore.md` to `<getAgentDir()>/agents/Explore.md` and changed `model:` to a literal `"provider/model-id"`
- **WHEN** an Explore subagent is spawned
- **THEN** the user-global override SHALL win (tier 2)
- **AND** the literal SHALL be resolved via the `model:resolve` handler when present, or via the in-process `pi.modelRegistry` fallback when no handler is registered
- **AND** the spawn SHALL succeed without any `model:resolve` handler being registered

### Requirement: The bundled Explore SHALL have a read-only tool set

The shipped `Explore.md` SHALL specify `tools:` as a restrictive allowlist of read-only
tool names. It SHALL NOT include write, edit, or any mutation-capable tools.

#### Scenario: Explore tools are read-only

- **WHEN** the bundled Explore agent frontmatter is parsed
- **THEN** `AgentMdConfig.tools` SHALL be a non-empty array
- **AND** the array SHALL NOT contain `"edit"`, `"write"`, `"Agent"`, or any tool that modifies files or spawns processes
- **AND** the array SHALL include `"read"` as a minimum

### Requirement: The bundled Explore SHALL set `inherit_context: false`

The shipped `Explore.md` SHALL set `inherit_context: false` so the subagent starts with
a fresh, empty conversation rather than inheriting the parent's potentially large and
distracting context.

#### Scenario: Explore is isolated from parent context

- **WHEN** the bundled Explore agent is spawned with default settings
- **THEN** `buildInheritedContext` SHALL receive `{ isolated: true }` regardless of the global `inheritContext` setting
- **AND** the subagent's prompt SHALL NOT contain a `<parent-context>` prefix

### Requirement: The extension directory SHALL be computed from import.meta.url

The bundled agents directory SHALL be resolved at module load time using
`import.meta.url` and Node's `fileURLToPath`. It SHALL NOT depend on `__dirname`,
`process.cwd()`, or any runtime state.

#### Scenario: Extension dir is stable across runs

- **WHEN** the extension module is loaded
- **THEN** the resolved `extensionDir` SHALL point to the directory containing the extension's `package.json`
- **AND** `agents/Explore.md` SHALL be found at `${extensionDir}/agents/Explore.md`
- **AND** the path SHALL be valid regardless of which directory pi was started from

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

