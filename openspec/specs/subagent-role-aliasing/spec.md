# subagent-role-aliasing Specification

## Purpose
Defines how a model reference (`@role`, `provider/model[:thinking]` or bare `model-id`, from frontmatter or the tool call) becomes a concrete Model and thinking level. Resolution goes through the cooperative `model:resolve` event first, then an in-process `pi.modelRegistry` fallback that never resolves `@role`.
## Requirements
### Requirement: Frontmatter `model:` field SHALL be resolved via `model:resolve` event when a handler is available

The extension SHALL emit `model:resolve` on `pi.events` exactly once with a probe `{ ref, resolved?, model?, thinkingLevel?, auth?, error?, available? }`, then synchronously read `probe.model`, `probe.thinkingLevel` and `probe.error`. A set `probe.model` SHALL be passed to `createAgentSession`. A set `probe.error` SHALL fail the tool call with that error. If neither is set (silent emit), the in-process fallback SHALL run.

#### Scenario: Event handler resolves @role to a Model

- **GIVEN** frontmatter `model: "@fast"` AND a handler is registered on `model:resolve`
- **WHEN** `runAgentTool` resolves the model
- **THEN** `pi.events.emit("model:resolve", probe)` SHALL be called exactly once with `probe.ref === "@fast"`
- **AND** after the emit returns, `probe.model` SHALL be a Model object
- **AND** `probe.resolved` SHALL be the canonical literal `"provider/model-id"` form
- **AND** `createAgentSession` SHALL be called with `model: probe.model` and, when `probe.thinkingLevel` is set, `thinkingLevel: probe.thinkingLevel` (otherwise the parent's live level applies, per capability `subagent-thinking-level`)

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

### Requirement: The `model:resolve` handler SHALL resolve three input forms and the thinking suffix

A handler SHALL handle `@role` (looked up in `~/.pi/agent/providers.json#roles`, handler-side, not extension-side), `provider/model[:thinking]` (via `pi.modelRegistry.find()`) and bare `model` (first `m.id === ref` hit in `pi.modelRegistry.getAll()`). It SHALL parse the thinking suffix before any registry lookup and fill `thinkingLevel` separately from `resolved`, the canonical literal without suffix. Valid suffixes are `minimal`, `low`, `medium`, `high`, `xhigh`, `max` and `off`.

#### Scenario: Suffix values beyond low, medium and high are parsed

- **GIVEN** frontmatter `model: "anthropic/claude-opus-4:max"` OR `"anthropic/claude-haiku-4-5:off"` AND a handler is registered
- **WHEN** the model is resolved
- **THEN** `probe.thinkingLevel` SHALL be `"max"` OR `"off"` respectively
- **AND** `probe.resolved` SHALL carry no suffix

#### Scenario: Unrecognised suffix is part of the model id

- **GIVEN** a ref whose text after the last `:` is not a valid thinking level
- **WHEN** the in-process fallback splits the model reference
- **THEN** that text SHALL stay part of the model id
- **AND** `thinkingLevel` SHALL be undefined

### Requirement: In-process registry fallback SHALL resolve `provider/model` and bare `model` when no `model:resolve` handler is registered

When the `model:resolve` emit returns with both `probe.model` and `probe.error` unset, the extension SHALL resolve in-process using `pi.modelRegistry`. The fallback SHALL handle `provider/model[:thinking]` and bare `model`, but SHALL NOT attempt `@role` lookup, which requires reading `providers.json` and is owned by the handler.

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

### Requirement: The fallback SHALL parse the thinking suffix, look up the model, and report failures

The fallback SHALL parse the `:thinking` suffix before lookup. If the literal contains `/`, it SHALL split provider and id and call `registry.find(provider, id)`; otherwise it SHALL call `registry.getAll().find(m => m.id === literal)`. On success it SHALL pass the Model and thinking level to `createAgentSession`. On failure the tool call SHALL fail with `isError: true` and an error naming the unresolved ref.

#### Scenario: Registry unavailable

- **GIVEN** no handler is registered AND `pi.modelRegistry` is unavailable
- **WHEN** a literal ref is resolved
- **THEN** the tool call SHALL fail with `isError: true`
- **AND** the error SHALL name the unresolved ref

### Requirement: The `model:resolve` event contract SHALL be documented

The extension's README SHALL document the `model:resolve` event so other extension authors can implement handlers or use the event as a resolver. Documentation SHALL include the probe shape, the resolution order the handler is expected to follow, the cooperative `if (probe.model) return` pattern for multi-handler setups, and a minimal code example showing how to emit the event and read the result.

#### Scenario: Convention is discoverable in the README

- **WHEN** a developer reads the README's section on frontmatter model selection
- **THEN** they SHALL find the event name `model:resolve`
- **AND** the probe shape (`ref`, `resolved`, `model`, `thinkingLevel`, `auth`, `error`, `available`)
- **AND** the three accepted input forms (`@role`, `provider/model`, bare `model`)
- **AND** a 5-to-10-line code example showing emit + read

