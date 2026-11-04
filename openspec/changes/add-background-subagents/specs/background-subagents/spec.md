# Spec Delta

## Purpose

Lets the parent LLM start subagents that run without blocking it, then check, wait on, read the messages of, list and cancel them, with safeguards against forgotten queued work.

## ADDED Requirements

### Requirement: Background support SHALL be controlled by the `allowBackground` setting

`DashboardAgentSettings` SHALL gain `allowBackground: boolean` (default `true`), read once at activation. When `false`, the `Agent` schema SHALL NOT include `run_in_background` or `timeout_s`, and no background tool SHALL be registered. When `true`, both parameters and the four background tools SHALL be present. Changes SHALL apply only after re-activation.

#### Scenario: Enabled by default

- **GIVEN** no `allowBackground` key in the config file
- **WHEN** the extension activates
- **THEN** the `Agent` schema SHALL include optional `run_in_background` and `timeout_s`
- **AND** tools `AgentStatus`, `AgentMessages`, `AgentList` and `AgentCancel` SHALL be registered

#### Scenario: Disabled hides the feature entirely

- **GIVEN** `allowBackground: false`
- **WHEN** the extension activates
- **THEN** only the `Agent` tool SHALL be registered
- **AND** its schema SHALL NOT contain `run_in_background` or `timeout_s`

#### Scenario: Setting change needs reload

- **GIVEN** the extension activated with `allowBackground: true`
- **WHEN** the config file is edited to `false` without `/reload`
- **THEN** the registered tools and schema SHALL stay unchanged

### Requirement: `Agent` with `run_in_background: true` SHALL return immediately with an id

The call SHALL register the subagent and return without awaiting it. The text result SHALL contain a short id (`bg-` prefix), the queue position or `running`, and the counts of running, queued and finished-unread background subagents. The run SHALL proceed as a foreground run (same events, semaphore, queue info, `subagents:stop`). Interrupting the parent turn SHALL NOT abort it.

#### Scenario: Immediate return while the run continues

- **WHEN** the LLM calls `Agent` with `run_in_background: true`
- **THEN** the tool call SHALL resolve before the subagent reaches a terminal state
- **AND** the result text SHALL include an id starting with `bg-`
- **AND** `subagents:created`, `subagents:started`, `subagents:entry` and the terminal event SHALL still be emitted for that subagent with `details.background === true`

#### Scenario: Several background subagents at once

- **GIVEN** `maxConcurrent: 2`
- **WHEN** 3 background `Agent` calls are made
- **THEN** all 3 calls SHALL return ids immediately
- **AND** at most 2 SHALL run at once, the third reporting `queued`

#### Scenario: Parent interrupt does not cancel background work

- **GIVEN** a running background subagent
- **WHEN** the parent turn's abort signal fires
- **THEN** the background subagent SHALL keep running

#### Scenario: Dashboard card is not finalized by the early tool end

- **WHEN** a background `Agent` call returns
- **THEN** its result `details` SHALL NOT contain `agentId`
- **AND** SHALL contain `background: true` and the short `id`

### Requirement: Finished background results SHALL be stored and never pushed to the parent

On a terminal state the extension SHALL store status, result text or error, token usage, duration and the timeline, readable for the rest of the session. The extension SHALL NOT inject any message, follow-up or steer into the parent session for a background subagent.

#### Scenario: Result available later

- **GIVEN** a background subagent completed while the parent was idle
- **WHEN** the LLM later calls `AgentStatus` with its id
- **THEN** the stored result text SHALL be returned

#### Scenario: No delivery into the parent

- **WHEN** a background subagent reaches any terminal state
- **THEN** no `sendMessage` or `sendUserMessage` call SHALL be made on the parent

### Requirement: `AgentStatus` SHALL report and optionally wait for background subagents

`AgentStatus({ ids, wait?, timeout_s? })` SHALL accept one or more ids (short id, full `agentId` or unique prefix). `wait: "none"` (default) returns current state; `"any"` returns once at least one is terminal; `"all"` once all are terminal. On `timeout_s` expiry it SHALL return current state without cancelling. Aborting the call SHALL end only the wait. Output SHALL be bounded by `resultMaxChars`.

#### Scenario: Snapshot without waiting

- **GIVEN** a running background subagent `bg-a`
- **WHEN** `AgentStatus({ ids: ["bg-a"] })` is called
- **THEN** it SHALL return immediately with `status: running`

#### Scenario: Wait for all

- **GIVEN** background subagents `bg-a` and `bg-b` running
- **WHEN** `AgentStatus({ ids: ["bg-a","bg-b"], wait: "all" })` is called
- **THEN** it SHALL resolve only after both are terminal, returning both results

#### Scenario: Wait for any

- **WHEN** `AgentStatus({ ids: ["bg-a","bg-b"], wait: "any" })` is called and `bg-b` finishes first
- **THEN** it SHALL return `bg-b`'s result and `bg-a`'s current status

#### Scenario: Wait timeout does not cancel

- **WHEN** `AgentStatus({ ids: ["bg-a"], wait: "all", timeout_s: 5 })` passes 5 s with `bg-a` still running
- **THEN** it SHALL return `bg-a` with `status: running`
- **AND** `bg-a` SHALL keep running

#### Scenario: Interrupting the wait leaves the subagent running

- **WHEN** the `AgentStatus` call's signal aborts during a wait
- **THEN** the call SHALL end and the waited subagents SHALL keep running

#### Scenario: Unknown id

- **WHEN** an id matches no record
- **THEN** that id SHALL be reported `not_found` without failing the other ids

### Requirement: `AgentMessages` SHALL return a paged, bounded view of a subagent's timeline

`AgentMessages({ id, from?, limit?, kinds? })` SHALL work on queued, running and finished background subagents. Without `from` it SHALL return the last `limit` (default 20) entries. It SHALL return `total` and `next_from`. `kinds` SHALL filter before paging. Each entry field SHALL be cut to `entryFieldMaxChars` and the response bounded by `resultMaxChars`.

#### Scenario: Tail by default

- **GIVEN** a subagent with 50 timeline entries
- **WHEN** `AgentMessages({ id })` is called
- **THEN** entries 30–49 SHALL be returned with `total: 50`

#### Scenario: Incremental read of a running subagent

- **GIVEN** a previous call returned `next_from: 12`
- **WHEN** `AgentMessages({ id, from: 12 })` is called after more steps ran
- **THEN** only entries from index 12 onward SHALL be returned

#### Scenario: Kind filter

- **WHEN** `AgentMessages({ id, kinds: ["text"] })` is called
- **THEN** only `text` entries SHALL be returned

### Requirement: `AgentList` SHALL list the session's background subagents

`AgentList()` SHALL return every background subagent of the current activation with id, `subagent_type`, description, status, age, token total and whether a finished result is unread, followed by counts of running, queued and finished-unread.

#### Scenario: Mixed states listed

- **GIVEN** one running, one queued and one completed background subagent
- **WHEN** `AgentList()` is called
- **THEN** all three SHALL be listed with their statuses
- **AND** the counts line SHALL read 1 running, 1 queued, 1 finished-unread

### Requirement: `AgentCancel` SHALL stop background subagents through the shared stop path

`AgentCancel({ ids, status? })` SHALL accept an id list or `"all"`, optionally filtered by `status` (`queued`|`running`). It SHALL stop subagents exactly as `subagents:stop` does, giving `status: "stopped"` with `stopReason` and `stoppedBy: "tool"`. It SHALL return per-id `stopped`, `already_finished` or `not_found`, not wait for the stop, and keep partial timelines readable.

#### Scenario: Cancel a running subagent

- **WHEN** `AgentCancel({ ids: ["bg-a"] })` is called on a running subagent
- **THEN** the outcome SHALL be `stopped`
- **AND** the subagent SHALL emit `subagents:completed` with `details.status: "stopped"`, `stopReason: "running"`, `stoppedBy: "tool"`
- **AND** `AgentMessages({ id: "bg-a" })` SHALL still return its entries

#### Scenario: Bulk-cancel the queue

- **GIVEN** 2 running and 5 queued background subagents
- **WHEN** `AgentCancel({ ids: "all", status: "queued" })` is called
- **THEN** the 5 queued SHALL end `stopped` with `stopReason: "queued"` without starting
- **AND** the 2 running SHALL be unaffected

#### Scenario: Already finished

- **WHEN** `AgentCancel` targets a completed subagent
- **THEN** its outcome SHALL be `already_finished` and its stored result SHALL be unchanged

#### Scenario: Dashboard stop on a background subagent

- **WHEN** `subagents:stop` names a running background subagent
- **THEN** it SHALL end `stopped` with `stoppedBy: "event"` and its stored result SHALL reflect that

### Requirement: Outstanding background subagents SHALL be capped by `maxBackgroundPending`

`DashboardAgentSettings` SHALL gain `maxBackgroundPending` (default `8`, `0` = unlimited), read per call. A background spawn while queued+running background subagents ≥ the cap SHALL be rejected as an error result naming the outstanding ids and suggesting `AgentStatus` or `AgentCancel`. No record or events SHALL be created. Foreground calls SHALL NOT count.

#### Scenario: Ninth spawn rejected

- **GIVEN** `maxBackgroundPending: 8` and 8 background subagents queued or running
- **WHEN** another background `Agent` call is made
- **THEN** it SHALL return an error result listing the 8 ids
- **AND** no `subagents:created` SHALL be emitted for it

#### Scenario: Foreground unaffected

- **GIVEN** 8 outstanding background subagents and `maxBackgroundPending: 8`
- **WHEN** a foreground `Agent` call is made
- **THEN** it SHALL NOT be rejected by the pending cap

### Requirement: Background subagents SHALL honor an optional run-time limit

`DashboardAgentSettings` SHALL gain `backgroundTimeoutSec` (default `0` = off); `Agent` SHALL accept `timeout_s` overriding it per call. The limit SHALL count from slot grant. On expiry the subagent SHALL be stopped through the shared stop path with `stopReason: "running"` and `stoppedBy: "timeout"`.

#### Scenario: Timeout aborts a long run

- **GIVEN** a background spawn with `timeout_s: 60`
- **WHEN** the run is still going 60 s after starting
- **THEN** it SHALL end `stopped` with `stoppedBy: "timeout"`

#### Scenario: Queue time not counted

- **GIVEN** `timeout_s: 60` and the subagent waited 120 s in `queued`
- **WHEN** it starts running
- **THEN** it SHALL still have 60 s before the limit applies

### Requirement: Background subagents SHALL be stopped on session shutdown

On `session_shutdown`, every queued or running background subagent of the activation SHALL be stopped through the shared stop path with `stoppedBy: "shutdown"`. The handler SHALL be idempotent.

#### Scenario: Shutdown with work outstanding

- **GIVEN** 1 running and 1 queued background subagent
- **WHEN** `session_shutdown` fires
- **THEN** both SHALL end `stopped` with `stoppedBy: "shutdown"`, and no slot SHALL stay held
