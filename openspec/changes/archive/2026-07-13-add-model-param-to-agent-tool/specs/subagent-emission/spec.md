## ADDED Requirements

### Requirement: The `Agent` tool's parameter schema SHALL accept an optional `model` field for per-call model override

The tool's TypeBox parameter schema SHALL include an optional string field named `model`. When present, its value SHALL be a non-empty string accepting any of the three input forms supported by the `model:resolve` event-bus contract: `"@role"`, `"provider/model-id[:thinking]"`, or bare `"model-id"`. When absent, the tool's behaviour SHALL be unchanged from the pre-change state.

The field SHALL be documented in its schema description as accepting all three forms and as overriding any `.md` frontmatter `model` value when both are present.

#### Scenario: Schema declares the optional `model` field

- **WHEN** the extension activates
- **THEN** the registered `Agent` tool's parameters schema SHALL include a field `model` of type `string`
- **AND** that field SHALL be optional (not in the JSON Schema `required` array)
- **AND** the schema description text SHALL document the three accepted input forms

#### Scenario: Tool description teaches both modes

- **WHEN** the LLM inspects the `Agent` tool's top-level `description` field
- **THEN** the description SHALL explain that the tool supports two modes: curated (when `subagent_type` matches an `.md` file) and inline (when no `.md` matches, callers can pass `model` directly)

### Requirement: `args.model` SHALL be resolved via the same `resolveModelFromRef` mechanism as `agentConfig.model`

When `args.model` is a non-empty string, the extension SHALL route it through the existing `resolveModelFromRef` helper unchanged. This means the `model:resolve` event-bus primary path and the in-process `pi.modelRegistry` fallback are used identically to the frontmatter path. The resolver SHALL NOT be forked or duplicated for the tool-call path.

#### Scenario: `args.model = "@role"` resolves via the event bus

- **GIVEN** a `model:resolve` handler is registered AND `args.model = "@fast"`
- **WHEN** the LLM invokes the `Agent` tool
- **THEN** `resolveModelFromRef(pi, "@fast", …)` SHALL be called exactly once
- **AND** the resolver SHALL emit `pi.events.emit("model:resolve", probe)` with `probe.ref === "@fast"`
- **AND** the resolved Model SHALL be passed to `createAgentSession`

#### Scenario: `args.model = "provider/model"` resolves via handler or fallback

- **GIVEN** `args.model = "anthropic/claude-haiku-4-5"`
- **WHEN** the LLM invokes the `Agent` tool
- **THEN** the resolver SHALL emit `model:resolve`; if no handler answers, the in-process fallback SHALL split `provider/model` and call `pi.modelRegistry.find("anthropic", "claude-haiku-4-5")`
- **AND** the resolved Model SHALL be passed to `createAgentSession`

#### Scenario: `args.model` accepts bare model id via "like" query

- **GIVEN** `args.model = "claude-haiku-4-5"` (no `/`, no `@`)
- **WHEN** the LLM invokes the `Agent` tool
- **THEN** the resolver SHALL emit `model:resolve`; if no handler answers, the in-process fallback SHALL call `pi.modelRegistry.getAll().find(m => m.id === "claude-haiku-4-5")`
- **AND** the first matching Model SHALL be passed to `createAgentSession`

#### Scenario: `args.model` carries `:thinking` suffix correctly

- **GIVEN** `args.model = "@fast:high"` OR `args.model = "anthropic/opus:high"`
- **WHEN** the resolver runs
- **THEN** the `:high` suffix SHALL be parsed off and surfaced as `thinkingLevel = "high"`
- **AND** `createAgentSession` SHALL receive both the resolved Model AND `thinkingLevel: "high"`

#### Scenario: Resolver failure for `args.model` produces a tool error with synthetic source label

- **GIVEN** `args.model = "@unknownrole"` AND no role of that name is assigned
- **WHEN** the resolver runs
- **THEN** the tool call SHALL fail with `isError: true`
- **AND** the error message SHALL identify the source of the unresolvable ref using a synthetic label (e.g. `Agent definition: (tool-call argument)`) since the ref did not come from a file path

### Requirement: Tool-call `args.model` SHALL take precedence over `agentConfig.model`

When BOTH `args.model` and `agentConfig.model` are non-empty strings, the extension SHALL use `args.model` and ignore `agentConfig.model` for resolution. When `args.model` is absent and `agentConfig.model` is present, the existing frontmatter behaviour applies. When both are absent, no model override is passed to `createAgentSession`.

The effective ref selection SHALL be expressible as: `const effectiveModelRef = args.model ?? agentConfig?.model;`.

#### Scenario: Tool-call model wins when both are set

- **GIVEN** the resolved `.md` has `model: "@coding"` AND the tool call passes `model: "@fast"`
- **WHEN** the extension determines the effective model ref
- **THEN** the resolver SHALL be invoked with `"@fast"`
- **AND** the `.md`'s `@coding` SHALL NOT be looked up

#### Scenario: Frontmatter model used when args.model is absent

- **GIVEN** the resolved `.md` has `model: "@coding"` AND `args.model` is undefined or empty
- **WHEN** the extension determines the effective model ref
- **THEN** the resolver SHALL be invoked with `"@coding"`
- **AND** the spawn SHALL behave identically to the pre-change frontmatter path

#### Scenario: No-override path unchanged when both are absent

- **GIVEN** no `.md` matches `subagent_type` AND `args.model` is undefined
- **WHEN** the `Agent` tool runs
- **THEN** `resolveModelFromRef` SHALL NOT be called
- **AND** `createAgentSession` SHALL be invoked with no `model` argument
- **AND** the subagent SHALL run with pi's default model (parent inheritance, unchanged from today)
