# agent-md-frontmatter Specification

## Purpose
Lets an agent `.md` file configure the subagent spawned for its type: the model, the tool allowlist, a prompt preamble, context inheritance and the card's display name, all read from YAML frontmatter and the markdown body. Every field is optional; an absent field leaves the pre-frontmatter default in place.
## Requirements
### Requirement: The extension SHALL parse YAML frontmatter from resolved agent .md files

When `resolveAgentMdPath` returns a path, the extension SHALL read the file and parse its
YAML frontmatter using `parseFrontmatter` exported by `@earendil-works/pi-coding-agent`.
The resulting config SHALL be a typed `AgentMdConfig` object with optional fields matching
the frontmatter schema.

#### Scenario: Successful frontmatter parse

- **WHEN** an agent .md file contains valid YAML frontmatter with `model`, `tools`, `prompt`, `inherit_context`, and `description` fields
- **THEN** `parseAgentMd(path)` SHALL return an `AgentMdConfig` with all five fields populated
- **AND** the `model` field SHALL contain the exact string from the frontmatter (e.g., `"anthropic/claude-haiku-4-5"`, `"@fast"`, or `"claude-haiku-4-5:high"`)

#### Scenario: Empty frontmatter returns undefined

- **WHEN** an agent .md file exists but yields no honoured field and has an empty markdown body (no `---` delimiters or empty between them, and no content after them)
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

When `AgentMdConfig.model` is a non-empty string and no tool-call `model` argument overrides it, the extension SHALL resolve it to a concrete Model and pass it to `createAgentSession` as `model`. The value SHALL accept `@role`, `provider/model[:thinking]` and bare `model-id` (contract in capability `subagent-role-aliasing`). A thinking-level suffix SHALL be parsed before any registry lookup and passed separately as `thinkingLevel`, whether the ref came from the tool call or the frontmatter.

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

- **GIVEN** frontmatter has no `model` field, or `model:` is empty, AND `args.model` is undefined
- **WHEN** the subagent is spawned
- **THEN** `resolveModelFromRef` SHALL NOT be called
- **AND** `createAgentSession` SHALL receive the parent session's live model (`ctx.model`) as `model`
- **AND** `thinkingLevel` SHALL come from the parent's live level, not from the settings default

#### Scenario: Unknown bare model id reports actionable error

- **GIVEN** frontmatter `model: "made-up-model"` AND no registry entry matches
- **WHEN** the fallback runs (or the handler returns the same miss)
- **THEN** the tool call SHALL fail with `isError: true`
- **AND** the error message SHALL name the unresolved ref `"made-up-model"`
- **AND** the error message SHALL suggest the `provider/model` form or list available model ids as a hint
- **AND** the error message SHALL include the agent .md file path

### Requirement: Subagent model SHALL follow a fixed precedence chain

The effective model SHALL be chosen by precedence (highest wins): tool-call `args.model` > frontmatter `model:` > the parent session's live model (`ctx.model`) > the SDK default (settings `defaultModel`). Empty or whitespace-only values SHALL count as absent. When no ref is given, the extension SHALL pass `ctx.model` as `model`; it SHALL omit the `model` key only when no parent live model exists, so the SDK default applies.

#### Scenario: Tool-call model overrides frontmatter

- **GIVEN** frontmatter `model: "@coding"` AND `args.model: "@fast"`
- **WHEN** the subagent is spawned
- **THEN** only `"@fast"` SHALL be resolved
- **AND** `"@coding"` SHALL be ignored

#### Scenario: No ref uses the parent's live model

- **GIVEN** no `args.model`, no frontmatter `model`, and the parent session runs model M
- **WHEN** the subagent is spawned
- **THEN** `createAgentSession` SHALL receive `model: M`

#### Scenario: No parent model leaves the SDK default

- **GIVEN** no `args.model`, no frontmatter `model`, and `ctx.model` is undefined
- **WHEN** the subagent is spawned
- **THEN** `createAgentSession` SHALL receive no `model` key
- **AND** the SDK default model (settings `defaultModel`) SHALL apply

### Requirement: Model resolution failure SHALL fail the tool call with an actionable error

When resolution fails (the handler returns an error, or the fallback cannot match the ref), the tool call SHALL fail with `isError: true`. The message SHALL name the unresolvable ref, include the source of the ref, and distinguish "role unknown", "model unknown" and "no resolver available" so the operator knows which fix to apply. The extension SHALL NOT fall back to the parent's model after a failed explicit ref.

#### Scenario: Source label names where the ref came from

- **GIVEN** an unresolvable ref
- **WHEN** the ref came from frontmatter
- **THEN** the error SHALL include the agent .md file path
- **AND WHEN** the ref came from `args.model`
- **THEN** the error SHALL include the synthetic label `(tool-call argument)`

### Requirement: Frontmatter `tools` field SHALL allowlist subagent tools

When `AgentMdConfig.tools` is a non-empty array, the extension SHALL call
`session.setActiveToolsByName` after session creation with the intersection of that
allowlist and the session's active tools minus `Agent`, so names the session does not
have are silently dropped. When absent or empty, all parent tools minus `Agent` are
active (unchanged).

#### Scenario: Tools allowlist applied

- **GIVEN** frontmatter `tools: ["read", "grep", "bash"]`
- **WHEN** the subagent session is created and configured
- **THEN** `session.setActiveToolsByName(["read", "grep", "bash"])` SHALL be called exactly once (when the session has all three tools)
- **AND** extension tools (`document_parse`, `mcp__pi__browser`, etc.) SHALL NOT be active
- **AND** the `Agent` tool SHALL remain deactivated (recursion prevention still applies)

#### Scenario: Unknown allowlist names are dropped

- **GIVEN** frontmatter `tools: ["read", "no_such_tool"]`
- **WHEN** the subagent session is created and configured
- **THEN** only `"read"` SHALL be active
- **AND** the spawn SHALL NOT fail

#### Scenario: Absent tools field inherits all parent tools

- **GIVEN** frontmatter has no `tools` field
- **WHEN** the subagent session is created
- **THEN** the subagent SHALL have all active parent tools except `Agent`

### Requirement: Frontmatter `prompt` field (or the markdown body) SHALL prepend agent-specific instructions

When `AgentMdConfig.prompt` is a non-empty string, the extension SHALL wrap it in an `<agent-prompt>` preamble placed after the parent-context prefix (if any) and before the `<task>` block passed to `session.prompt`. The `prompt:` frontmatter field takes precedence; when it is absent, the markdown body (the content after the closing `---`) SHALL be used as the prompt.

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

#### Scenario: Preamble order is parent context, agent prompt, task

- **GIVEN** inheritance is on, a parent-context prefix exists, and the `.md` has a prompt
- **WHEN** the subagent's effective prompt is built
- **THEN** the sections SHALL appear in the order `<parent-context>`, `<agent-prompt>`, `<task>`

### Requirement: A missing prompt and an empty body SHALL add no preamble

When the `prompt:` field is absent AND the markdown body is empty, the extension SHALL NOT add an `<agent-prompt>` preamble.

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

