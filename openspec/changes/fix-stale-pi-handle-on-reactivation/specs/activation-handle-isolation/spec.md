## ADDED Requirements

### Requirement: The Agent tool SHALL bind its `pi` handle per activation via lexical closure

`extensions/agent.ts` SHALL NOT hold the `ExtensionAPI` handle in mutable
module-level state. `activate(pi)` SHALL pass its own `pi` into the tool factory,
and the tool's `execute` callback SHALL reach `pi` only through that closure.
Consequently, a second `activate()` on the same module instance — as happens when
a nested subagent session re-loads the extension set — SHALL NOT alter the handle
used by any previously registered tool.

#### Scenario: re-activation does not rebind an existing tool's handle

- **GIVEN** `activate(piA)` has registered an `Agent` tool
- **WHEN** `activate(piB)` runs on the same module instance with a different
  handle `piB`
- **THEN** the tool registered by `activate(piA)` SHALL still emit through `piA`
- **AND** the tool registered by `activate(piB)` SHALL emit through `piB`

#### Scenario: invalidating a later handle does not break an earlier tool

- **GIVEN** `activate(piA)` then `activate(piB)` have both run
- **WHEN** `piB`'s underlying extension runtime is invalidated (as
  `AgentSession.dispose()` does at the end of a subagent run)
- **THEN** invoking the tool registered by `activate(piA)` SHALL NOT throw
  "This extension ctx is stale…"

#### Scenario: no module-level handle remains

- **WHEN** `extensions/agent.ts` is inspected
- **THEN** there SHALL be no module-scoped variable holding an `ExtensionAPI`
- **AND** no `getPi()`-style accessor reading such a variable

### Requirement: Consecutive Agent tool calls in one session SHALL all succeed

A session SHALL be able to run the `Agent` tool an unbounded number of times.
Completion of one subagent run — including the `session.dispose()` in
`runAgentTool`'s `finally` block — SHALL NOT leave the parent session's `Agent`
tool unusable.

#### Scenario: second consecutive spawn succeeds

- **GIVEN** one `Agent` call has completed and its subagent session was disposed
- **WHEN** a second `Agent` call is made in the same parent session
- **THEN** it SHALL spawn normally and return a result
- **AND** it SHALL NOT fail with "This extension ctx is stale after session
  replacement or reload"

#### Scenario: failed run does not poison later runs

- **GIVEN** an `Agent` call that ends in the error path (the `catch` branch), and
  whose `finally` still disposes the subagent session
- **WHEN** a subsequent `Agent` call is made
- **THEN** it SHALL spawn normally
