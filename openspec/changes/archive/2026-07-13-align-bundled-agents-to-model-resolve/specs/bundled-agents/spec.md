## MODIFIED Requirements

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
