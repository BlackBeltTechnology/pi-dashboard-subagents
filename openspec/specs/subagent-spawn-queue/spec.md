# subagent-spawn-queue Specification

## Purpose
Lets the dashboard and other plugins stop a single subagent (queued or running) via an event, and reports exact queue state on every queued snapshot.

## Requirements

### Requirement: Each subagent SHALL have its own abort, linked to the parent

Each `Agent` call SHALL use its own abort signal for slot acquisition and its child session. A parent abort SHALL abort it with reason `parent`, including when the parent was already aborted at call start. The parent link SHALL be removed when the run ends.

#### Scenario: Parent abort still ends every subagent as aborted

- **GIVEN** 2 running and 1 queued subagent from one parent turn
- **WHEN** the parent signal aborts
- **THEN** all three SHALL end with `status: "aborted"` as before this change

### Requirement: `subagents:stop` SHALL stop one subagent of the receiving session

The extension SHALL listen for `subagents:stop { agentId }`. It SHALL act only on subagents created by the same activation. Unknown or finished ids SHALL be ignored. Each request SHALL be logged with `agentId`, phase and outcome. No other subagent and not the parent turn SHALL be affected.

#### Scenario: Unknown or finished id

- **WHEN** `subagents:stop` names an unknown or already finished `agentId`
- **THEN** nothing SHALL change and the request SHALL be logged as ignored

#### Scenario: Other session's subagent

- **GIVEN** activations A and B in one process
- **WHEN** `subagents:stop` for B's subagent is emitted on A's bus
- **THEN** B's subagent SHALL keep running

### Requirement: Stopping a queued subagent SHALL remove it without starting it

A stop in phase `queued` SHALL remove the call from the queue without taking a slot and without creating a child session. Remaining waiters SHALL be renumbered.

#### Scenario: Queued stop

- **GIVEN** `maxConcurrent: 1`, one running, and waiters W1, W2, W3
- **WHEN** `subagents:stop` names W2
- **THEN** W2 SHALL end `stopped` with `stopReason: "queued"`
- **AND** `createAgentSession` SHALL NOT be called for W2
- **AND** W3 SHALL report `queuePosition: 2`

### Requirement: Stopping a running subagent SHALL abort only that child and free its slot

A stop in phase `running` SHALL abort only that child session and release its slot, so the next waiter starts. The slot SHALL be released even when the stop lands after the slot is granted and before the child starts.

#### Scenario: Running stop frees a slot

- **GIVEN** `maxConcurrent: 2`, R1 and R2 running, W1 waiting
- **WHEN** `subagents:stop` names R1
- **THEN** R1 SHALL end `stopped` with `stopReason: "running"`
- **AND** R2 SHALL keep running and W1 SHALL start

#### Scenario: Stop between slot grant and child start

- **WHEN** a stop arrives after the slot is granted but before the child session exists
- **THEN** no child session SHALL run a prompt
- **AND** the slot SHALL be released

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

### Requirement: The first end reason SHALL win

A stop and a parent abort for the same subagent SHALL be reconciled so that whichever comes first decides the outcome. The second SHALL have no effect. Exactly one terminal event SHALL be emitted.

#### Scenario: Stop then parent abort

- **GIVEN** subagent S is stopped, then the parent aborts while other subagents run
- **THEN** S SHALL stay `stopped` and the others SHALL end `aborted`
- **AND** S SHALL emit exactly one terminal event

### Requirement: Snapshots SHALL advertise stop support and carry exact queue info

Every `AgentDetails` snapshot SHALL include `stoppable: true`. While queued it SHALL include `queuePosition` (1-based, without gaps), `activeSlots` and `maxConcurrent`. Once running it SHALL include `slotGrantedAt`. `startedAt` SHALL remain the call-creation time.

#### Scenario: Queued snapshot

- **GIVEN** `maxConcurrent: 2`, two running and this call second in line
- **THEN** its snapshot SHALL have `queuePosition: 2`, `activeSlots: 2`, `maxConcurrent: 2`, `stoppable: true`

#### Scenario: Running snapshot

- **WHEN** the call's slot is granted
- **THEN** later snapshots SHALL carry `slotGrantedAt` and omit `queuePosition`

### Requirement: Queue changes SHALL re-push queued snapshots, batched per task

After any queue change (slot granted, waiter removed, limit change), each remaining waiter SHALL receive a fresh queued snapshot through its `onUpdate`. Several changes in one synchronous task SHALL produce one frame per waiter.

#### Scenario: Middle removal renumbers

- **GIVEN** waiters at positions 1, 2, 3
- **WHEN** position 2 is stopped
- **THEN** the former position 3 SHALL receive a snapshot with `queuePosition: 2`

#### Scenario: Batched changes

- **WHEN** a slot grant and a waiter removal happen in the same task
- **THEN** each remaining waiter SHALL receive exactly one new queued frame
