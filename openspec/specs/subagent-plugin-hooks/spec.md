# subagent-plugin-hooks Specification

## Purpose
Defines the `pi.events` contract that lets other packages and plugins observe subagent lifecycle, intercept spawns and results, and query or cancel background subagents.

## Requirements

### Requirement: Lifecycle events SHALL identify background runs

Every `subagents:*` lifecycle event's `details` SHALL carry `background: boolean` and the subagent's resolved `cwd`. Existing channel names and payload fields SHALL be unchanged.

#### Scenario: Flag present on both kinds

- **WHEN** a foreground and a background subagent each emit `subagents:created`
- **THEN** their `details.background` SHALL be `false` and `true` respectively

#### Scenario: Cwd present

- **WHEN** a subagent spawned with `cwd: "/repo/.worktrees/x"` emits `subagents:created`
- **THEN** `details.cwd` SHALL be `/repo/.worktrees/x`

### Requirement: The extension SHALL emit `subagents:result_read`

`subagents:result_read` SHALL fire when a run result is consumed or shown, with `{ id, agentId, via }`. `via` SHALL be `wait` when an `AgentControl` `wait` returns the result, `push` when a push delivers its outcome, and `messages` when the `messages` action returns entries. `via: "status"` SHALL NOT be emitted.

#### Scenario: Result read

- **WHEN** `wait` returns `bg-a`'s completed result
- **THEN** `subagents:result_read` SHALL fire with `via: "wait"`

#### Scenario: Result read through push

- **WHEN** a push delivers `bg-a`'s outcome
- **THEN** `subagents:result_read` SHALL fire with `via: "push"`

### Requirement: `subagents:before_spawn` SHALL let a plugin veto or patch any spawn

Before any record, event or slot use, the extension SHALL emit `subagents:before_spawn` with a mutable `{ args, background, veto?, reason?, patch? }`. If a handler sets `veto: true`, `Agent` SHALL return an error result containing `reason` and nothing SHALL be created. `patch` MAY override `prompt`, `model` and `description`. It SHALL apply to foreground and background spawns.

#### Scenario: Veto

- **GIVEN** a handler sets `veto = true, reason = "budget exceeded"`
- **WHEN** `Agent` is called
- **THEN** the call SHALL return an error result containing `budget exceeded`
- **AND** no `subagents:created` SHALL be emitted

#### Scenario: Patch prompt

- **GIVEN** a handler sets `patch = { prompt: "X" }`
- **WHEN** `Agent` is called
- **THEN** the subagent SHALL run with prompt `X`

### Requirement: `subagents:before_store` SHALL let a plugin transform a terminal result

On every terminal state, before bounding, storing or returning the result, the extension SHALL emit `subagents:before_store` with a mutable `{ id?, agentId, background, status, result, patch? }`. When `patch.result` is a string it SHALL replace the result text.

#### Scenario: Redaction

- **GIVEN** a handler sets `patch = { result: "[redacted]" }`
- **WHEN** a background subagent completes
- **THEN** `wait` SHALL return `[redacted]` as its result

### Requirement: Intercept handlers SHALL be synchronous and fault-isolated

Intercept and query channels SHALL be filled synchronously during `emit`. Values set after `emit` returns SHALL be ignored. A throwing handler SHALL be caught and logged, and the spawn or result SHALL proceed as if that handler were absent.

#### Scenario: Throwing handler

- **GIVEN** a `subagents:before_spawn` handler that throws
- **WHEN** `Agent` is called
- **THEN** the spawn SHALL proceed normally

### Requirement: Query channels SHALL expose the background registry

The owning activation SHALL answer `subagents:list` (`{ filter?, out? }`) and `subagents:get` (`{ id, from?, limit?, kinds?, out? }`) by filling `out` with the same data as `AgentList` and `AgentStatus`/`AgentMessages`. A handler SHALL NOT overwrite an `out` that is already set. Stopping SHALL use the existing `subagents:stop` event; no separate cancel channel SHALL exist.

#### Scenario: Plugin lists agents

- **GIVEN** two background subagents exist
- **WHEN** a plugin emits `subagents:list` with an empty payload
- **THEN** `payload.out` SHALL hold both, with the same fields as `AgentList`

#### Scenario: Another activation's answer is kept

- **GIVEN** `payload.out` is already set when a second activation's handler runs
- **THEN** that handler SHALL leave `payload.out` unchanged

### Requirement: Typed helpers SHALL be exported for plugin authors

The package entry SHALL export payload types for every hook channel and helpers wrapping the query channels (list, get), `subagents:stop` and event subscription, so plugins need not hand-write channel names.

#### Scenario: Helper round-trip

- **WHEN** a plugin calls the exported list helper with its `pi` handle
- **THEN** it SHALL receive the same array a raw `subagents:list` emit would fill

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
