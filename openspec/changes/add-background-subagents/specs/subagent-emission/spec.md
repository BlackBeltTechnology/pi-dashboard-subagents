# Spec Delta

## MODIFIED Requirements

### Requirement: The extension SHALL register an `Agent` tool that spawns foreground subagents in-memory

The extension's `activate` entry point SHALL call `pi.registerTool` exactly once with a `ToolDefinition` named `"Agent"`, and, when `allowBackground` is on, once each for `AgentStatus`, `AgentMessages`, `AgentList` and `AgentCancel`. The tool's `execute` callback SHALL spawn a subagent via `createAgentSession` with `sessionManager: SessionManager.inMemory(cwd)`. The extension SHALL NOT spawn a separate `pi` CLI process for the subagent.

#### Scenario: Single Agent tool registration at activation

- **WHEN** the extension activates in a fresh pi session
- **THEN** `pi.registerTool` is called exactly once with `tool.name === "Agent"`
- **AND** the registered tool's parameters schema includes at minimum `subagent_type`, `description`, and `prompt`

#### Scenario: Background tools registered only when enabled

- **WHEN** the extension activates with `allowBackground: false`
- **THEN** `"Agent"` SHALL be the only tool registered
- **WHEN** it activates with `allowBackground: true`
- **THEN** `AgentStatus`, `AgentMessages`, `AgentList` and `AgentCancel` SHALL each be registered exactly once

#### Scenario: In-memory subagent session per Agent tool invocation

- **WHEN** the LLM invokes the `Agent` tool with valid args
- **THEN** the extension SHALL call `createAgentSession` with a fresh `SessionManager.inMemory(cwd)`
- **AND** the resulting subagent session SHALL NOT write any `.jsonl` file under `~/.pi/agent/sessions/`
- **AND** no `pi` CLI child process SHALL be spawned via `child_process.spawn` for the subagent run

#### Scenario: Subagent tool set excludes the Agent tool to prevent recursive nesting

- **GIVEN** a subagent session has been created
- **WHEN** the extension finalizes the subagent's active tool set
- **THEN** it SHALL call `session.setActiveToolsByName(...)` with a list that does NOT include `"Agent"`, `"AgentStatus"`, `"AgentMessages"`, `"AgentList"` or `"AgentCancel"`
- **AND** the subagent SHALL NOT be able to spawn nested sub-subagents or manage background subagents
