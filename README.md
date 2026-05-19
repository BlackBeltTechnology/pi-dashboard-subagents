# pi-dashboard-subagents

A lightweight **foreground** subagent extension for [pi](https://github.com/mariozechner/pi).

Spawns subagents **in-memory** (no new sessions appear in `~/.pi/agent/sessions/`, no
clutter in the dashboard's session list) and emits **every event, tool call, and
reasoning step** as a structured timeline the pi-agent-dashboard can render in its
subagent inspector and pop out into a new tab.

## Scope

- **Foreground only.** Subagents block the caller until completion.
- **No background spawning.** No `get_subagent_result`. No `steer_subagent`.
- **No new sessions on disk.** Sessions live entirely in memory.
- **Full observability.** Every `tool_execution_end`, `text_end`, `thinking_end`,
  and error from the subagent's session is mirrored to the dashboard as a
  `SubagentTimelineEntry`.
- **Inherits parent context by default.** Opt-out with `isolated: true`.

## Context inheritance

> **Status note (v0.1.1 → v0.1.2):** the shipped v0.1.1 of `events.ts`
> attempted to read parent messages via a non-existent `ReadonlySessionManager.getMessages()`
> method, so inheritance silently returned an empty prefix. The fix — reading
> via `getBranch()` + filtering to message entries — lands together with the
> `extensions/agent.ts` tool registration (see openspec change
> `scaffold-foreground-subagent-extension` task §9).

By default, every subagent inherits a **compressed copy** of the parent's
recent conversation. The compression strategy is verbatim-compaction (zero
hallucination risk, no extra LLM calls):

```
Keep last N turn pairs (default N=6) verbatim.
For turns beyond the tool-output window (default last 2 turns):
  - tool_result blocks   → "[…tool output omitted, see earlier message]"
  - tool_use blocks      → "[tool_use: <name>]"
  - thinking blocks      → "[…thinking omitted…]"
  - large text (>2KB)    → first 1.5KB + "[…truncated…]"
Hard cap at 24K characters (~6K tokens) with mid-truncation.
```

### Settings

Two persistent settings live at:

```
~/.pi/agent/extensions/pi-dashboard-subagents/config.json
```

```json
{
  "inheritContext": true,
  "exposeInheritanceInTool": false,
  "inheritance": {
    "recentTurns": 6,
    "toolOutputWindow": 2,
    "maxChars": 24000
  }
}
```

| Setting                    | Meaning                                                                                          |
| -------------------------- | ------------------------------------------------------------------------------------------------ |
| `inheritContext`           | When `true`, every subagent inherits a compressed copy of parent context.                        |
| `exposeInheritanceInTool`  | When `true`, the `Agent` tool's JSON schema exposes an `isolated` parameter the LLM can flip. When `false` (default), the schema is fixed and the global `inheritContext` setting always applies. |
| `inheritance.recentTurns`  | Verbatim turn pairs kept (default 6).                                                            |
| `inheritance.toolOutputWindow` | Recent turns where tool outputs stay verbatim (default 2).                                   |
| `inheritance.maxChars`     | Hard cap on the compressed context (default 24000 chars ≈ 6K tokens).                            |

Four usage modes:

```
inheritContext=true,  exposeInheritanceInTool=false  (default)
  → every subagent inherits. LLM cannot opt out. Lean tool schema.

inheritContext=false, exposeInheritanceInTool=false
  → every subagent is isolated. LLM cannot opt in. Lean tool schema.

inheritContext=true,  exposeInheritanceInTool=true
  → inherits by default. LLM can set `isolated: true` per call to opt out.

inheritContext=false, exposeInheritanceInTool=true
  → isolated by default. LLM can set `isolated: false` per call to opt in.
```

Missing file or fields fall back to baked-in defaults. Settings are cached
after first read; edit the file and restart pi, or call `invalidateSettingsCache()`
programmatically to pick up changes.

### Compression is operator-controlled only

`recentTurns`, `toolOutputWindow`, and `maxChars` are never exposed to the
LLM under any setting. They're operator concerns — fine-tune them globally
by editing the config file, then restart pi.

## Upstream prompt caching — future work

The ideal architecture for context inheritance is what Claude Code calls
[Fork Agents](https://claude-code-from-source.com/ch09-fork-agents/):
the subagent's first provider call hits the **parent's cache** by sending
a byte-identical prefix marked with `cache_control: { type: "ephemeral" }`.
Result: 90% input cost reduction, 80% latency reduction on the inherited
context.

This extension does NOT yet implement true cache-fork behavior because
`pi-coding-agent`'s public `session.prompt(text)` API takes a string —
there's no path to inject pre-built message arrays with cache markers.
For now we accept token-savings-only from compression and leave upstream
caching as a follow-up.

Follow-up paths (when pi-coding-agent SDK supports them):

- Inject parent messages as initial session state via the lower-level
  `createAgentSessionFromServices` / `AgentSessionRuntime` API.
- Add `cache_control` markers at the inherited-prefix boundary.
- Anthropic: 90/80% reduction. OpenAI: automatic (just needs identical
  prefix). Gemini: explicit cache via `createCachedContent`.

## Why another subagent extension?

The two existing subagent extensions for pi each have a tradeoff:

| Extension                          | Spawn model        | Session list  | Rich timeline | Background |
| ---------------------------------- | ------------------ | ------------- | ------------- | ---------- |
| `@tintinweb/pi-subagents`          | In-memory          | Clean ✓       | Summary only  | Yes        |
| `pi-subagents` (Nico Bailon)       | Separate process   | Cluttered ✗   | Full ✓        | Yes        |
| **`pi-dashboard-subagents` (this)**| **In-memory ✓**    | **Clean ✓**   | **Full ✓**    | No (by design) |

This extension drops background/async complexity entirely and focuses on one
thing: foreground subagent runs with first-class observability for the
pi-agent-dashboard inspector.

## Install

```bash
npm install -g pi-dashboard-subagents
```

Then add to `~/.pi/agent/settings.json`:

```json
{
  "packages": [
    "npm:pi-dashboard-subagents"
  ]
}
```

Or for local development:

```json
{
  "packages": [
    "/absolute/path/to/pi-dashboard-subagents"
  ]
}
```

## Usage

In any pi session, invoke the tool:

```
Agent(
  subagent_type: "Explore",
  description: "Find auth flows",
  prompt: "Look through src/auth and summarize OAuth providers"
)
```

The subagent runs in-memory under the parent pi process. Live progress is
streamed back to the caller via the standard `AgentDetails` payload plus the
`entries[]` timeline field. The subagent never appears as a separate session.

## Wire-protocol contract

This section locks the producer-side contract consumed by the dashboard inspector.

### Emission channels

Every run emits on four `pi.events.emit(channel, data)` channels. The dashboard
bridge's emit intercept renames them to its protocol event types:

| Producer channel        | Dashboard protocol event | When                                          |
| ----------------------- | ------------------------ | --------------------------------------------- |
| `subagents:created`     | `subagent_created`       | Tool invocation begins (before any session work) |
| `subagents:started`     | `subagent_started`       | Initial "running" emission, AND all progress ticks (re-uses channel; dashboard reducer merges) |
| `subagents:completed`   | `subagent_completed`     | `await session.prompt(...)` resolves successfully |
| `subagents:failed`      | `subagent_failed`        | Any throw, abort, or session error path       |

Progress emissions are throttled to **≤4 per second per subagent** (`PROGRESS_THROTTLE_MS = 250`). The final progress snapshot is always flushed before `completed`/`failed`.

Emissions are no-ops when `pi.events` is undefined — the run continues; the parent just doesn't get the rich UI.

### Payload shape

All four channels send `{ id: string, ..., details: AgentDetails }`. The `id` equals `details.agentId`.

Per-channel extras:

```ts
subagents:created   → { id, type, description, details }
subagents:started   → { id, type?, description?, details }    // type/description on first emission only
subagents:completed → { id, result, durationMs, tokens, toolUses, details }
subagents:failed    → { id, error, durationMs, toolUses?, details }
```

### `AgentDetails` field reference

The `details` payload (defined in `extensions/events.ts`) carries everything the inspector renders.

| Field          | Type                            | Purpose                                                                  |
| -------------- | ------------------------------- | ------------------------------------------------------------------------ |
| `agentId`      | `string`                        | Stable id; drives the popout URL `/session/<sid>/subagent/<agentId>`     |
| `displayName`  | `string`                        | Human-readable name (defaults to `subagent_type`)                        |
| `description`  | `string`                        | The 5–10-word task description passed in by the LLM                      |
| `subagentType` | `string`                        | The `.md` agent type identifier (e.g. `"Explore"`)                       |
| `status`       | `AgentStatus`                   | One of `queued \| running \| completed \| aborted \| stopped \| error`     |
| `activity?`    | `string`                        | Live current-activity line ("running bash", "thinking", …)               |
| `entries?`     | `SubagentTimelineEntry[]`       | Full timeline (cumulative; dashboard REPLACES on each emission)          |
| `toolUses`    | `number`                        | Cumulative count of completed tool calls                                 |
| `tokens`       | `string`                        | Display-formatted total (`"12.3k"`)                                      |
| `tokensUsage?` | `{ input, output, total }`      | Raw integer counts (populated on `completed`/`failed`)                    |
| `turnCount?`   | `number`                        | Assistant turns so far                                                   |
| `maxTurns?`    | `number`                        | Reserved — not enforced in v0.1.x                                        |
| `durationMs`   | `number`                        | Elapsed milliseconds since `subagents:created`                            |
| `modelName?`   | `string`                        | Resolved model id (e.g. `"claude-sonnet-4-6"`)                          |
| `tags?`        | `string[]`                      | Notable config flags (e.g. `["thinking: high"]`)                         |
| `agentMdPath?` | `string`                        | Absolute path to the `.md` definition (project preferred over global)     |
| `error?`       | `string`                        | Set on `failed` emissions                                                |

### `SubagentTimelineEntry` kinds

```ts
| { kind: "tool";     toolName, input, output?, isError?, ts }
| { kind: "text";     text, ts }              // assistant text (text_end)
| { kind: "thinking"; text, ts }              // assistant thinking (thinking_end)
| { kind: "error";    text, ts }              // assistant error
```

Only `_end`-flavored session events become entries — each entry is final / idempotent. Live activity is conveyed via `details.activity` instead.

### Persistence model

- **Subagent's conversation** — in-memory only, dies with the parent turn (uses `SessionManager.inMemory(cwd)`).
- **Subagent's final result + timeline** — embedded in the `AgentToolResult<AgentDetails>` returned to the parent. Pi persists it inside the parent's `ToolResultMessage.details` in the parent session's JSONL. Survives `/resume`.
- **Live progress** — streamed only; not buffered server-side. A dashboard refresh while a subagent is still running loses the live card until the parent's tool result lands in JSONL (then state-replay re-hydrates from `details`). See the dashboard's `add-subagent-inspector` change for the consumer-side replay seam.

## License

MIT
