# Spec Delta

## MODIFIED Requirements

### Requirement: Concurrent child runs SHALL be bounded by `maxConcurrent`

`DashboardAgentSettings` SHALL gain `maxConcurrent: number` (default `4`; `0` = unlimited; clamped to 0–64). A process-wide semaphore SHALL have a foreground and a background FIFO lane; a free slot goes to the oldest foreground waiter, else the oldest background one. A call SHALL emit `subagents:created` (`queued`) at once, acquire a slot before loader and session work, and release it on terminal state. A call is granted at once only when nobody waits; while calls wait, the limit is re-checked about every second.

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
- **AND** queue positions SHALL follow dispatch order (the foreground call at position 1)

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
