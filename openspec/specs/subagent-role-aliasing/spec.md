# subagent-role-aliasing Specification

## Purpose
TBD - created by archiving change add-agent-md-frontmatter-and-bundled-explore. Update Purpose after archive.
## Requirements
### Requirement: `@role` syntax in frontmatter `model:` field SHALL be resolved via event bus

When frontmatter `model:` starts with `"@"`, the extension SHALL resolve it by emitting
`role:resolve-model` on `pi.events` with a probe object containing `{ ref: modelString }`.
The handler (provided by the roles-plugin bridge companion change) SHALL fill
`probe.resolved` with the literal `"provider/model-id"` string. The extension SHALL then
resolve that string to a Model object via the model registry.

#### Scenario: @role resolved to literal model

- **GIVEN** frontmatter `model: "@fast"` AND the roles-plugin bridge is loaded
- **WHEN** `runAgentTool` resolves the model
- **THEN** `pi.events.emit("role:resolve-model", { ref: "@fast" })` SHALL be called
- **AND** `probe.resolved` SHALL contain a literal model string (e.g., `"opencode-go/deepseek-v4-flash"`)
- **AND** that string SHALL be parsed as `provider/model-id` and resolved via `modelRegistry.find()`
- **AND** the resulting Model object SHALL be passed to `createAgentSession({ model })`

#### Scenario: @role resolution returns undefined (unknown role)

- **GIVEN** frontmatter `model: "@unknownrole"` AND the roles-plugin bridge is loaded
- **WHEN** `runAgentTool` resolves the model
- **THEN** `probe.resolved` SHALL be `undefined` (role not in providers.json)
- **AND** the tool call SHALL fail with `isError: true`
- **AND** the error message SHALL name the unresolved role `"@unknownrole"`
- **AND** the error message SHALL list the available role names from providers.json when readable

#### Scenario: @role used but handler not registered (roles-plugin bridge absent)

- **GIVEN** frontmatter `model: "@fast"` AND `pi.events.emit("role:resolve-model", probe)` leaves `probe.resolved` undefined (no handler registered)
- **WHEN** `runAgentTool` resolves the model
- **THEN** the tool call SHALL fail with `isError: true`
- **AND** the error message SHALL indicate that role resolution requires the roles-plugin bridge
- **AND** the error message SHALL include the path to the .md file that has the `@role` reference
- **AND** the error message SHALL suggest using a literal model id as an alternative

### Requirement: Non-`@` model references SHALL pass through without event bus probe

When frontmatter `model:` does NOT start with `"@"`, the extension SHALL NOT emit
`role:resolve-model`. The string SHALL be treated as a literal model reference.

#### Scenario: Literal model skips role probe

- **GIVEN** frontmatter `model: "anthropic/claude-opus-4-7"`
- **WHEN** `runAgentTool` resolves the model
- **THEN** `pi.events.emit("role:resolve-model", ...)` SHALL NOT be called
- **AND** the string SHALL be parsed directly as `provider/model-id`
- **AND** the resolved Model object SHALL be passed to `createAgentSession`

#### Scenario: Model with thinking suffix skips role probe

- **GIVEN** frontmatter `model: "claude-haiku-4-5:high"`
- **WHEN** `runAgentTool` resolves the model
- **THEN** the `:` SHALL be parsed as a thinking-level suffix, not a role prefix
- **AND** `pi.events.emit("role:resolve-model", ...)` SHALL NOT be called

### Requirement: @role resolution SHALL work without any dependency on pi-flows

The `@role` resolution mechanism SHALL NOT import from or require pi-flows to be loaded.
The resolution is provided by the roles-plugin bridge (dashboard companion change) which
reads `~/.pi/agent/providers.json` directly.

#### Scenario: @role resolution works without pi-flows

- **GIVEN** pi-flows is NOT in the extension packages list AND the roles-plugin bridge IS loaded
- **WHEN** a subagent with `model: "@fast"` is spawned
- **THEN** the role SHALL be resolved via `role:resolve-model`
- **AND** the spawn SHALL succeed

### Requirement: The event name `role:resolve-model` SHALL be documented

The extension's README SHALL document the `role:resolve-model` event bus convention so
other extension authors can use it. The documentation SHALL include the probe shape
(`{ ref: string }`) and the response shape (`probe.resolved: string | undefined`).

#### Scenario: Convention is discoverable in documentation

- **WHEN** a developer reads the README sections on frontmatter and role aliasing
- **THEN** they SHALL find the `role:resolve-model` event name, the probe contract, and
  a 3-line code example showing how to resolve a role from any pi extension

