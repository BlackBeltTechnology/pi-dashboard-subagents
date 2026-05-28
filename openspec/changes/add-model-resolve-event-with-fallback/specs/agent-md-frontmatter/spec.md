## MODIFIED Requirements

### Requirement: Frontmatter `model` field SHALL drive subagent model selection

When `AgentMdConfig.model` is a non-empty string, the extension SHALL resolve it to a concrete Model and pass it to `createAgentSession({ model, thinkingLevel })`. When absent or empty, the extension SHALL NOT pass a model override (parent defaults apply).

The `model` value SHALL accept three input forms transparently:

1. `@role` — a role alias resolved via the `model:resolve` event (see `subagent-role-aliasing` capability for the full event contract). Role lookup requires a handler to be registered; without one, this form fails with an actionable error.
2. `provider/model[:thinking]` — a literal model reference. Resolved via `model:resolve` when a handler is registered, or via the in-process `pi.modelRegistry.find(provider, id)` fallback when no handler exists.
3. Bare `model` (no `/`, no `@`) — a model id without a provider prefix. Resolved via "like" query: first registry entry whose `m.id === ref` wins. Same handler/fallback split as form 2.

The `:thinking` suffix (when present) SHALL be parsed before any registry lookup and the resulting level SHALL be passed to `createAgentSession` separately from the Model object. Suffix parsing happens in both the event-handler path and the fallback path consistently.

When resolution fails (handler returns error, or fallback can't match the ref), the tool call SHALL fail with `isError: true` and an error message that:

- Names the unresolvable ref.
- Includes the agent .md file path.
- Distinguishes "role unknown" vs "model unknown" vs "no resolver available" so the operator knows which fix to apply.

#### Scenario: Literal `provider/model` reference passed through

- **GIVEN** frontmatter `model: "anthropic/claude-opus-4-7"`
- **WHEN** the subagent is spawned
- **THEN** the extension SHALL emit `model:resolve` with `probe.ref === "anthropic/claude-opus-4-7"`
- **AND** if a handler resolves it, `createAgentSession` SHALL be called with the resulting Model
- **AND** if no handler reacts, the extension SHALL call `pi.modelRegistry.find("anthropic", "claude-opus-4-7")` and pass that Model to `createAgentSession`
- **AND** `details.modelName` SHALL reflect the resolved model id

#### Scenario: Bare model id resolved via "like" query

- **GIVEN** frontmatter `model: "claude-haiku-4-5"` (no `/`, no `@`)
- **WHEN** the subagent is spawned
- **THEN** the extension SHALL emit `model:resolve` with `probe.ref === "claude-haiku-4-5"`
- **AND** if no handler reacts, the extension SHALL call `pi.modelRegistry.getAll().find(m => m.id === "claude-haiku-4-5")`
- **AND** the first matching Model in registry iteration order SHALL be passed to `createAgentSession`
- **AND** if two providers expose the same `id`, the first registry hit wins (operator should disambiguate with `provider/model` form)

#### Scenario: Role alias resolved via event handler

- **GIVEN** frontmatter `model: "@fast"` AND a `model:resolve` handler is registered
- **WHEN** the subagent is spawned
- **THEN** the extension SHALL emit `model:resolve` and the handler SHALL fill `probe.model`
- **AND** `createAgentSession` SHALL receive that Model
- **AND** `details.modelName` SHALL reflect the canonical literal the role resolved to

#### Scenario: Role alias fails when no handler is registered

- **GIVEN** frontmatter `model: "@fast"` AND NO `model:resolve` handler is registered
- **WHEN** the subagent is spawned
- **THEN** the in-process fallback SHALL NOT attempt to read `providers.json`
- **AND** the tool call SHALL fail with `isError: true`
- **AND** the error message SHALL state that `@role` resolution requires a handler
- **AND** the error message SHALL suggest installing pi-agent-dashboard or pi-flows
- **AND** the error message SHALL include the agent .md file path

#### Scenario: Model with thinking suffix parsed in both paths

- **GIVEN** frontmatter `model: "claude-haiku-4-5:high"`
- **WHEN** the extension resolves the model reference
- **THEN** the literal SHALL be parsed as `id="claude-haiku-4-5"`, `thinkingLevel="high"` before any registry lookup
- **AND** this parsing SHALL happen consistently whether the event handler answers or the in-process fallback runs
- **AND** `createAgentSession` SHALL be invoked with the resolved Model AND `thinkingLevel: "high"`

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
