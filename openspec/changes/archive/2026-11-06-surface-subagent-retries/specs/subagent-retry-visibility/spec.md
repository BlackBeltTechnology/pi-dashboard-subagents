## ADDED Requirements

### Requirement: A scheduled child auto-retry SHALL be recorded as a `retry` timeline entry

When the child session schedules an auto-retry, the extension SHALL append exactly one entry `{ kind: "retry", attempt, maxAttempts, delayMs, text, ts }` to the run's timeline. `attempt` is the 1-based retry number, `maxAttempts` is the retry budget, `delayMs` is the scheduled backoff, and `text` is the provider error that triggered the retry. The entry SHALL be emitted on `subagents:entry` like every other step. The extension SHALL NOT schedule, perform, suppress or reclassify retries itself.

#### Scenario: a transient error that recovers leaves a retry entry

- **GIVEN** the child's first reply fails with `stopReason: "error"`, `errorMessage: "503 service unavailable"`
- **AND** pi retries it and the retried reply succeeds with text `"done"`
- **WHEN** the run ends
- **THEN** the timeline SHALL contain `{ kind: "retry", attempt: 1, maxAttempts: <settings.retry.maxRetries>, delayMs: <scheduled delay>, text: "503 service unavailable" }`, ordered after every entry from before the failed attempt and before every entry from the retried attempt
- **AND** `subagents:entry` SHALL have fired once for the `retry` entry, with the next contiguous `index`
- **AND** `details.status` SHALL be `"completed"` with result `"done"`

#### Scenario: each retry attempt gets its own entry

- **GIVEN** the child's reply fails retryably three times in a row
- **WHEN** pi schedules attempts 1, 2 and 3
- **THEN** three `retry` entries SHALL be appended, with `attempt` values 1, 2 and 3 in order

#### Scenario: a non-retryable error produces no retry entry

- **GIVEN** the child's final reply fails with an error pi does not classify as retryable (e.g. a quota error)
- **WHEN** the run ends
- **THEN** the timeline SHALL contain no `retry` entry
- **AND** `details.retries` SHALL be absent

#### Scenario: retry entries are bounded like other entries

- **GIVEN** a `retry` entry whose `text` exceeds `entryFieldMaxChars`
- **WHEN** the tool result is bounded per `subagent-result-bounds`
- **THEN** the entry's `text` SHALL be cut like a `text`/`thinking`/`error` entry, and `attempt`, `maxAttempts` and `delayMs` SHALL be kept unchanged

### Requirement: Retries SHALL be published on `subagents:retry`

The extension SHALL emit `subagents:retry` on `pi.events`, unthrottled, with `v: 1`, `agentId`, the parent `toolCallId` (`""` when unknown) and `retries` (the run's running total). When pi schedules a retry it SHALL emit `phase: "scheduled"` with `attempt`, `maxAttempts`, `delayMs` and `error`. When pi ends a retry sequence it SHALL emit `phase: "ended"` with `attempt`, `success` and, when unsuccessful, `finalError`.

#### Scenario: a recovered retry publishes both phases

- **GIVEN** the child's reply fails with `"503 service unavailable"`, pi retries once with a 10 ms delay and a budget of 2, and the retried reply succeeds
- **WHEN** the run ends
- **THEN** `subagents:retry` SHALL have fired exactly twice, in order:
  - `{ v: 1, agentId, toolCallId, phase: "scheduled", attempt: 1, maxAttempts: 2, delayMs: 10, error: "503 service unavailable", retries: 1 }`
  - `{ v: 1, agentId, toolCallId, phase: "ended", attempt: 1, success: true, retries: 1 }`

#### Scenario: an exhausted sequence publishes its final error

- **GIVEN** every attempt fails with `"429 rate_limit_error"` and the budget is 2
- **WHEN** the run ends
- **THEN** `subagents:retry` SHALL fire `scheduled` for attempts 1 and 2, then `ended` with `attempt: 2`, `success: false`, `finalError: "429 rate_limit_error"`, `retries: 2`

#### Scenario: no retry, no event

- **GIVEN** the run's only error is one pi does not retry
- **WHEN** the run ends
- **THEN** `subagents:retry` SHALL NOT fire

### Requirement: Live activity SHALL show a pending backoff

While a retry backoff is pending, `details.activity` SHALL read `retrying (attempt N/M) in <delay>…`, with the delay in a human-readable form (e.g. `4s`, `2m 30s`). A progress update carrying this activity SHALL be emitted when the backoff is scheduled. Once the retried attempt begins streaming or calling tools, activity SHALL return to normal event-driven values.

#### Scenario: activity reflects the backoff and then clears

- **GIVEN** pi schedules retry attempt 2 of 18 with a 4000 ms delay
- **WHEN** the next progress snapshot is emitted
- **THEN** `details.activity` SHALL be `"retrying (attempt 2/18) in 4s…"`
- **AND WHEN** the retried attempt emits `thinking_start`
- **THEN** `details.activity` SHALL be `"thinking"`

#### Scenario: a stop during backoff ends the run as stopped

- **GIVEN** a retry backoff is pending
- **WHEN** the run is stopped via `subagents:stop` or parent abort
- **THEN** the run SHALL end with the existing `stopped` / `aborted` outcome
- **AND** no further `retry` entry SHALL be appended

### Requirement: `AgentDetails.retries` SHALL count retry attempts in the run

`AgentDetails` SHALL gain an optional `retries: number`, the total retry attempts scheduled so far in this run, summed across all retry sequences. It SHALL be absent until the first retry and present on every later snapshot, including progress frames, `subagents:completed`, `subagents:failed`, the terminal `onUpdate` and the bounded tool result.

#### Scenario: recovered run records its retries

- **GIVEN** a run in which pi retried once on turn 2 and twice on turn 5, all recovering
- **WHEN** `subagents:completed` fires
- **THEN** `details.retries` SHALL be `3`
- **AND** the persisted tool result's `details.retries` SHALL be `3`

#### Scenario: run without retries omits the field

- **GIVEN** a run in which no retry was scheduled
- **WHEN** any snapshot is emitted
- **THEN** `details` SHALL NOT contain a `retries` key

### Requirement: A failure after retrying SHALL say so

When the final reply errored and the run's last retry sequence ended unsuccessfully (budget exhausted, or a retried attempt failed non-retryably), `details.error` and the tool result text SHALL append ` (after 1 retry)` or ` (after N retries)`, where `N` is that sequence's attempt count. The final assistant message SHALL still decide success or failure.

#### Scenario: exhausted retries

- **GIVEN** `settings.retry.maxRetries` is 2 and every attempt fails with `"429 rate_limit_error"`
- **WHEN** the run ends
- **THEN** `details.status` SHALL be `"error"`
- **AND** `details.error` SHALL be `"429 rate_limit_error (after 2 retries)"`
- **AND** the tool result text SHALL be `"Subagent failed: 429 rate_limit_error (after 2 retries)"`
- **AND** `details.retries` SHALL be `2`

#### Scenario: a retried attempt fails with a non-retryable error

- **GIVEN** the child's reply fails with retryable `"503 service unavailable"`, pi schedules retry attempt 1, and the retried attempt fails with non-retryable `"400 bad request"`
- **WHEN** the run ends
- **THEN** `details.error` SHALL be `"400 bad request (after 1 retry)"`
- **AND** `details.retries` SHALL be `1`

#### Scenario: an earlier recovered sequence does not decorate an unrelated failure

- **GIVEN** a retry on turn 1 recovered, and turn 4's final reply fails with a non-retryable error `"400 bad request"`
- **WHEN** the run ends
- **THEN** `details.error` SHALL be `"400 bad request"` with no `(after …)` suffix
- **AND** `details.retries` SHALL be `1`
