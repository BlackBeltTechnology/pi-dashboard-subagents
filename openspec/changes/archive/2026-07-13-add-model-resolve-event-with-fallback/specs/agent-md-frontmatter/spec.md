## MODIFIED Requirements

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
