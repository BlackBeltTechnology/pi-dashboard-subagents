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

## Agent `.md` files

v0.2.0 added YAML frontmatter parsing for agent `.md` definition files plus a
3-tier resolver and a bundled default Explore agent.

### Frontmatter schema

Every field is optional. Missing fields fall through to current pre-frontmatter
behaviour, so an `.md` with no frontmatter still works.

```yaml
---
description: Fast read-only codebase & docs exploration
model: anthropic/claude-haiku-4-5      # OR "@role" — see below
thinking: high                          # (alt: "model: id:high" suffix)
tools: [read, grep, find, ls, bash]    # allowlist (built-in + extension tools)
inherit_context: false                  # per-agent override of the global setting
prompt: |                              # OPTIONAL — body fallback below
  You are an Explore subagent. Be fast and read-only.
---

The markdown body becomes the agent prompt when no `prompt:` field is set.
This matches the convention used by Claude Code and pi-coding-agent's own
prompt-template / skill files.
```

| Field             | Effect                                                                                              |
| ----------------- | --------------------------------------------------------------------------------------------------- |
| `description`     | Overrides `displayName` on the dashboard card.                                                      |
| `model`           | Literal `"provider/id"`, `"provider/id:thinking-level"`, or `"@role"` (see Role aliasing).            |
| `tools`           | Allowlist intersected with the parent's active tool set (minus `Agent`). Unknown names dropped silently. |
| `inherit_context` | `true` → inherit parent context. `false` → isolated. Per-agent; overrides the global `inheritContext`.|
| `prompt`          | Prepended as `<agent-prompt>...</agent-prompt>` before the task. Body of the `.md` is used if the field is absent. |

All fields are read once at spawn time. Editing the `.md` while a subagent is
running has no effect on that subagent; the next spawn picks up changes.

### Three-tier resolution

When the LLM calls `Agent({ subagent_type: "Explore", ... })`, the extension
looks up `Explore.md` in three tiers, most-specific first:

```
1. <cwd>/.pi/agents/Explore.md          → source: "project"   (per-project override)
2. ~/.pi/agent/agents/Explore.md        → source: "user"      (per-user override)
3. <EXTENSION_ROOT>/agents/Explore.md   → source: "bundled"   (ships with this package)
```

The first match wins. The tier is surfaced as `AgentDetails.agentMdSource` so
the dashboard card can render "Explore (bundled)" / "Explore (user)" badges.

### Bundled `Explore` agent

The package ships `agents/Explore.md` — a fast, read-only codebase / docs
explorer informed by Claude Code's Explore agent and the production guidance
in Ranjan Kumar's *Subagents: How to Run Parallelism Inside a Single Agent
Session* (April 2026):

- **Model**: `anthropic/claude-haiku-4-5` (literal; works standalone).
- **Tools**: `[read, grep, find, ls, bash]` — no write/edit/Agent.
- **Inherit context**: `false` — fresh window, parent's context not imported.
- **Output contract**: structured `## Answer / ## Evidence / ## Notes` with
  hard limits (≤2000 tokens, no raw file dumps).

To customise:

```bash
mkdir -p ~/.pi/agent/agents
cp "$(node -e 'console.log(require.resolve("pi-dashboard-subagents/agents/Explore.md"))')" \
   ~/.pi/agent/agents/Explore.md
# Edit ~/.pi/agent/agents/Explore.md — e.g. change `model:` to `"@fast"`
```

The user-global override automatically wins over the bundled file (tier 2 > 3).

### Role aliasing (`@role`)

The `model:` field accepts `@role` syntax (e.g. `model: @fast`). The extension
resolves the alias by emitting on `pi.events`:

```ts
const probe = { ref: "@fast" };
pi.events.emit("role:resolve-model", probe);
// probe.resolved === "opencode-go/deepseek-v4-flash"  (when a handler is registered)
```

The handler is supplied by the **`@blackbelt-technology/pi-dashboard-roles-plugin`**
bridge (a separate dashboard plugin that reads `~/.pi/agent/providers.json`).
When the handler is NOT registered (e.g. no dashboard, or the roles plugin is
disabled), `@role` references HARD-FAIL the tool call with an error message
identifying:

- the unresolved role name,
- the agent `.md` path that specified it,
- whether the handler was absent vs the role was unknown,
- suggested fixes (install/enable roles plugin, or use a literal id).

**Any pi extension** can use this convention — not just `pi-dashboard-subagents`.
The contract:

```ts
interface Probe {
  ref: string;                                 // input: "@fast"
  resolved?: string;                           // output: "provider/model-id"
  available?: Record<string, string>;          // output: { fast: "...", coding: "..." }
}
```

The `available` field is best-effort — handlers SHOULD populate it on failure
so callers can list the configured roles in their error messages.

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
| `agentMdPath?` | `string`                        | Absolute path to the `.md` definition (project > user > bundled)         |
| `agentMdSource?` | `"project" \| "user" \| "bundled"` | Tier that supplied `agentMdPath`. v0.2.0+. Undefined when path is undefined or producer is older. |
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
