## ADDED Requirements

### Requirement: Frontmatter `model:` field SHALL be resolved via `model:resolve` event when a handler is available

When `AgentMdConfig.model` is a non-empty string, the extension SHALL attempt resolution by emitting a `model:resolve` probe on `pi.events`. The probe MUST be a single object of the shape:

```
{ ref: string, resolved?: string, model?: Model, thinkingLevel?: ThinkingLevelString, auth?: object, error?: string, available?: { roles?, models? } }
```

The extension SHALL call `pi.events.emit("model:resolve", probe)` exactly once, then read `probe.model`, `probe.thinkingLevel`, and `probe.error` synchronously after the emit returns. If `probe.model` is set, that Model SHALL be passed to `createAgentSession({ model, thinkingLevel })`. If `probe.error` is set (handler ran but rejected the ref), the tool call SHALL fail with that error. If neither is set (no handler registered, silent emit), the extension SHALL fall through to the in-process fallback defined in the next requirement.

The handler is responsible for handling all three input forms transparently:

- `@role` — looked up in `~/.pi/agent/providers.json#roles` (handler-side, NOT extension-side).
- `provider/model[:thinking]` — split and resolved via `pi.modelRegistry.find()`.
- bare `model` — "like" query against `pi.modelRegistry.getAll()`, first hit by `m.id === ref` wins.

The thinking-level suffix (`:low|medium|high`) SHALL be parsed by the handler before any registry lookup; the resulting `thinkingLevel` SHALL be filled separately from `resolved` (which is the canonical literal without the suffix).

#### Scenario: Event handler resolves @role to a Model

- **GIVEN** frontmatter `model: "@fast"` AND a handler is registered on `model:resolve`
- **WHEN** `runAgentTool` resolves the model
- **THEN** `pi.events.emit("model:resolve", probe)` SHALL be called exactly once with `probe.ref === "@fast"`
- **AND** after the emit returns, `probe.model` SHALL be a Model object
- **AND** `probe.resolved` SHALL be the canonical literal `"provider/model-id"` form
- **AND** `createAgentSession` SHALL be called with `{ model: probe.model, thinkingLevel: probe.thinkingLevel }`

#### Scenario: Event handler resolves provider/model to a Model

- **GIVEN** frontmatter `model: "anthropic/claude-opus-4-7"` AND a handler is registered on `model:resolve`
- **WHEN** `runAgentTool` resolves the model
- **THEN** `pi.events.emit("model:resolve", probe)` SHALL be called with `probe.ref === "anthropic/claude-opus-4-7"`
- **AND** `probe.model` SHALL be the Model object found via `registry.find("anthropic", "claude-opus-4-7")`
- **AND** the in-process fallback SHALL NOT be exercised

#### Scenario: Event handler resolves bare model id to a Model

- **GIVEN** frontmatter `model: "claude-haiku-4-5"` (no `/`, no `@`) AND a handler is registered on `model:resolve`
- **WHEN** `runAgentTool` resolves the model
- **THEN** `pi.events.emit("model:resolve", probe)` SHALL be called with `probe.ref === "claude-haiku-4-5"`
- **AND** the handler SHALL resolve via `registry.getAll().find(m => m.id === "claude-haiku-4-5")` after `@role` and `provider/model` paths miss
- **AND** `probe.model` SHALL be the first matching Model in registry iteration order
- **AND** `probe.resolved` SHALL be the canonical `"provider/claude-haiku-4-5"` form using the matched model's provider

#### Scenario: Thinking suffix is parsed and surfaced separately

- **GIVEN** frontmatter `model: "anthropic/claude-haiku-4-5:high"` AND a handler is registered on `model:resolve`
- **WHEN** `runAgentTool` resolves the model
- **THEN** the handler SHALL set `probe.resolved === "anthropic/claude-haiku-4-5"` (no suffix)
- **AND** `probe.thinkingLevel === "high"`
- **AND** `createAgentSession` SHALL be invoked with `{ thinkingLevel: "high" }` (in addition to `model`)

#### Scenario: Handler-side resolution failure surfaces in tool result

- **GIVEN** frontmatter `model: "@unknownrole"` AND a handler is registered on `model:resolve`
- **WHEN** `runAgentTool` resolves the model
- **THEN** the handler SHALL set `probe.error` to a human-readable string naming the unresolved ref
- **AND** the handler MAY set `probe.available.roles` listing the known role names
- **AND** the tool call SHALL fail with `isError: true`
- **AND** the error message returned to the LLM SHALL include both `probe.error` and the agent .md file path

#### Scenario: Multiple handlers cooperate via early-return

- **GIVEN** two handlers are registered on `model:resolve` (e.g., one from pi-flows, one from pi-agent-dashboard)
- **WHEN** `pi.events.emit("model:resolve", probe)` is called
- **THEN** each handler SHALL check `if (probe.model) return;` as its first line
- **AND** the first handler to populate `probe.model` SHALL be the winner
- **AND** subsequent handlers SHALL be no-ops

### Requirement: In-process registry fallback SHALL resolve `provider/model` and bare `model` when no `model:resolve` handler is registered

When the `model:resolve` emit returns with both `probe.model` and `probe.error` unset (silent emit — no handler reacted), the extension SHALL attempt in-process resolution using `pi.modelRegistry` directly. The fallback SHALL handle the same two literal forms the handler does (`provider/model[:thinking]` and bare `model`) but SHALL NOT attempt `@role` lookup (which requires reading `providers.json`, a responsibility owned by the handler).

The fallback SHALL parse the `:thinking` suffix before registry lookup, then:

- If the literal contains `/`, split into provider + id and call `registry.find(provider, id)`.
- Otherwise treat as bare id and call `registry.getAll().find(m => m.id === literal)`.

On success, the fallback SHALL pass the resolved Model and thinking level to `createAgentSession`. On failure, the tool call SHALL fail with `isError: true` and an error message naming the unresolved ref.

#### Scenario: Fallback resolves provider/model without any handler

- **GIVEN** frontmatter `model: "anthropic/claude-opus-4-7"` AND NO handler is registered on `model:resolve`
- **WHEN** `runAgentTool` resolves the model
- **THEN** the extension SHALL emit `model:resolve` (silent — no listener)
- **AND** after the emit, the extension SHALL call `pi.modelRegistry.find("anthropic", "claude-opus-4-7")`
- **AND** `createAgentSession` SHALL receive the resolved Model
- **AND** the spawn SHALL succeed normally

#### Scenario: Fallback resolves bare model id without any handler

- **GIVEN** frontmatter `model: "claude-haiku-4-5"` AND NO handler is registered on `model:resolve`
- **WHEN** `runAgentTool` resolves the model
- **THEN** the extension SHALL emit `model:resolve` (silent)
- **AND** the extension SHALL call `pi.modelRegistry.getAll().find(m => m.id === "claude-haiku-4-5")`
- **AND** `createAgentSession` SHALL receive the first matching Model
- **AND** the spawn SHALL succeed

#### Scenario: Fallback parses thinking suffix

- **GIVEN** frontmatter `model: "claude-haiku-4-5:high"` AND NO handler is registered
- **WHEN** the fallback runs
- **THEN** the literal SHALL be parsed as `id="claude-haiku-4-5"`, `thinkingLevel="high"`
- **AND** the registry lookup SHALL be against `"claude-haiku-4-5"` only (suffix stripped)
- **AND** `createAgentSession` SHALL be called with `{ thinkingLevel: "high" }` (in addition to `model`)

#### Scenario: Fallback refuses @role with actionable error

- **GIVEN** frontmatter `model: "@fast"` AND NO handler is registered on `model:resolve`
- **WHEN** `runAgentTool` resolves the model
- **THEN** the extension SHALL emit `model:resolve` (silent)
- **AND** the extension SHALL NOT attempt to read `~/.pi/agent/providers.json`
- **AND** the tool call SHALL fail with `isError: true`
- **AND** the error message SHALL state that `@role` resolution requires a `model:resolve` handler
- **AND** the error message SHALL suggest installing pi-agent-dashboard or pi-flows
- **AND** the error message SHALL include the agent .md file path

#### Scenario: Fallback reports unknown bare id with available models hint

- **GIVEN** frontmatter `model: "made-up-model"` AND NO handler is registered AND no registry entry matches
- **WHEN** the fallback runs
- **THEN** the tool call SHALL fail with `isError: true`
- **AND** the error message SHALL name the unresolved ref `"made-up-model"`
- **AND** the error message MAY include a list of known model ids from `registry.getAll()` (capped to a reasonable count)

### Requirement: The `model:resolve` event contract SHALL be documented

The extension's README SHALL document the `model:resolve` event so other extension authors can implement handlers or use the event as a resolver. Documentation SHALL include the probe shape, the resolution order the handler is expected to follow, the cooperative `if (probe.model) return` pattern for multi-handler setups, and a minimal code example showing how to emit the event and read the result.

#### Scenario: Convention is discoverable in the README

- **WHEN** a developer reads the README's section on frontmatter model selection
- **THEN** they SHALL find the event name `model:resolve`
- **AND** the probe shape (`ref`, `resolved`, `model`, `thinkingLevel`, `auth`, `error`, `available`)
- **AND** the three accepted input forms (`@role`, `provider/model`, bare `model`)
- **AND** a 5-to-10-line code example showing emit + read

## REMOVED Requirements

### Requirement: `@role` syntax in frontmatter `model:` field SHALL be resolved via event bus

**Reason**: The old event name `role:resolve-model` and its probe shape `{ ref, resolved, available }` are replaced by the unified `model:resolve` event documented in this delta's MODIFIED requirements. The old event had no in-workspace handler and was effectively dead. The new requirement subsumes both the `@role` case and literal-model cases in one consistent contract.

**Migration**: Any external code that previously emitted `role:resolve-model` SHALL switch to `model:resolve` with the new probe shape. Old code that only read `probe.resolved` continues to compile against the new probe (resolved is still present in the new shape). Handlers MUST be reimplemented against the new contract.

### Requirement: Non-`@` model references SHALL pass through without event bus probe

**Reason**: The new design always emits `model:resolve` (regardless of `@` prefix) so the handler can centralize all three resolution paths. Skipping the emit for non-`@` strings is no longer correct: the handler is now responsible for `provider/model` and bare-id resolution too. The in-process fallback inherits the literal+bare-id resolution role for the no-handler case.

**Migration**: No caller migration needed — this requirement governed extension internals, not a public API. The new behavior is: emit unconditionally for non-empty `model:` values, fall back to in-process registry only when the emit is silent.

### Requirement: @role resolution SHALL work without any dependency on pi-flows

**Reason**: Subsumed by the new MODIFIED requirements. The independence from pi-flows is preserved (the handler can live in pi-agent-dashboard, or any extension that registers `model:resolve`), and the in-process fallback explicitly does NOT attempt `@role` lookup — that requirement is unchanged in spirit, just expressed via the unified event.

**Migration**: None — same operational behavior. Subagents work with pi-agent-dashboard alone; subagents work with pi-flows alone (when pi-flows registers a `model:resolve` handler); subagents degrade to literal-only resolution when neither is present.

### Requirement: The event name `role:resolve-model` SHALL be documented

**Reason**: The event is removed. Documentation requirement for the new `model:resolve` event is captured under "The `model:resolve` event contract SHALL be documented" above.

**Migration**: README content describing `role:resolve-model` SHALL be replaced with content for `model:resolve` as part of this change's implementation.
