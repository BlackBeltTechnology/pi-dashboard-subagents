# subagent-spawn-cost Specification

## Purpose
Keeps spawning many subagents cheap for the parent process: each child gets its own lean resource loader, concurrent children are bounded by a FIFO `maxConcurrent` queue, and a parent abort is honored while a child is still being constructed.

## Requirements

### Requirement: Child sessions SHALL receive an isolated lean resource loader

`runAgentTool` SHALL pass a `resourceLoader` to every `createAgentSession` call. The loader SHALL be a `DefaultResourceLoader({ cwd, agentDir, noSkills: true, noPromptTemplates: true, noThemes: true, extensionsOverride })` constructed and `reload()`ed once per spawn. Loaders SHALL NOT be shared between concurrent child sessions.

#### Scenario: each spawn gets its own loader

- **WHEN** two `Agent` calls run for the same cwd `/p`
- **THEN** `createAgentSession` SHALL receive a different `resourceLoader` object for each
- **AND** `DefaultResourceLoader.reload` SHALL have been called once per spawn

#### Scenario: loader options skip unused resources

- **WHEN** a child session is created
- **THEN** its `DefaultResourceLoader` SHALL be constructed with `noSkills`, `noPromptTemplates` and `noThemes` set to `true`
- **AND** with the child's own `cwd`

#### Scenario: failed reload fails the tool call

- **GIVEN** `reload()` rejects for a spawn
- **WHEN** that `Agent` call runs
- **THEN** the tool SHALL return an error result
- **AND** no loader SHALL be retained for reuse

#### Scenario: tool surface is unchanged

- **WHEN** a child is spawned through the lean loader
- **THEN** `session.getActiveToolNames()` before the `Agent` strip SHALL equal the set a fresh default loader would produce

#### Scenario: settlement hooks do not run in the child

- **GIVEN** an extension registers `agent_end`, `agent_before_settle`, `agent_settled` and `turn_end` handlers
- **WHEN** a child session built by the lean loader completes a run
- **THEN** none of those handlers SHALL be invoked for the child run
- **AND** the same extension's `message_end` and `tool_call` handlers SHALL still be invoked
- **AND** the parent session's handler maps SHALL be unchanged

### Requirement: Child loaders SHALL strip settlement-event handlers only

The loader's `extensionsOverride` SHALL remove every extension's handlers for `turn_end`, `agent_end`, `agent_before_settle` and `agent_settled`, and SHALL leave all other handlers and all extension tools in place.

#### Scenario: Override touches only the child's extension objects

- **WHEN** the override runs on a child loader's extension set
- **THEN** only the four settlement event keys SHALL be deleted from each extension's handler map
- **AND** every other handler key and every registered tool SHALL remain

### Requirement: Concurrent child runs SHALL be bounded by `maxConcurrent`

`maxConcurrent` (default `4`, `0` = unlimited, clamped to 0–64) SHALL bound a process-wide FIFO semaphore. An `Agent` call SHALL emit `subagents:created` (`queued`) at once, acquire a slot before loader and session work, and release it on its terminal state. A call SHALL be granted at once only when no call is waiting. While calls wait, the limit SHALL be re-checked about every second.

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

### Requirement: Parent abort SHALL be honored during child construction

After the spawn slot is granted, `runAgentTool` SHALL check the parent `signal` after building the child loader and again after `createAgentSession` resolves. If the signal has aborted at either point, the call SHALL resolve with `status: "aborted"` without calling `session.prompt()`, and any created session SHALL be disposed.

#### Scenario: abort while the loader reloads
- **GIVEN** the parent `signal` aborts while `DefaultResourceLoader.reload()` is pending
- **WHEN** `reload()` resolves
- **THEN** `createAgentSession` SHALL NOT be called
- **AND** the tool SHALL return an error result with `details.status === "aborted"`
- **AND** `subagents:failed` SHALL fire once with `error: "aborted by parent"`

#### Scenario: abort while the session is created
- **GIVEN** the parent `signal` aborts while `createAgentSession` is pending
- **WHEN** it resolves
- **THEN** `session.prompt` SHALL NOT be called
- **AND** `session.dispose` SHALL be called
- **AND** the tool SHALL return `details.status === "aborted"`

#### Scenario: no tokens spent after an early abort
- **GIVEN** a faux provider and an abort before `prompt()` would start
- **WHEN** the call resolves
- **THEN** the faux provider SHALL have received zero requests
