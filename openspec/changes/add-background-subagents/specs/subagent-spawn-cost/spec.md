# Spec Delta

## MODIFIED Requirements

### Requirement: Concurrent child runs SHALL be bounded by `maxConcurrent`

`DashboardAgentSettings` SHALL gain `maxConcurrent: number` (default `4`; `0` = unlimited). The extension SHALL hold a process-wide semaphore with two FIFO lanes, foreground and background; a freed slot SHALL go to the oldest foreground waiter, else the oldest background waiter. An `Agent` call SHALL emit `subagents:created` with `status: "queued"` immediately, acquire the semaphore BEFORE loader access and `createAgentSession`, and release it when the run reaches a terminal state.

#### Scenario: excess calls wait in queued status

- **GIVEN** `maxConcurrent: 2`
- **WHEN** 5 `Agent` calls start at once
- **THEN** at most 2 `createAgentSession` calls SHALL be in flight at any time
- **AND** the 3 waiting calls SHALL have emitted `subagents:created` with `details.status === "queued"`
- **AND** waiting calls SHALL start in the order they were invoked

#### Scenario: foreground waiters go before background waiters

- **GIVEN** `maxConcurrent: 1`, one run holding the slot, and 3 background calls queued
- **WHEN** a foreground `Agent` call is made and then the slot frees
- **THEN** the foreground call SHALL start next
- **AND** the 3 background calls SHALL then start in the order they were invoked

#### Scenario: unlimited when zero

- **GIVEN** `maxConcurrent: 0`
- **WHEN** 7 `Agent` calls start at once
- **THEN** all 7 SHALL spawn without waiting

#### Scenario: parent abort while queued

- **GIVEN** an `Agent` call is waiting on the semaphore
- **WHEN** the parent `signal` aborts
- **THEN** the call SHALL resolve with `status: "aborted"`
- **AND** `createAgentSession` SHALL NOT be called for it
- **AND** its slot SHALL NOT be consumed

#### Scenario: setting is read per call

- **GIVEN** the config file is edited to `maxConcurrent: 1` after activation
- **WHEN** the next `Agent` call runs
- **THEN** the new value SHALL apply without `/reload`
