# subagent-spawn-cost Specification

## Purpose
TBD - created by syncing change reduce-fanout-parent-stall. Update Purpose after archive.

## Requirements

### Requirement: Child sessions SHALL receive an isolated lean resource loader

`runAgentTool` SHALL pass a `resourceLoader` to every `createAgentSession` call. The loader SHALL be a `DefaultResourceLoader({ cwd, agentDir, noSkills: true, noPromptTemplates: true, noThemes: true, extensionsOverride })` constructed and `reload()`ed once per spawn. Loaders SHALL NOT be shared between concurrent child sessions. The `extensionsOverride` SHALL remove every extension's handlers for `turn_end`, `agent_end`, `agent_before_settle` and `agent_settled`, and SHALL leave all other handlers and all extension tools in place.

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

### Requirement: Concurrent child runs SHALL be bounded by `maxConcurrent`

`DashboardAgentSettings` SHALL gain `maxConcurrent: number` (default `4`; `0` = unlimited). The extension SHALL hold a process-wide FIFO semaphore; an `Agent` call SHALL emit `subagents:created` with `status: "queued"` immediately, acquire the semaphore BEFORE loader access and `createAgentSession`, and release it when the run reaches a terminal state.

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
