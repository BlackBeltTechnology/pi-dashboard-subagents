## Why

`pi-dashboard-subagents` is a new pi extension intended to spawn **foreground subagents
in-memory** and emit a full structured timeline of every event, tool call, and
reasoning step to the pi-agent-dashboard. It exists because neither of the two
incumbent subagent extensions fits the dashboard's inspector requirements:

| Extension                          | Spawn model        | Session list  | Rich timeline | Background |
| ---------------------------------- | ------------------ | ------------- | ------------- | ---------- |
| `@tintinweb/pi-subagents`          | In-memory          | Clean ✓       | Summary only  | Yes        |
| `pi-subagents` (Nico Bailon)       | Separate process   | Cluttered ✗   | Full ✓        | Yes        |
| **`pi-dashboard-subagents` (this)**| **In-memory ✓**    | **Clean ✓**   | **Full ✓**    | No (out of scope) |

Today the package has `package.json`, `README.md`, a `.zed/` settings file, an
`events.ts` emission module, and a `settings.ts` settings module. The tool
registration entry point (`extensions/agent.ts`) is empty. This change
locks the contract for the v0.1.x line: which events fire, which fields the
dashboard sees, which knobs are user-configurable, and how context inheritance
behaves.

The change also captures three explicit out-of-scope items that came up during
exploration — background spawning, the `get_subagent_result` / `steer_subagent`
tools, and upstream prompt-cache fork behavior — so future contributors don't
re-litigate them.

## What Changes

- **NEW** `extensions/agent.ts` — implements the `Agent` tool registration via
  `pi.registerTool` + `defineTool`. Conditional TypeBox schema based on
  `exposeInheritanceInTool` setting. `execute` callback creates an in-memory
  `AgentSession`, subscribes to its events, emits `subagents:*` to pi's event
  bus, returns the final `AgentToolResult<AgentDetails>` to the parent session.
- **CONTRACT** the wire-protocol channels emitted to the dashboard bridge:
  - `subagents:created` → `subagent_created` (dashboard rename)
  - `subagents:started` → `subagent_started` (initial + cumulative progress)
  - `subagents:completed` → `subagent_completed` (success path)
  - `subagents:failed` → `subagent_failed` (error / abort path)
  Each emission carries `id: string` plus a `details: AgentDetails` payload
  matching the shape defined in `events.ts`.
- **CONTRACT** `AgentDetails.entries: SubagentTimelineEntry[]` is the Tier-1
  timeline the dashboard's `SubagentDetailView` renders. Entries cover four
  kinds: `tool` (per-tool-call with input/output), `text` (assistant message
  text on `text_end`), `thinking` (reasoning blocks on `thinking_end`),
  `error` (assistant errors).
- **CONTRACT** `AgentDetails.agentMdPath?: string` carries the absolute path
  to the agent's definition `.md` file (project-level `.pi/agents/<type>.md`
  or global `~/.pi/agent/agents/<type>.md`). Resolved by walking those two
  candidates at registration time. Undefined for built-in / anonymous agents.
- **CONTRACT** `AgentDetails.tokensUsage?: TokenUsage` (raw `{input, output, total}`)
  on the final emission, alongside the display-formatted `tokens: string`.
- **CONTEXT INHERITANCE** subagents inherit a compressed copy of the parent's
  conversation by default. Compression is verbatim-compaction (no LLM call):
  keep last N turn pairs verbatim, mask older tool outputs / large content,
  hard-cap by character count. Default knobs: `recentTurns=6`,
  `toolOutputWindow=2`, `maxChars=24_000`.
- **SETTINGS** persisted at `~/.pi/agent/extensions/pi-dashboard-subagents/config.json`:
  - `inheritContext: boolean` (default `true`) — whether inheritance is on by
    default for new spawns. Re-read on every spawn.
  - `exposeInheritanceInTool: boolean` (default `false`) — whether the `Agent`
    tool's schema exposes an `isolated` parameter for per-call LLM override.
    Read at extension activation; setting changes take effect on next pi
    `/reload` or new session.
  - `inheritance.recentTurns`, `inheritance.toolOutputWindow`, `inheritance.maxChars`
    — compression knobs (operator-controlled, never exposed to the LLM).
- **SCOPE LOCK** background spawning, `get_subagent_result`, `steer_subagent`,
  and upstream prompt-cache fork behavior are explicitly OUT OF SCOPE for the
  v0.1.x line. Documented as future-work in design.md.

## Capabilities

### New Capabilities

- `subagent-emission` — the wire-protocol contract for emitting subagent
  lifecycle and timeline events to the dashboard bridge. Owned by this
  extension; consumed by `@blackbelt-technology/pi-dashboard-extension`'s
  event-bus emit intercept.

## Impact

- `extensions/agent.ts` — currently empty; this change fills it (~400 LOC).
- `extensions/events.ts` — already shipped (459 LOC); minor doc updates **plus one bug fix**:
  `buildInheritedContext` currently reads parent messages via `ctx.sessionManager.getMessages?.()`
  (lines 393–394), but `ReadonlySessionManager` exposes no such method. The optional-chained
  call silently returns `undefined`, the array check fails, and inheritance is dead-on-arrival
  regardless of `inheritContext` / `isolated` settings. Fix is to read entries via
  `sessionManager.getBranch()` (or `.getEntries()`), filter to `type === "message"`, and
  extract `entry.message`. See design.md Decision 9 and tasks.md §9.
- `extensions/settings.ts` — already shipped (205 LOC); no behaviour change.
- `extensions/index.ts` — already shipped (75 LOC); will gain the `pi`
  extension entry-point default export.
- `README.md` — already up to date for the v0.1.x contract.
- `openspec/` — this change captures the contract; future v0.2.x changes
  amend / extend.

## Constraints picked up from pi-coding-agent

- `pi.registerTool` is one-way: there is no `unregisterTool`. The tool's
  JSON schema is fixed at registration time. The `exposeInheritanceInTool`
  setting therefore takes effect at extension activation; users run
  `/reload` (or start a new pi session) to apply schema changes.
- `AgentSession.setActiveToolsByName(names)` mutates the active tool set
  any time after `session_start`, applying on the next agent turn. We use
  this to exclude the `Agent` tool from the subagent's tool set
  (prevents recursive nesting).
- `SessionManager.inMemory(cwd)` is the only path to keep subagent sessions
  off disk. Required so subagents do not pollute `~/.pi/agent/sessions/`
  nor appear in the dashboard's session list.
- `session.prompt(text)` accepts a string only; there is no public API
  to inject pre-built message arrays with `cache_control` markers.
  Upstream prompt-cache fork behavior is therefore out of scope for v0.1.x.

## Out of scope (future work)

- Background subagents (async queue, persistent state, `get_subagent_result`,
  `steer_subagent`). The whole class of "subagent that survives the parent's
  current turn" is omitted to keep v0.1.x focused on synchronous, observable,
  short-lived runs.
- Upstream prompt-cache fork (Anthropic `cache_control: ephemeral`, OpenAI's
  automatic prefix cache, Gemini `createCachedContent`). Requires either
  lower-level pi-coding-agent SDK access (`createAgentSessionFromServices` /
  `AgentSessionRuntime`) or upstream additions to honor message-array
  cache markers. Tracked as a v0.2.x change.
- LLM-based summarization compression. The current verbatim-compaction
  strategy is zero-hallucination and free; LLM summarization adds cost
  + hallucination risk for marginal compression gains in this use case.
- Dashboard settings UI panel for `config.json`. Out of scope here — handled
  in a separate dashboard-plugin change once this extension stabilizes.
