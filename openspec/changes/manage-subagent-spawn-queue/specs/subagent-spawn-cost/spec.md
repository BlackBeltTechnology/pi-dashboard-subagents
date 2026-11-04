# Spec Delta

## MODIFIED Requirements

### Requirement: Concurrent child runs SHALL be bounded by `maxConcurrent`

`DashboardAgentSettings` SHALL gain `maxConcurrent: number` (default `4`; `0` = unlimited; clamped to 0–64). The extension SHALL hold a process-wide FIFO semaphore. An `Agent` call SHALL emit `subagents:created` with `status: "queued"` immediately, acquire the semaphore BEFORE loader access and `createAgentSession`, and release it when the run reaches a terminal state. A call SHALL be granted at once only when no call is waiting. While calls wait, the limit SHALL be re-checked about every second.

#### Scenario: excess calls wait in queued status

- **GIVEN** `maxConcurrent: 2`
- **WHEN** 5 `Agent` calls start at once
- **THEN** at most 2 `createAgentSession` calls SHALL be in flight at any time
- **AND** the 3 waiting calls SHALL have emitted `subagents:created` with `details.status === "queued"`
- **AND** waiting calls SHALL start in the order they were invoked

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

#### Scenario: raising the limit starts waiting calls

- **GIVEN** `maxConcurrent: 4`, 4 running and 3 waiting
- **WHEN** the config file is edited to `maxConcurrent: 6`
- **THEN** 2 waiting calls SHALL start within about 2 seconds, in queue order

#### Scenario: a new call does not jump the queue

- **GIVEN** calls are waiting and the limit was just raised
- **WHEN** a new `Agent` call arrives before the re-check runs
- **THEN** it SHALL wait behind the earlier waiters

#### Scenario: lowering the limit stops nothing

- **GIVEN** 4 running
- **WHEN** the limit is lowered to 2
- **THEN** all 4 SHALL keep running and no new call SHALL start until fewer than 2 run

#### Scenario: out-of-range values are clamped

- **WHEN** the config sets `maxConcurrent: 10000`
- **THEN** the effective limit SHALL be 64

#### Scenario: re-check stops when the queue is empty

- **WHEN** the last waiting call starts or is removed
- **THEN** no periodic re-check SHALL remain scheduled
