## MODIFIED Requirements

### Requirement: The extension SHALL emit lifecycle events on pi's event bus using the `subagents:*` channel namespace

The dashboard bridge's emit intercept maps `subagents:*` channels to `subagent_*` protocol events. The extension SHALL emit on these channels (not its own namespace) so the dashboard's existing reducer + renderer light up without dashboard-side changes. The tool's `onUpdate` callback (surfaced as `tool_execution_update`) SHALL be coalesced within the same throttle window as the `subagents:started` progress leg; terminal snapshots SHALL always be delivered.

#### Scenario: subagents:created fires on tool invocation start

- **WHEN** the `Agent` tool's `execute` callback begins
- **THEN** `pi.events.emit("subagents:created", payload)` SHALL be called exactly once
- **AND** the payload SHALL include `{ id, type, description, details }`
- **AND** `details.agentId === payload.id`

#### Scenario: subagents:started fires after the session is created

- **WHEN** the subagent session has been instantiated and the run is about to begin
- **THEN** `pi.events.emit("subagents:started", payload)` SHALL be called with the current `AgentDetails` snapshot
- **AND** `details.status === "running"`

#### Scenario: subagents:started fires repeatedly as progress accumulates

- **GIVEN** a subagent run is in progress
- **WHEN** `entries[]`, `activity`, `toolUses`, or `turnCount` changes
- **THEN** `pi.events.emit("subagents:started", payload)` SHALL be called with the latest cumulative `details`
- **AND** the dashboard reducer SHALL replace `SessionState.subagents[agentId].entries` with the new array (replace, not append)

#### Scenario: Progress emissions are throttled to avoid event-bus flooding

- **GIVEN** session events arrive in rapid succession (e.g. many `text_delta` events per second)
- **WHEN** progress emissions are coalesced
- **THEN** the extension SHALL emit at most 4 progress updates per second per subagent
- **AND** the final `subagents:started` emission BEFORE `subagents:completed` SHALL flush the latest state regardless of throttle

#### Scenario: onUpdate is coalesced in the same window

- **GIVEN** 100 child session events arrive within 250 ms
- **WHEN** the run is in progress
- **THEN** `onUpdate` SHALL be invoked at most 2 times for that burst
- **AND** `snapshotDetails` SHALL NOT be computed for the coalesced events

#### Scenario: terminal onUpdate always flushes

- **WHEN** the run reaches `completed`, `error`, or `aborted`
- **THEN** the last `onUpdate` call SHALL carry `details.status` equal to that terminal status
- **AND** it SHALL be delivered synchronously before the tool result resolves

#### Scenario: subagents:completed fires on successful prompt resolution

- **WHEN** `await session.prompt(effectivePrompt)` resolves successfully
- **THEN** `pi.events.emit("subagents:completed", payload)` SHALL be called exactly once
- **AND** the payload SHALL include `{ id, result, durationMs, tokens, toolUses, details }`
- **AND** `details.status === "completed"`
- **AND** `details.tokensUsage` SHALL contain `{ input, output, total }`

#### Scenario: subagents:failed fires on prompt rejection or session error

- **WHEN** `await session.prompt(effectivePrompt)` rejects, OR the subscription receives an error event
- **THEN** `pi.events.emit("subagents:failed", payload)` SHALL be called exactly once
- **AND** the payload SHALL include `{ id, error, durationMs, toolUses, details }`
- **AND** `details.entries` SHALL contain whatever entries had accumulated before the failure (not be cleared)

#### Scenario: Emissions are no-ops when pi.events is unavailable

- **GIVEN** `pi.events` is undefined (e.g. extension loads before the bus is wired)
- **WHEN** any emission helper is invoked
- **THEN** the call SHALL NOT throw
- **AND** the subagent run SHALL continue normally (silent degradation)
