# Spec Delta

## RENAMED Requirements

- FROM: ### Requirement: `AgentStatus` SHALL report and optionally wait for background subagents
- TO: ### Requirement: The `status` action SHALL report and optionally wait for background subagents

- FROM: ### Requirement: `AgentMessages` SHALL return a paged, bounded view of a subagent's timeline
- TO: ### Requirement: The `messages` action SHALL return a paged, bounded view of a subagent's timeline

- FROM: ### Requirement: `AgentList` SHALL list the session's background subagents
- TO: ### Requirement: The `list` action SHALL list the session's background subagents

- FROM: ### Requirement: `AgentCancel` SHALL stop background subagents through the shared stop path
- TO: ### Requirement: The `cancel` action SHALL stop background subagents through the shared stop path

## ADDED Requirements

### Requirement: Background subagents SHALL be managed through one `AgentControl` tool

Every parent-side background operation SHALL be an `action` of one tool, `AgentControl`: `status`, `list`, `messages`, `cancel`, `wait`, `reply` and `steer`. Each action SHALL accept only its own parameters. An unknown action, or missing required parameters, SHALL return an error result naming the valid actions. The tools `AgentStatus`, `AgentMessages`, `AgentList` and `AgentCancel` SHALL NOT be registered.

#### Scenario: One tool for every action

- **WHEN** the extension activates with `allowBackground: true`
- **THEN** exactly two tools SHALL be registered: `Agent` and `AgentControl`

#### Scenario: Unknown action

- **WHEN** `AgentControl({ action: "explode" })` is called
- **THEN** it SHALL return an error result listing `status`, `list`, `messages`, `cancel`, `wait`, `reply` and `steer`

#### Scenario: Missing parameters

- **WHEN** `AgentControl({ action: "reply" })` is called without `id`, `question_id` and `answer` or `replies`
- **THEN** it SHALL return an error result naming the missing parameters

### Requirement: Finished background results SHALL be stored and readable

At the end of every run, the extension SHALL store status, result text or error, token usage, duration, run number and the timeline, readable for the rest of the session. Delivery into the parent is governed by the `subagent-orchestration` push requirement and the `notifyParent` setting.

#### Scenario: Result available later

- **GIVEN** a background subagent completed while the parent was idle
- **WHEN** the LLM later calls `AgentControl({ action: "status", ids })` with its id
- **THEN** the stored result text SHALL be returned

## REMOVED Requirements

### Requirement: Finished background results SHALL be stored and never pushed to the parent

**Reason**: Orchestration needs finished work and child questions to reach the parent without polling. The never-push rule is replaced by the batched, non-interrupting push in `subagent-orchestration`.
**Migration**: Set `notifyParent: false` to keep the previous pull-only behaviour. Storage of results continues under "Finished background results SHALL be stored and readable".

## MODIFIED Requirements

### Requirement: Background support SHALL be controlled by the `allowBackground` setting

`DashboardAgentSettings` SHALL gain `allowBackground: boolean` (default `true`), read once at activation. When `false`, the `Agent` schema SHALL NOT include `run_in_background` or `timeout_s`, and `AgentControl` SHALL NOT be registered. When `true`, both parameters and `AgentControl` SHALL be present. Changes SHALL apply only after re-activation.

#### Scenario: Enabled by default

- **GIVEN** no `allowBackground` key in the config file
- **WHEN** the extension activates
- **THEN** the `Agent` schema SHALL include optional `run_in_background` and `timeout_s`
- **AND** the tool `AgentControl` SHALL be registered

#### Scenario: Disabled hides the feature entirely

- **GIVEN** `allowBackground: false`
- **WHEN** the extension activates
- **THEN** only the `Agent` tool SHALL be registered
- **AND** its schema SHALL NOT contain `run_in_background` or `timeout_s`

#### Scenario: Setting change needs reload

- **GIVEN** the extension activated with `allowBackground: true`
- **WHEN** the config file is edited to `false` without `/reload`
- **THEN** the registered tools and schema SHALL stay unchanged

### Requirement: Outstanding background subagents SHALL be capped by `maxBackgroundPending`

`DashboardAgentSettings` SHALL gain `maxBackgroundPending` (default `8`, `0` = unlimited), read per call. A background spawn while queued+running background subagents ≥ the cap SHALL be rejected as an error result naming the outstanding ids and suggesting the `AgentControl` `status` or `cancel` action. No record or events SHALL be created. Foreground calls and idle subagents SHALL NOT count.

#### Scenario: Ninth spawn rejected

- **GIVEN** `maxBackgroundPending: 8` and 8 background subagents queued or running
- **WHEN** another background `Agent` call is made
- **THEN** it SHALL return an error result listing the 8 ids
- **AND** no `subagents:created` SHALL be emitted for it

#### Scenario: Foreground unaffected

- **GIVEN** 8 outstanding background subagents and `maxBackgroundPending: 8`
- **WHEN** a foreground `Agent` call is made
- **THEN** it SHALL NOT be rejected by the pending cap

### Requirement: The `status` action SHALL report and optionally wait for background subagents

`AgentControl({ action: "status", ids, wait?, timeout_s? })` SHALL accept ids (short id, full `agentId` or unique prefix). `wait: "none"` (default) returns current state; `"any"` returns once one has finished its current run (terminal or `idle`); `"all"` once all have. When waiting, `timeout_s` SHALL default to 300; expiry returns current state without cancelling. Aborting ends only the wait. Each id SHALL get a liveness line. Output SHALL be bounded by `resultMaxChars`.

#### Scenario: Snapshot without waiting

- **GIVEN** a running background subagent `bg-a`
- **WHEN** `AgentControl({ action: "status", ids: ["bg-a"] })` is called
- **THEN** it SHALL return immediately with `status: running`

#### Scenario: Wait for all

- **GIVEN** background subagents `bg-a` and `bg-b` running
- **WHEN** `AgentControl({ action: "status", ids: ["bg-a","bg-b"], wait: "all" })` is called
- **THEN** it SHALL resolve only after both have finished their current run, returning both results

#### Scenario: Wait for any

- **WHEN** `AgentControl({ action: "status", ids: ["bg-a","bg-b"], wait: "any" })` is called and `bg-b` finishes first
- **THEN** it SHALL return `bg-b`'s result and `bg-a`'s current status

#### Scenario: Idle counts as finished

- **GIVEN** `bg-a` finished run 1 and is `idle`
- **WHEN** `AgentControl({ action: "status", ids: ["bg-a"], wait: "all" })` is called
- **THEN** it SHALL return immediately with run 1's result and `status: idle`

#### Scenario: Default wait timeout

- **WHEN** `AgentControl({ action: "status", ids: ["bg-a"], wait: "all" })` is called without `timeout_s` and `bg-a` runs longer than 300 s
- **THEN** it SHALL return after 300 s with `bg-a`'s current status, and `bg-a` SHALL keep running

#### Scenario: Wait timeout does not cancel

- **WHEN** `AgentControl({ action: "status", ids: ["bg-a"], wait: "all", timeout_s: 5 })` passes 5 s with `bg-a` still running
- **THEN** it SHALL return `bg-a` with `status: running`
- **AND** `bg-a` SHALL keep running

#### Scenario: Interrupting the wait leaves the subagent running

- **WHEN** the call's signal aborts during a wait
- **THEN** the call SHALL end and the waited subagents SHALL keep running

#### Scenario: Liveness line while asking

- **GIVEN** `bg-a` is blocked in `ask_parent` with question `q1`
- **WHEN** `AgentControl({ action: "status", ids: ["bg-a"] })` is called
- **THEN** its line SHALL show status, run, turn, cwd, `asking q1`, the shortened question and the short reply hint

#### Scenario: Unknown id

- **WHEN** an id matches no record
- **THEN** that id SHALL be reported `not_found` without failing the other ids

### Requirement: The `messages` action SHALL return a paged, bounded view of a subagent's timeline

`AgentControl({ action: "messages", id, from?, limit?, kinds? })` SHALL work on queued, running, idle and finished background subagents. Without `from` it SHALL return the last `limit` (default 20) entries, with `total` and `next_from`. `kinds` SHALL filter before paging. Each entry field SHALL be cut to `entryFieldMaxChars` and the response bounded by `resultMaxChars`. The tool description SHALL mark this action as debug-only, and point orchestration to `wait`, `status` and `steer`.

#### Scenario: Tail by default

- **GIVEN** a subagent with 50 timeline entries
- **WHEN** `AgentControl({ action: "messages", id })` is called
- **THEN** entries 30–49 SHALL be returned with `total: 50`

#### Scenario: Incremental read of a running subagent

- **GIVEN** a previous call returned `next_from: 12`
- **WHEN** `AgentControl({ action: "messages", id, from: 12 })` is called after more steps ran
- **THEN** only entries from index 12 onward SHALL be returned

#### Scenario: Kind filter

- **WHEN** `AgentControl({ action: "messages", id, kinds: ["text"] })` is called
- **THEN** only `text` entries SHALL be returned

#### Scenario: Debug-only description

- **WHEN** `AgentControl` is registered
- **THEN** its description SHALL call `messages` a debug view and direct orchestration to `wait`, `status` and `steer`

### Requirement: The `list` action SHALL list the session's background subagents

`AgentControl({ action: "list" })` SHALL return every background subagent of the current activation with id, `subagent_type`, description, status (including `idle`), run, age, token total, cwd and whether a finished result is unread. It SHALL end with counts of running, queued, idle and finished-unread.

#### Scenario: Mixed states listed

- **GIVEN** one running, one queued, one idle and one completed background subagent
- **WHEN** `AgentControl({ action: "list" })` is called
- **THEN** all four SHALL be listed with their statuses and cwds
- **AND** the counts line SHALL read 1 running, 1 queued, 1 idle, and the finished-unread count

### Requirement: The `cancel` action SHALL stop background subagents through the shared stop path

`AgentControl({ action: "cancel", ids, status? })` SHALL accept an id list or `"all"`, optionally filtered by `status` (`queued`|`running`|`idle`). Queued and running subagents SHALL stop exactly as with `subagents:stop`, giving `status: "stopped"` with `stopReason` and `stoppedBy: "tool"`, and any pending `ask_parent` SHALL settle. Idle subagents SHALL be disposed, keeping their last result. Each id SHALL return `stopped`, `disposed`, `already_finished` or `not_found`. It SHALL not wait, and partial timelines SHALL stay readable.

#### Scenario: Cancel a running subagent

- **WHEN** `AgentControl({ action: "cancel", ids: ["bg-a"] })` is called on a running subagent
- **THEN** the outcome SHALL be `stopped`
- **AND** the subagent SHALL emit `subagents:completed` with `details.status: "stopped"`, `stopReason: "running"`, `stoppedBy: "tool"`
- **AND** the `messages` action SHALL still return its entries

#### Scenario: Bulk-cancel the queue

- **GIVEN** 2 running and 5 queued background subagents
- **WHEN** `AgentControl({ action: "cancel", ids: "all", status: "queued" })` is called
- **THEN** the 5 queued SHALL end `stopped` with `stopReason: "queued"` without starting
- **AND** the 2 running SHALL be unaffected

#### Scenario: Dispose an idle subagent

- **GIVEN** `bg-a` is `idle`
- **WHEN** `AgentControl({ action: "cancel", ids: ["bg-a"] })` is called
- **THEN** the outcome SHALL be `disposed`, its last result SHALL stay readable, and `steer` on it SHALL return `not_alive`

#### Scenario: Already finished

- **WHEN** `cancel` targets a disposed subagent
- **THEN** its outcome SHALL be `already_finished` and its stored result SHALL be unchanged

#### Scenario: Bus stop on a background subagent

- **WHEN** `subagents:stop` names a running background subagent
- **THEN** it SHALL end `stopped` with `stoppedBy: "event"` and its stored result SHALL reflect that

### Requirement: Background subagents SHALL be stopped on session shutdown

On `session_shutdown`, every queued or running background subagent of the activation SHALL be stopped through the shared stop path with `stoppedBy: "shutdown"`. Every idle one SHALL be disposed, every pending `ask_parent` SHALL be settled, and no push SHALL be sent afterwards. The handler SHALL be idempotent.

#### Scenario: Shutdown with work outstanding

- **GIVEN** 1 running, 1 queued and 1 idle background subagent
- **WHEN** `session_shutdown` fires
- **THEN** the running and queued SHALL end `stopped` with `stoppedBy: "shutdown"`, the idle SHALL be disposed, and no slot SHALL stay held

#### Scenario: No push after shutdown

- **GIVEN** a batch push is pending
- **WHEN** `session_shutdown` fires
- **THEN** no `sendMessage` SHALL be made on the parent
