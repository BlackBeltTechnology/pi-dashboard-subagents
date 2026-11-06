## RENAMED Requirements

- FROM: `### Requirement: AgentDetails payload SHALL contain the full timeline + metadata the dashboard inspector consumes`
- TO: `### Requirement: AgentDetails payload SHALL contain the full timeline and run metadata`

## MODIFIED Requirements

### Requirement: AgentDetails payload SHALL contain the full timeline and run metadata

Every emission's `details` field SHALL be an `AgentDetails` object matching the wire shape defined in `extensions/events.ts`. Consumers read these fields by name.

#### Scenario: Required fields are always present

- **WHEN** any emission is sent
- **THEN** `details` SHALL contain at minimum: `agentId`, `displayName`, `description`, `subagentType`, `status`, `toolUses`, `tokens`, `durationMs`

#### Scenario: entries[] is populated for the timeline

- **GIVEN** the subagent has performed at least one tool call, emitted assistant text, emitted a thinking block, or had a retry scheduled
- **WHEN** the next progress / completion / failure emission fires
- **THEN** `details.entries` SHALL be a non-empty array of `SubagentTimelineEntry` objects
- **AND** each entry SHALL have a `kind` value in `{"tool", "text", "thinking", "error", "retry"}`
- **AND** a `retry` entry SHALL have the shape defined by capability `subagent-retry-visibility`
- **AND** each entry SHALL have a `ts` epoch-ms timestamp

#### Scenario: Tool entries pair input args with output result

- **GIVEN** the subagent invokes a tool that runs to completion
- **WHEN** the `tool_execution_end` event is mapped to an entry
- **THEN** the entry SHALL be `{ kind: "tool", toolName, input, output, isError, ts }`
- **AND** `input` SHALL contain the args from the matching `tool_execution_start` event
- **AND** `output` SHALL contain the tool's result

#### Scenario: agentMdPath surfaces custom agent definitions with source tier

- **GIVEN** an agent type matches a file at a resolved tier
- **WHEN** the extension builds initial `AgentDetails`
- **THEN** `details.agentMdPath` SHALL be set from `resolveAgentMdPath`'s result
- **AND** `details.agentMdSource` SHALL be set (`"project"`, `"user"`, `"bundled"`, or `"package"`) reflecting which tier resolved the .md file
- **AND** `details.agentMdPkg` SHALL carry the originating package source string only when `agentMdSource` is `"package"`
- **AND WHEN** no matching file exists (built-in or anonymous agent)
- **THEN** `details.agentMdPath` and `details.agentMdSource` SHALL be undefined

#### Scenario: Token usage uses raw breakdown on completion

- **WHEN** `subagents:completed` fires
- **THEN** `details.tokensUsage` SHALL be `{ input, output, total }` with raw integer counts
- **AND** `details.tokens` SHALL be the display-formatted string (e.g. `"12.3k"`)
