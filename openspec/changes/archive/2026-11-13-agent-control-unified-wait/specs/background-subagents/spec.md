## MODIFIED Requirements

### Requirement: Background subagents SHALL be managed through one `AgentControl` tool

Every parent-side background operation SHALL be an `action` of one tool, `AgentControl`: `wait`, `list`, `messages`, `cancel`, `reply` and `steer`. Each action SHALL accept only its own parameters. An unknown action, or missing required parameters, SHALL return an error result naming the valid actions. The tools `AgentStatus`, `AgentMessages`, `AgentList` and `AgentCancel` SHALL NOT be registered, and there SHALL be no `status` action.

#### Scenario: One tool for every action

- **WHEN** the extension activates with `allowBackground: true`
- **THEN** exactly two tools SHALL be registered: `Agent` and `AgentControl`

#### Scenario: Unknown action

- **WHEN** `AgentControl({ action: "explode" })` is called
- **THEN** it SHALL return an error result listing `wait`, `list`, `messages`, `cancel`, `reply` and `steer`

#### Scenario: Former status action

- **WHEN** `AgentControl({ action: "status", ids: ["bg-a"] })` is called
- **THEN** it SHALL return an error result naming the valid actions and pointing to `wait` with `until: "none"`

#### Scenario: Missing parameters

- **WHEN** `AgentControl({ action: "reply" })` is called without `id`, `question_id` and `answer` or `replies`
- **THEN** it SHALL return an error result naming the missing parameters

### Requirement: Finished background results SHALL be stored and readable

At the end of every run, the extension SHALL store status, result text or error, token usage, turns, duration, run number and the timeline, readable for the rest of the session through `wait` with explicit `ids`. Delivery into the parent is governed by the `subagent-orchestration` push requirement and the `notifyParent` setting.

#### Scenario: Result available later

- **GIVEN** a background subagent completed while the parent was idle
- **WHEN** the LLM later calls `AgentControl({ action: "wait", ids, until: "none" })` with its id
- **THEN** the stored result text SHALL be returned, together with its turns and tokens

### Requirement: The `cancel` action SHALL stop background subagents through the shared stop path

`AgentControl({ action: "cancel", ids, status? })` SHALL accept an id list or `"all"`, optionally filtered by `status` (`queued`|`running`|`idle`). Queued and running ones SHALL stop as with `subagents:stop` (`stopped`, `stoppedBy: "tool"`), settling any pending `ask_parent`. Idle ones SHALL be disposed, keeping their last result. Each id SHALL return `stopped`, `disposed`, `already_finished` or `not_found`, without waiting; partial timelines SHALL stay readable. After the outcomes, the return SHALL include the progress line of every touched child that still has a record.

#### Scenario: Cancel a running subagent

- **WHEN** `AgentControl({ action: "cancel", ids: ["bg-a"] })` is called on a running subagent
- **THEN** the outcome SHALL be `stopped`
- **AND** the subagent SHALL emit `subagents:completed` with `details.status: "stopped"`, `stopReason: "running"`, `stoppedBy: "tool"`
- **AND** the `messages` action SHALL still return its entries

#### Scenario: Progress line in the return

- **GIVEN** `bg-a` is running with 1.2k tokens
- **WHEN** `AgentControl({ action: "cancel", ids: ["bg-a"] })` is called
- **THEN** the return SHALL include `bg-a`'s progress line with `1.2k tokens`

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

## REMOVED Requirements

### Requirement: The `status` action SHALL report and optionally wait for background subagents

**Reason**: Two blocking paths (`status` on registry state, `wait` on a separate mailbox) disagreed: double delivery, no progress in `wait`, and `wait` hanging with no live child. `status` is folded into `wait`.

**Migration**: `status {ids}` → `wait {ids, until: "none"}`; `status {ids, wait: "any"}` → `wait {ids, until: "any"}`; `status {ids, wait: "all"}` → `wait {ids, until: "all"}`. Liveness lines become progress lines with the same fields plus the latest assistant text.
