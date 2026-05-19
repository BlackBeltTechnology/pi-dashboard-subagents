## ADDED Requirements

### Requirement: The extension SHALL register an `Agent` tool that spawns foreground subagents in-memory

The extension's `activate` entry point SHALL call `pi.registerTool` exactly once with a `ToolDefinition` named `"Agent"`. The tool's `execute` callback SHALL spawn a subagent via `createAgentSession` with `sessionManager: SessionManager.inMemory(cwd)`. The extension SHALL NOT spawn a separate `pi` CLI process for the subagent.

#### Scenario: Single Agent tool registration at activation

- **WHEN** the extension activates in a fresh pi session
- **THEN** `pi.registerTool` is called exactly once with `tool.name === "Agent"`
- **AND** the registered tool's parameters schema includes at minimum `subagent_type`, `description`, and `prompt`

#### Scenario: In-memory subagent session per Agent tool invocation

- **WHEN** the LLM invokes the `Agent` tool with valid args
- **THEN** the extension SHALL call `createAgentSession` with a fresh `SessionManager.inMemory(cwd)`
- **AND** the resulting subagent session SHALL NOT write any `.jsonl` file under `~/.pi/agent/sessions/`
- **AND** no `pi` CLI child process SHALL be spawned via `child_process.spawn` for the subagent run

#### Scenario: Subagent tool set excludes the Agent tool to prevent recursive nesting

- **GIVEN** a subagent session has been created
- **WHEN** the extension finalizes the subagent's active tool set
- **THEN** it SHALL call `session.setActiveToolsByName(...)` with a list that does NOT include `"Agent"`
- **AND** the subagent SHALL NOT be able to spawn nested sub-subagents

### Requirement: The extension SHALL emit lifecycle events on pi's event bus using the `subagents:*` channel namespace

The dashboard bridge's emit intercept maps `subagents:*` channels to `subagent_*` protocol events. The extension SHALL emit on these channels (not its own namespace) so the dashboard's existing reducer + renderer light up without dashboard-side changes.

#### Scenario: subagents:created fires on tool invocation start

- **WHEN** the `Agent` tool's `execute` callback begins
- **THEN** `pi.events.emit("subagents:created", payload)` SHALL be called exactly once
- **AND** the payload SHALL include `{ id, type, description, details }`
- **AND** `details.agentId === payload.id`

#### Scenario: subagents:started fires after the session is created

- **WHEN** the subagent session has been instantiated and the run is about to begin
- **THEN** `pi.events.emit("subagents:started", payload)` SHALL be called with the current `AgentDetails` snapshot
- **AND** `details.status === "running"`

#### Scenario: subagents:started fires repeatedly as progress accumulates

- **GIVEN** a subagent run is in progress
- **WHEN** `entries[]`, `activity`, `toolUses`, or `turnCount` changes
- **THEN** `pi.events.emit("subagents:started", payload)` SHALL be called with the latest cumulative `details`
- **AND** the dashboard reducer SHALL replace `SessionState.subagents[agentId].entries` with the new array (replace, not append)

#### Scenario: Progress emissions are throttled to avoid event-bus flooding

- **GIVEN** session events arrive in rapid succession (e.g. many `text_delta` events per second)
- **WHEN** progress emissions are coalesced
- **THEN** the extension SHALL emit at most 4 progress updates per second per subagent
- **AND** the final `subagents:started` emission BEFORE `subagents:completed` SHALL flush the latest state regardless of throttle

#### Scenario: subagents:completed fires on successful prompt resolution

- **WHEN** `await session.prompt(effectivePrompt)` resolves successfully
- **THEN** `pi.events.emit("subagents:completed", payload)` SHALL be called exactly once
- **AND** the payload SHALL include `{ id, result, durationMs, tokens, toolUses, details }`
- **AND** `details.status === "completed"`
- **AND** `details.tokensUsage` SHALL contain `{ input, output, total }`

#### Scenario: subagents:failed fires on prompt rejection or session error

- **WHEN** `await session.prompt(effectivePrompt)` rejects, OR the subscription receives an error event
- **THEN** `pi.events.emit("subagents:failed", payload)` SHALL be called exactly once
- **AND** the payload SHALL include `{ id, error, durationMs, toolUses, details }`
- **AND** `details.entries` SHALL contain whatever entries had accumulated before the failure (not be cleared)

#### Scenario: Emissions are no-ops when pi.events is unavailable

- **GIVEN** `pi.events` is undefined (e.g. extension loads before the bus is wired)
- **WHEN** any emission helper is invoked
- **THEN** the call SHALL NOT throw
- **AND** the subagent run SHALL continue normally (silent degradation)

### Requirement: AgentDetails payload SHALL contain the full timeline + metadata the dashboard inspector consumes

Every emission's `details` field SHALL be an `AgentDetails` object matching the wire shape defined in `extensions/events.ts`. The dashboard's `add-subagent-inspector` reducer reads these fields by name.

#### Scenario: Required fields are always present

- **WHEN** any emission is sent
- **THEN** `details` SHALL contain at minimum: `agentId`, `displayName`, `description`, `subagentType`, `status`, `toolUses`, `tokens`, `durationMs`

#### Scenario: entries[] is populated for the timeline

- **GIVEN** the subagent has performed at least one tool call, emitted assistant text, or emitted a thinking block
- **WHEN** the next progress / completion / failure emission fires
- **THEN** `details.entries` SHALL be a non-empty array of `SubagentTimelineEntry` objects
- **AND** each entry SHALL have a `kind` value in `{"tool", "text", "thinking", "error"}`
- **AND** each entry SHALL have a `ts` epoch-ms timestamp

#### Scenario: Tool entries pair input args with output result

- **GIVEN** the subagent invokes a tool that runs to completion
- **WHEN** the `tool_execution_end` event is mapped to an entry
- **THEN** the entry SHALL be `{ kind: "tool", toolName, input, output, isError, ts }`
- **AND** `input` SHALL contain the args from the matching `tool_execution_start` event
- **AND** `output` SHALL contain the tool's result

#### Scenario: agentMdPath surfaces custom agent definitions

- **GIVEN** an agent type matches a file at `<cwd>/.pi/agents/<type>.md` OR `<getAgentDir()>/agents/<type>.md`
- **WHEN** the extension builds initial `AgentDetails`
- **THEN** `details.agentMdPath` SHALL be the absolute path of the first matching file (project preferred)
- **AND WHEN** no matching file exists (built-in or anonymous agent)
- **THEN** `details.agentMdPath` SHALL be undefined

#### Scenario: Token usage uses raw breakdown on completion

- **WHEN** `subagents:completed` fires
- **THEN** `details.tokensUsage` SHALL be `{ input, output, total }` with raw integer counts
- **AND** `details.tokens` SHALL be the display-formatted string (e.g. `"12.3k"`)

### Requirement: Context inheritance SHALL be compressed via verbatim compaction by default

When inheritance is on, the extension SHALL prepend a compressed copy of the parent's conversation to the subagent's prompt. The compression SHALL be verbatim-compaction (no LLM call, zero hallucination risk).

The extension SHALL read parent messages via pi-coding-agent's `ReadonlySessionManager` interface exposed at `ctx.sessionManager`. The specific API used SHALL be `getBranch(fromId?)`, which returns the current branch's entries in leaf→root path order. The extension SHALL filter those entries to those of `type === "message"`, extract `entry.message` (an `AgentMessage`), further filter to messages with role `"user"` or `"assistant"`, and reverse to chronological (root→leaf) order before feeding the result into the verbatim-compaction routine.

The extension SHALL NOT call any of the following because they do not exist on `ReadonlySessionManager`:

- `sessionManager.getMessages()` (never existed; the v0.1.1 shipped `extensions/events.ts:393–394` mistakenly references it via defensive optional chaining and silently returns no inherited context)
- `sessionManager.buildSessionContext()` (exists on the full `SessionManager` but is NOT part of the `Pick` set exposed as `ReadonlySessionManager`)

The extension MAY use defensive optional chaining (`sm?.getBranch?.()`) to soft-fail on future SDK shape changes, but the method name MUST be the real one.

#### Scenario: Parent messages are read via getBranch + filter

- **GIVEN** the extension is building the inherited prefix and inheritance is enabled
- **WHEN** it accesses parent conversation data
- **THEN** it SHALL call `ctx.sessionManager.getBranch()` (not `getMessages()`, not `getEntries()`, not `buildSessionContext()`)
- **AND** the resulting array SHALL be filtered to entries where `entry.type === "message"`
- **AND** each surviving entry's `entry.message` SHALL be extracted
- **AND** the extracted messages SHALL be filtered to roles `"user"` or `"assistant"` (tool results and custom messages SHALL be excluded — they are handled inside `compressParentContext` via the `content` block walker, not at the top-level list)
- **AND** the filtered list SHALL be reversed from leaf→root to root→leaf before being passed to `compressParentContext`

#### Scenario: Empty or missing branch is a no-op

- **GIVEN** the parent session has no messages, OR `ctx.sessionManager` is undefined, OR `getBranch()` returns an empty array
- **WHEN** `buildInheritedContext(ctx, opts)` is invoked with `isolated: false`
- **THEN** the function SHALL return `""` without throwing
- **AND** the subagent's prompt SHALL receive no `<parent-context>` prefix

#### Scenario: Forked sessions inherit only the active branch

- **GIVEN** the parent session has multiple branches (e.g. the user forked and made the new branch the active one)
- **WHEN** the extension builds the inherited prefix
- **THEN** only the entries on the CURRENT active branch (the one `getBranch()` walks) SHALL feed into compression
- **AND** entries on inactive forked branches SHALL NOT appear in the inherited prefix

#### Scenario: Inheritance default is ON

- **WHEN** the extension activates with no `config.json` present
- **THEN** `inheritContext` defaults to `true`
- **AND** new spawns inherit context unless overridden

#### Scenario: Compression keeps last N turn pairs verbatim

- **GIVEN** the parent session has 20 turn pairs of conversation
- **WHEN** the extension builds the inherited prefix with default settings (`recentTurns: 6`)
- **THEN** the prefix SHALL contain exactly the last 6 user/assistant turn pairs verbatim
- **AND** older turns SHALL NOT appear in the prefix

#### Scenario: Older tool outputs are masked past the tool-output window

- **GIVEN** the inherited prefix contains 6 turn pairs (`toolOutputWindow: 2`)
- **WHEN** rendering content for turn pairs 1-4 (older than the window)
- **THEN** `tool_result` blocks SHALL be replaced with `"[…tool output omitted, see earlier message]"`
- **AND** `tool_use` blocks SHALL be replaced with `"[tool_use: <name>]"`
- **AND** `thinking` blocks SHALL be replaced with `"[…thinking omitted…]"`
- **AND** text blocks > 2000 chars SHALL be truncated to ~1500 chars + `"[…truncated…]"`

#### Scenario: Hard cap with middle-truncation

- **GIVEN** the compressed prefix would exceed `maxChars` (default 24000)
- **WHEN** rendering the prefix
- **THEN** the middle portion SHALL be replaced with `"[…middle omitted for length…]"`
- **AND** the first ~40% of `maxChars` SHALL be preserved (head, including first turn)
- **AND** the trailing portion SHALL be preserved (most recent turns)

### Requirement: The Agent tool's JSON schema SHALL be controllable via the `exposeInheritanceInTool` setting

The tool's `parameters` schema SHALL be built conditionally at extension activation time based on the current `exposeInheritanceInTool` setting value. When the setting is `false`, the schema SHALL NOT include an `isolated` parameter. When the setting is `true`, the schema SHALL include `isolated` as an optional boolean. Pi-coding-agent's `registerTool` has no `unregisterTool` counterpart, so setting changes apply only after extension re-activation (`/reload` or new pi session).

#### Scenario: Lean schema when exposeInheritanceInTool is false (default)

- **GIVEN** `config.json` has `exposeInheritanceInTool: false` (or is absent)
- **WHEN** the extension activates and registers the Agent tool
- **THEN** the registered tool's `parameters` schema SHALL NOT include an `isolated` property

#### Scenario: Extended schema when exposeInheritanceInTool is true

- **GIVEN** `config.json` has `exposeInheritanceInTool: true`
- **WHEN** the extension activates and registers the Agent tool
- **THEN** the registered tool's `parameters` schema SHALL include `isolated` as `Type.Optional(Type.Boolean())`

#### Scenario: resolveIsolated honors the setting + per-call value

- **GIVEN** `exposeInheritanceInTool: false`, `inheritContext: true`, a per-call `args.isolated: true` value sneaks through
- **WHEN** `resolveIsolated(args.isolated)` is called
- **THEN** the result SHALL be `false` (per-call value ignored; global setting wins)
- **AND GIVEN** `exposeInheritanceInTool: true`, `inheritContext: true`, per-call `args.isolated: true`
- **WHEN** `resolveIsolated(args.isolated)` is called
- **THEN** the result SHALL be `true` (per-call value honored)

### Requirement: Settings file is the single source of truth at `~/.pi/agent/extensions/pi-dashboard-subagents/config.json`

The extension SHALL persist its settings at this path. Missing files / malformed JSON / missing fields SHALL fall back to baked-in defaults without throwing.

#### Scenario: Missing config falls back to defaults

- **WHEN** `loadSettings()` is called and the config file does not exist
- **THEN** the returned settings SHALL equal `DEFAULT_SETTINGS`
- **AND** no error SHALL be thrown

#### Scenario: Malformed JSON falls back to defaults with a warning

- **GIVEN** the config file contains invalid JSON
- **WHEN** `loadSettings()` is called
- **THEN** the returned settings SHALL equal `DEFAULT_SETTINGS`
- **AND** a warning SHALL be logged to stderr identifying the file path
- **AND** no error SHALL be thrown

#### Scenario: Partial config merges with defaults

- **GIVEN** the config file contains `{ "inheritContext": false }` only
- **WHEN** `loadSettings()` is called
- **THEN** `settings.inheritContext === false`
- **AND** `settings.exposeInheritanceInTool === false` (default)
- **AND** `settings.inheritance.recentTurns === 6` (default)

#### Scenario: saveSettings persists atomically and updates the cache

- **WHEN** `saveSettings({ inheritContext: false })` is called
- **THEN** the config file SHALL be written via a tmp+rename sequence
- **AND** the in-memory cache SHALL reflect the new value on the next `loadSettings()` call

#### Scenario: Setting changes require /reload (same-session caveat)

- **GIVEN** the user edits `config.json` while pi is running
- **WHEN** the user does NOT run `/reload`
- **THEN** the extension SHALL continue using the cached settings from initial activation
- **AND** running `/reload` (or starting a new pi session) SHALL re-trigger activation and pick up the new values
