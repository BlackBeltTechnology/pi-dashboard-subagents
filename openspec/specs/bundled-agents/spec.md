# bundled-agents Specification

## Purpose
TBD - created by archiving change add-agent-md-frontmatter-and-bundled-explore. Update Purpose after archive.
## Requirements
### Requirement: Agent resolution SHALL use a three-tier fallback

The extension SHALL resolve agent .md files in three tiers, first match wins:
1. `<cwd>/.pi/agents/<type>.md` — project-local override
2. `<getAgentDir()>/agents/<type>.md` — user-global override
3. `<extensionDir>/agents/<type>.md` — bundled fallback

The result SHALL include a `source` discriminator (`"project"`, `"user"`, or `"bundled"`)
alongside the resolved path.

#### Scenario: Project-local override wins

- **GIVEN** `<cwd>/.pi/agents/Explore.md` exists AND `<extensionDir>/agents/Explore.md` exists
- **WHEN** `resolveAgentMdPath("Explore", cwd)` is called
- **THEN** the result SHALL be `{ path: "<cwd>/.pi/agents/Explore.md", source: "project" }`
- **AND** the user-global and bundled files SHALL NOT be checked (short-circuit on first match)

#### Scenario: User-global override when project is absent

- **GIVEN** `<cwd>/.pi/agents/Explore.md` does NOT exist AND `<getAgentDir()>/agents/Explore.md` exists
- **WHEN** `resolveAgentMdPath("Explore", cwd)` is called
- **THEN** the result SHALL be `{ path: "<getAgentDir()>/agents/Explore.md", source: "user" }`

#### Scenario: Bundled fallback when user tiers are absent

- **GIVEN** neither project nor user-global `Explore.md` exists AND `<extensionDir>/agents/Explore.md` exists
- **WHEN** `resolveAgentMdPath("Explore", cwd)` is called
- **THEN** the result SHALL be `{ path: "<extensionDir>/agents/Explore.md", source: "bundled" }`

#### Scenario: All tiers miss returns undefined

- **GIVEN** no `Explore.md` exists at any tier
- **WHEN** `resolveAgentMdPath("Explore", cwd)` is called
- **THEN** the result SHALL be `undefined`
- **AND** no error SHALL be thrown

#### Scenario: Path-traversal rejection still applies

- **GIVEN** `agentType` contains `"/"`, `"\\"`, or `".."`
- **WHEN** `resolveAgentMdPath` is called
- **THEN** the result SHALL be `undefined` before any filesystem access

### Requirement: The extension SHALL ship a bundled `Explore.md` agent

The package SHALL include `agents/Explore.md` in its npm distribution (`"files"` in
package.json MUST include `"agents/"`). The file SHALL be a valid Markdown file with
YAML frontmatter.

#### Scenario: Explore.md is discoverable via the bundled tier

- **GIVEN** the extension is installed and activated
- **WHEN** the LLM invokes `Agent({ subagent_type: "Explore", ... })` and no project or user-level `Explore.md` exists
- **THEN** `resolveAgentMdPath("Explore", cwd)` SHALL return `{ path: "<extensionDir>/agents/Explore.md", source: "bundled" }`

### Requirement: The bundled Explore agent SHALL use a literal model reference

The bundled `Explore.md` SHALL specify `model:` as a literal `"provider/model-id"` string
(not `@role`). This ensures the bundled agent works standalone without the roles-plugin
bridge or pi-flows.

#### Scenario: Bundled Explore works without role infrastructure

- **GIVEN** the roles-plugin bridge is NOT loaded and pi-flows is NOT loaded
- **WHEN** the bundled Explore agent is spawned
- **THEN** the model SHALL resolve from the literal value in the frontmatter
- **AND** no `@role` resolution SHALL be attempted
- **AND** the spawn SHALL succeed (assuming the model is authenticated)

#### Scenario: Power user overrides bundled model to @role

- **GIVEN** the user has copied the bundled `Explore.md` to `<getAgentDir()>/agents/Explore.md` and changed `model:` to `@fast`
- **WHEN** an Explore subagent is spawned
- **THEN** the user-global override SHALL win (tier 2)
- **AND** the `@fast` role SHALL be resolved via `role:resolve-model`
- **AND** the original bundled model SHALL NOT be used

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

#### Scenario: Source discriminator in AgentDetails

- **GIVEN** the subagent was sourced from the bundled tier
- **WHEN** `AgentDetails` is built
- **THEN** the structure accessible from `details` SHALL include the `source` field from
  `resolveAgentMdPath`'s return value
- **AND** the dashboard card MAY render "Explore (bundled)" based on this field

