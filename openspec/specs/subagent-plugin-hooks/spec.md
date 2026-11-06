# subagent-plugin-hooks Specification

## Purpose
Defines the `pi.events` contract that lets other packages and plugins observe subagent lifecycle, intercept spawns and results, and query or cancel background subagents.

## Requirements

### Requirement: Lifecycle events SHALL identify background runs

Every `subagents:*` lifecycle event's `details` SHALL carry `background: boolean`. Existing channel names and payload fields SHALL be unchanged.

#### Scenario: Flag present on both kinds

- **WHEN** a foreground and a background subagent each emit `subagents:created`
- **THEN** their `details.background` SHALL be `false` and `true` respectively

### Requirement: The extension SHALL emit `subagents:result_read`

`subagents:result_read` SHALL fire when `AgentStatus` returns a terminal result or `AgentMessages` returns entries, with `{ id, agentId, via }` where `via` is `status` or `messages`.

#### Scenario: Result read

- **WHEN** `AgentStatus` returns `bg-a`'s completed result
- **THEN** `subagents:result_read` SHALL fire with `via: "status"`

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
- **THEN** `AgentStatus` SHALL return `[redacted]` as its result

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
