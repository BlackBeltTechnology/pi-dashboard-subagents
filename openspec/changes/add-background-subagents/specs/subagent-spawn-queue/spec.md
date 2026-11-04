# Spec Delta

## MODIFIED Requirements

### Requirement: A stopped subagent SHALL complete as `stopped` without an error

A stop SHALL emit `subagents:completed` with `details.status: "stopped"` and `details.stopReason`. The tool result SHALL NOT be an error: `"Subagent removed from queue before starting."` for queued, and `"Subagent stopped by user."` plus any partial output for running. The parent turn SHALL continue. `details.stoppedBy` SHALL name the source: `tool`, `event`, `timeout` or `shutdown`.

#### Scenario: Parent continues after a stop

- **WHEN** a running subagent is stopped
- **THEN** `subagents:completed` SHALL fire with `details.status === "stopped"`
- **AND** the tool result SHALL have no `isError: true`
- **AND** its text SHALL start with `Subagent stopped by user.`

#### Scenario: Stop source recorded

- **WHEN** a subagent is stopped via the `subagents:stop` event
- **THEN** its terminal details SHALL carry `stoppedBy: "event"`
