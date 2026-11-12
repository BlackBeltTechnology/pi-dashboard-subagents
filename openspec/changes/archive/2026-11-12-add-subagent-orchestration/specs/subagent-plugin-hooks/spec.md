# Spec Delta

## MODIFIED Requirements

### Requirement: Lifecycle events SHALL identify background runs

Every `subagents:*` lifecycle event's `details` SHALL carry `background: boolean` and the subagent's resolved `cwd`. Existing channel names and payload fields SHALL be unchanged.

#### Scenario: Flag present on both kinds

- **WHEN** a foreground and a background subagent each emit `subagents:created`
- **THEN** their `details.background` SHALL be `false` and `true` respectively

#### Scenario: Cwd present

- **WHEN** a subagent spawned with `cwd: "/repo/.worktrees/x"` emits `subagents:created`
- **THEN** `details.cwd` SHALL be `/repo/.worktrees/x`

## ADDED Requirements

### Requirement: Every orchestration action SHALL emit an observe event

The extension SHALL emit one event per affected subagent for each orchestration action. Batch and broadcast calls fan out to per-id events. Channels: `question`, `answer` (`via` is `reply` or `cancel`), `slot` (`released`, `reacquire_queued`, `reacquired`), `steer`, `idle`, `disposed` (with reason), `mail`, `mail_dropped`, `wait` (`start` / `end`) and `push`, all under `subagents:`.

#### Scenario: Ask and reply observed

- **WHEN** a subagent asks and the parent replies
- **THEN** `subagents:question`, `subagents:mail`, `subagents:slot` (`released`), `subagents:answer` (`via: "reply"`) and `subagents:slot` (`reacquired`) SHALL be emitted in that order for the same `question_id` and id

#### Scenario: Batch and broadcast fan out

- **WHEN** `reply` answers 3 questions in one call, or `steer` targets 3 ids
- **THEN** 3 `subagents:answer` or 3 `subagents:steer` events SHALL be emitted, one per id

#### Scenario: Wait and push observed

- **WHEN** a `wait` call starts and returns 2 entries, and later a push sends 1 entry
- **THEN** `subagents:wait` SHALL be emitted with `phase: "start"` and then `phase: "end", returned: 2`
- **AND** `subagents:push` SHALL be emitted with `count: 1`

#### Scenario: Disposal reason observed

- **WHEN** an idle subagent is freed by the idle TTL
- **THEN** `subagents:disposed` SHALL be emitted with `reason: "ttl"`

### Requirement: Orchestration events SHALL carry no conversation text

Orchestration event payloads SHALL carry ids, kinds, counters and results only. They SHALL NOT contain question, answer, steer message or outcome summary text.

#### Scenario: No text on the bus

- **WHEN** any orchestration event is emitted
- **THEN** its payload SHALL NOT contain the question, answer, steer message or summary text

### Requirement: Typed helpers SHALL cover orchestration events

The package entry SHALL export a payload type for every orchestration channel, alongside the existing hook types.

#### Scenario: Types exported

- **WHEN** a plugin imports the package entry
- **THEN** payload types for `question`, `answer`, `slot`, `steer`, `idle`, `disposed`, `mail`, `mail_dropped`, `wait` and `push` SHALL be available
