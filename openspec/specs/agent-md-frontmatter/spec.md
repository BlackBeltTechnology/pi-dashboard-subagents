# agent-md-frontmatter Specification

## Purpose
TBD - created by archiving change add-agent-md-frontmatter-and-bundled-explore. Update Purpose after archive.
## Requirements
### Requirement: The extension SHALL parse YAML frontmatter from resolved agent .md files

When `resolveAgentMdPath` returns a path, the extension SHALL read the file and parse its
YAML frontmatter using `parseFrontmatter` from `@earendil-works/pi-coding-agent/utils/frontmatter`.
The resulting config SHALL be a typed `AgentMdConfig` object with optional fields matching
the frontmatter schema.

#### Scenario: Successful frontmatter parse

- **WHEN** an agent .md file contains valid YAML frontmatter with `model`, `tools`, `prompt`, `inherit_context`, and `description` fields
- **THEN** `parseAgentMd(path)` SHALL return an `AgentMdConfig` with all five fields populated
- **AND** the `model` field SHALL contain the exact string from the frontmatter (e.g., `"anthropic/claude-haiku-4-5"`, `"@fast"`, or `"claude-haiku-4-5:high"`)

#### Scenario: Empty frontmatter returns undefined

- **WHEN** an agent .md file exists but has no YAML frontmatter (no `---` delimiters, or empty between them)
- **THEN** `parseAgentMd(path)` SHALL return `undefined`
- **AND** the subagent SHALL spawn with current defaults (parent model, all tools, pi's system prompt, global inheritContext)

#### Scenario: Malformed YAML frontmatter logs warning and returns undefined

- **WHEN** an agent .md file has malformed YAML between `---` delimiters
- **THEN** `parseAgentMd(path)` SHALL catch the error, log a warning, and return `undefined`
- **AND** the subagent SHALL spawn with current defaults

#### Scenario: Missing .md file returns undefined

- **WHEN** `resolveAgentMdPath` returns `undefined` (no matching .md at any tier)
- **THEN** `parseAgentMd` SHALL NOT be called
- **AND** the subagent SHALL spawn with current defaults

### Requirement: Frontmatter `model` field SHALL drive subagent model selection

When `AgentMdConfig.model` is a non-empty string AND no tool-call argument overrides it, the extension SHALL resolve it to a concrete Model and pass it to `createAgentSession({ model, thinkingLevel })`. When absent or empty AND no tool-call override is given, the extension SHALL NOT pass a model override (parent defaults apply).

The `model` value SHALL accept three input forms transparently (`@role`, `provider/model[:thinking]`, bare `model-id`) — exact contract documented in the `subagent-role-aliasing` capability.

**Precedence (highest wins):** `args.model > agentConfig.model > pi default (settings.json)`. When the tool-call `args.model` is a non-empty string, it SHALL be used and `agentConfig.model` SHALL be ignored. When `args.model` is absent and `agentConfig.model` is present, the frontmatter path applies. When both are absent, no model override is passed and the parent default applies.

The thinking-level suffix (when present) SHALL be parsed before any registry lookup and the resulting level SHALL be passed to `createAgentSession` separately from the Model object. Suffix parsing happens consistently whether the ref came from the tool call or the frontmatter.

When resolution fails (handler returns error, or fallback can't match the ref), the tool call SHALL fail with `isError: true` and an error message that:

- Names the unresolvable ref.
- Includes the source of the ref (the agent .md file path when from frontmatter; a synthetic label such as `(tool-call argument)` when from `args.model`).
- Distinguishes "role unknown" vs "model unknown" vs "no resolver available" so the operator knows which fix to apply.

#### Scenario: Literal `provider/model` reference passed through

- **GIVEN** frontmatter `model: "anthropic/claude-opus-4-7"` AND `args.model` is undefined
- **WHEN** the subagent is spawned
- **THEN** the extension SHALL emit `model:resolve` with `probe.ref === "anthropic/claude-opus-4-7"`
- **AND** if a handler resolves it, `createAgentSession` SHALL be called with the resulting Model
- **AND** if no handler reacts, the extension SHALL call `pi.modelRegistry.find("anthropic", "claude-opus-4-7")` and pass that Model to `createAgentSession`
- **AND** `details.modelName` SHALL reflect the resolved model id

#### Scenario: Bare model id resolved via "like" query

- **GIVEN** frontmatter `model: "claude-haiku-4-5"` (no `/`, no `@`) AND `args.model` is undefined
- **WHEN** the subagent is spawned
- **THEN** the extension SHALL emit `model:resolve` with `probe.ref === "claude-haiku-4-5"`
- **AND** if no handler reacts, the extension SHALL call `pi.modelRegistry.getAll().find(m => m.id === "claude-haiku-4-5")`
- **AND** the first matching Model in registry iteration order SHALL be passed to `createAgentSession`
- **AND** if two providers expose the same `id`, the first registry hit wins (operator should disambiguate with `provider/model` form)

#### Scenario: Role alias resolved via event handler

- **GIVEN** frontmatter `model: "@fast"` AND `args.model` is undefined AND a `model:resolve` handler is registered
- **WHEN** the subagent is spawned
- **THEN** the extension SHALL emit `model:resolve` and the handler SHALL fill `probe.model`
- **AND** `createAgentSession` SHALL receive that Model
- **AND** `details.modelName` SHALL reflect the canonical literal the role resolved to

#### Scenario: Role alias fails when no handler is registered

- **GIVEN** frontmatter `model: "@fast"` AND `args.model` is undefined AND NO `model:resolve` handler is registered
- **WHEN** the subagent is spawned
- **THEN** the in-process fallback SHALL NOT attempt to read `providers.json`
- **AND** the tool call SHALL fail with `isError: true`
- **AND** the error message SHALL state that `@role` resolution requires a handler
- **AND** the error message SHALL suggest installing pi-agent-dashboard or pi-flows
- **AND** the error message SHALL include the agent .md file path

#### Scenario: Model with thinking suffix parsed in both paths

- **GIVEN** frontmatter `model: "claude-haiku-4-5:high"` OR `args.model: "claude-haiku-4-5:high"`
- **WHEN** the extension resolves the model reference
- **THEN** the literal SHALL be parsed as `id="claude-haiku-4-5"`, `thinkingLevel="high"` before any registry lookup
- **AND** this parsing SHALL happen consistently whether the ref came from the tool call or the frontmatter

#### Scenario: Absent model field inherits parent default

- **GIVEN** frontmatter has no `model` field, or `model:` is empty
- **WHEN** the subagent is spawned
- **THEN** `createAgentSession` SHALL receive no `model` override AND no `thinkingLevel` override
- **AND** pi's default model resolution (settings.json defaults) SHALL apply

#### Scenario: Unknown bare model id reports actionable error

- **GIVEN** frontmatter `model: "made-up-model"` AND no registry entry matches
- **WHEN** the fallback runs (or the handler returns the same miss)
- **THEN** the tool call SHALL fail with `isError: true`
- **AND** the error message SHALL name the unresolved ref `"made-up-model"`
- **AND** the error message SHALL suggest the `provider/model` form or list available model ids as a hint
- **AND** the error message SHALL include the agent .md file path

### Requirement: Frontmatter `tools` field SHALL allowlist subagent tools

When `AgentMdConfig.tools` is a non-empty array, the extension SHALL call
`session.setActiveToolsByName(tools)` after session creation, restricting the subagent
to exactly the named tools. When absent or empty, all parent tools minus `Agent` are
active (unchanged).

#### Scenario: Tools allowlist applied

- **GIVEN** frontmatter `tools: ["read", "grep", "bash"]`
- **WHEN** the subagent session is created and configured
- **THEN** `session.setActiveToolsByName(["read", "grep", "bash"])` SHALL be called exactly once
- **AND** extension tools (`document_parse`, `mcp__pi__browser`, etc.) SHALL NOT be active
- **AND** the `Agent` tool SHALL remain deactivated (recursion prevention still applies)

#### Scenario: Absent tools field inherits all parent tools

- **GIVEN** frontmatter has no `tools` field
- **WHEN** the subagent session is created
- **THEN** the subagent SHALL have all active parent tools except `Agent`

### Requirement: Frontmatter `prompt` field (or the markdown body) SHALL prepend agent-specific instructions

When `AgentMdConfig.prompt` is a non-empty string, the extension SHALL prepend it as an
`<agent-prompt>` preamble before the parent-context-aware task text passed to
`session.prompt`. The `prompt:` field in YAML frontmatter takes precedence; when the field
is absent, the markdown body (the content AFTER the closing `---`) SHALL be used as the
prompt instead. This matches the convention used by pi-coding-agent's own prompt-template
and skill files: frontmatter holds metadata, body holds the content.

When both the `prompt:` field is absent AND the body is empty, no preamble is added.

#### Scenario: Explicit `prompt:` field wins over the body

- **GIVEN** frontmatter `prompt: |\n  Explicit wins.` AND a non-empty markdown body `"Body content."`
- **WHEN** the subagent's effective prompt is built
- **THEN** the preamble SHALL be `<agent-prompt>\nExplicit wins.\n</agent-prompt>`
- **AND** the body content SHALL NOT appear in the prompt

#### Scenario: Markdown body falls in as the prompt when no `prompt:` field is set

- **GIVEN** a `.md` with frontmatter (no `prompt:` field) AND body text `"You are an Explore subagent. Stay read-only."`
- **WHEN** the subagent's effective prompt is built
- **THEN** the preamble SHALL be `<agent-prompt>\nYou are an Explore subagent. Stay read-only.\n</agent-prompt>`

#### Scenario: A `.md` with no frontmatter block becomes a body-only prompt

- **GIVEN** a `.md` without any `---` frontmatter delimiters, containing only body text
- **WHEN** `parseAgentMd(path)` is called
- **THEN** the returned config SHALL have `prompt` set to the full file content (trimmed)
- **AND** every other field SHALL be undefined

#### Scenario: Absent prompt field AND empty body uses pi default

- **GIVEN** frontmatter with no `prompt:` field AND an empty markdown body
- **WHEN** the subagent is spawned
- **THEN** the effective prompt SHALL contain NO `<agent-prompt>` preamble
- **AND** the subagent SHALL receive only the parent-context prefix (if any) and the `<task>` block

### Requirement: Frontmatter `inherit_context` field SHALL override the global setting

When `AgentMdConfig.inherit_context` is a boolean, the extension SHALL use it to determine
whether the subagent inherits parent context, ignoring the global `inheritContext` setting.
When absent, the global setting applies.

#### Scenario: Per-agent override to isolated

- **GIVEN** global `inheritContext: true` and frontmatter `inherit_context: false`
- **WHEN** the subagent is spawned
- **THEN** `buildInheritedContext` SHALL receive `{ isolated: true }`
- **AND** the subagent SHALL start with an empty conversation

#### Scenario: Per-agent override to inherit

- **GIVEN** global `inheritContext: false` and frontmatter `inherit_context: true`
- **WHEN** the subagent is spawned
- **THEN** `buildInheritedContext` SHALL receive `{ isolated: false }`
- **AND** the subagent SHALL receive the compressed parent context prefix

#### Scenario: Absent inherit_context defers to global

- **GIVEN** frontmatter has no `inherit_context` field
- **WHEN** the subagent is spawned
- **THEN** the global `inheritContext` setting SHALL determine inheritance behavior

### Requirement: Frontmatter `description` field SHALL override display name

When `AgentMdConfig.description` is a non-empty string, the extension SHALL use it as
`details.displayName` on the AgentDetails payload. When absent, `details.displayName`
falls back to `subagent_type` (unchanged behavior).

#### Scenario: Description used as display name

- **GIVEN** frontmatter `description: "Fast codebase & paper exploration agent"`
- **WHEN** the AgentDetails payload is built
- **THEN** `details.displayName` SHALL be `"Fast codebase & paper exploration agent"`

#### Scenario: Absent description falls back

- **GIVEN** frontmatter has no `description` field
- **WHEN** the AgentDetails payload is built
- **THEN** `details.displayName` SHALL equal `args.subagent_type` (e.g., `"research"`)

