# Spec Delta

## MODIFIED Requirements

### Requirement: The extension SHALL register an `Agent` tool that spawns foreground subagents in-memory

The extension's `activate` entry point SHALL call `pi.registerTool` exactly once with a `ToolDefinition` named `"Agent"`, and, when `allowBackground` is on, exactly once more with a `ToolDefinition` named `"AgentControl"` that carries every background action. The tool's `execute` callback SHALL spawn a subagent via `createAgentSession` with `sessionManager: SessionManager.inMemory(cwd)`, where `cwd` is the subagent's resolved cwd. The extension SHALL NOT spawn a separate `pi` CLI process for the subagent.

#### Scenario: Single Agent tool registration at activation

- **WHEN** the extension activates in a fresh pi session
- **THEN** `pi.registerTool` is called exactly once with `tool.name === "Agent"`
- **AND** the registered tool's parameters schema includes at minimum `subagent_type`, `description`, and `prompt`, and an optional `cwd`

#### Scenario: Background tools registered only when enabled

- **WHEN** the extension activates with `allowBackground: false`
- **THEN** `"Agent"` SHALL be the only tool registered
- **WHEN** it activates with `allowBackground: true`
- **THEN** `AgentControl` SHALL be registered exactly once, and no other background tool SHALL be registered

#### Scenario: In-memory subagent session per Agent tool invocation

- **WHEN** the LLM invokes the `Agent` tool with valid args
- **THEN** the extension SHALL call `createAgentSession` with a fresh `SessionManager.inMemory(cwd)` for the subagent's resolved cwd
- **AND** the resulting subagent session SHALL NOT write any `.jsonl` file under `~/.pi/agent/sessions/`
- **AND** no `pi` CLI child process SHALL be spawned via `child_process.spawn` for the subagent run

#### Scenario: Subagent tool set excludes the Agent tool to prevent recursive nesting

- **GIVEN** a subagent session has been created
- **WHEN** the extension finalizes the subagent's active tool set
- **THEN** it SHALL call `session.setActiveToolsByName(...)` with a list that does NOT include `"Agent"` or `"AgentControl"`
- **AND** the subagent SHALL NOT be able to spawn nested sub-subagents or manage background subagents
- **AND** the list SHALL include `"ask_parent"` if and only if the subagent runs in the background

## ADDED Requirements

### Requirement: Each finished background run SHALL be persisted in the parent session

At the end of every background run, the extension SHALL append one `subagents:run` custom entry to the parent session, carrying the same bounded details shape as the foreground `Agent` result plus id, run number and cwd. The entry SHALL NOT enter the model context. Foreground persistence through the `Agent` tool result SHALL be unchanged.

#### Scenario: Two runs, two entries

- **GIVEN** background subagent `bg-a` completes run 1, is steered, and completes run 2
- **WHEN** the parent session file is read
- **THEN** it SHALL contain two `subagents:run` entries for `bg-a`, with `run: 1` and `run: 2`

#### Scenario: Not in model context

- **WHEN** the parent's next model request is built
- **THEN** no `subagents:run` entry content SHALL be included in it
