## MODIFIED Requirements

### Requirement: The extension SHALL emit `subagents:result_read`

`subagents:result_read` SHALL fire when a run result is consumed or shown, with `{ id, agentId, via }`. `via` SHALL be `wait` when an `AgentControl` `wait` returns the result, `push` when a push delivers its outcome, and `messages` when the `messages` action returns entries. `via: "status"` SHALL NOT be emitted.

#### Scenario: Result read

- **WHEN** `wait` returns `bg-a`'s completed result
- **THEN** `subagents:result_read` SHALL fire with `via: "wait"`

#### Scenario: Result read through push

- **WHEN** a push delivers `bg-a`'s outcome
- **THEN** `subagents:result_read` SHALL fire with `via: "push"`

### Requirement: `subagents:before_store` SHALL let a plugin transform a terminal result

On every terminal state, before bounding, storing or returning the result, the extension SHALL emit `subagents:before_store` with a mutable `{ id?, agentId, background, status, result, patch? }`. When `patch.result` is a string it SHALL replace the result text.

#### Scenario: Redaction

- **GIVEN** a handler sets `patch = { result: "[redacted]" }`
- **WHEN** a background subagent completes
- **THEN** `wait` SHALL return `[redacted]` as its result

### Requirement: Every orchestration action SHALL emit an observe event

The extension SHALL emit one event per affected subagent for each orchestration action. Batch and broadcast calls fan out to per-id events. Channels: `question`, `answer` (`via` is `reply` or `cancel`), `slot` (`released`, `reacquire_queued`, `reacquired`), `steer`, `idle`, `disposed` (with reason), `mail` (an entry became pending), `wait` (`start` / `end`) and `push`, all under `subagents:`. `mail_dropped` SHALL NOT be emitted, since pending entries are never dropped; its payload type stays exported.

#### Scenario: Ask and reply observed

- **WHEN** a subagent asks and the parent replies
- **THEN** `subagents:question`, `subagents:mail`, `subagents:slot` (`released`), `subagents:answer` (`via: "reply"`) and `subagents:slot` (`reacquired`) SHALL be emitted in that order for the same `question_id` and id

#### Scenario: Batch and broadcast fan out

- **WHEN** `reply` answers 3 questions in one call, or `steer` targets 3 ids
- **THEN** 3 `subagents:answer` or 3 `subagents:steer` events SHALL be emitted, one per id

#### Scenario: Wait and push observed

- **WHEN** a `wait` call starts and returns 2 pending entries, and later a push sends 1 entry
- **THEN** `subagents:wait` SHALL be emitted with `phase: "start"` and then `phase: "end", returned: 2`
- **AND** `subagents:push` SHALL be emitted with `count: 1`

#### Scenario: Disposal reason observed

- **WHEN** an idle subagent is freed by the idle TTL
- **THEN** `subagents:disposed` SHALL be emitted with `reason: "ttl"`
