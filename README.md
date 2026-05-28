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
npm install -g @blackbelt-technology/pi-dashboard-subagents
```

Then add to `~/.pi/agent/settings.json`:

```json
{
  "packages": [
    "npm:@blackbelt-technology/pi-dashboard-subagents"
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
| `model`           | `"@role"`, `"provider/model-id"`, `"provider/model-id:thinking"`, or bare `"model-id"`. See [Model resolution](#model-resolution-model). |
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

- **Model**: `"@fast"` — role alias resolved at spawn time by the dashboard's
  roles plugin. Operators pick the underlying model behind `@fast` via
  Settings → Roles. This makes model choice operator-controlled at runtime
  rather than baked into the shipped file.
- **Tools**: `[read, grep, find, ls, bash]` — no write/edit/Agent.
- **Inherit context**: `false` — fresh window, parent's context not imported.
- **Output contract**: structured `## Answer / ## Evidence / ## Notes` with
  hard limits (≤2000 tokens, no raw file dumps).

The bundled Explore **requires** a `model:resolve` handler to be loaded (so
`@fast` can be looked up in `~/.pi/agent/providers.json`). The handler ships
with **pi-agent-dashboard** and (optionally) **pi-flows**. Without one of
them, `@role` references HARD-FAIL the spawn; literal model ids still resolve
via the in-process registry fallback. See [Model resolution](#model-resolution-model)
below.

To customise (e.g. to run without the dashboard, or to pin a specific model):

```bash
mkdir -p ~/.pi/agent/agents
cp "$(node -e 'console.log(require.resolve("@blackbelt-technology/pi-dashboard-subagents/agents/Explore.md"))')" \
   ~/.pi/agent/agents/Explore.md
# Edit ~/.pi/agent/agents/Explore.md — e.g. change `model:` to a literal
# "provider/model-id" so it works without the roles-plugin bridge.
```

The user-global override automatically wins over the bundled file (tier 2 > 3).

### Model resolution (`model:`)

The `model:` field accepts four input forms, in priority order:

| Form                              | Example                            | How it resolves                                                    |
| --------------------------------- | ---------------------------------- | ------------------------------------------------------------------ |
| `@role` (role alias)              | `@fast`                            | Handler reads `~/.pi/agent/providers.json#roles` — needs handler.   |
| `provider/model-id`               | `anthropic/claude-opus-4`          | `pi.modelRegistry.find(provider, id)`.                              |
| `provider/model-id:thinking`      | `anthropic/claude-haiku-4-5:high`  | Same as above; `:thinking` parsed off and surfaced separately.      |
| Bare `model-id` ("like" query)    | `claude-haiku-4-5`                 | `pi.modelRegistry.getAll().find(m => m.id === ref)` — first wins.   |

The extension resolves the field in two phases:

**1. Primary — `model:resolve` event.** The extension emits a probe on
`pi.events`:

```ts
const probe = { ref: "@fast" };       // or "anthropic/opus", or "opus-4-5"
pi.events.emit("model:resolve", probe);
if (probe.model)   { /* success */ }
if (probe.error)   { /* handler reported a miss */ }
// else: silent emit (no handler) — fall through to the fallback below
```

A handler is provided by **pi-agent-dashboard** (always) and (optionally)
**pi-flows**. The handler is responsible for all four input forms above.

**2. Fallback — in-process registry.** When the emit returns with both
`probe.model` and `probe.error` unset (no handler reacted), the extension
resolves literal forms locally via `pi.modelRegistry`:

- `provider/model-id[:thinking]` → `registry.find(provider, id)`
- Bare `model-id[:thinking]` → `registry.getAll().find(m => m.id === ref)`
- `@role` → **NOT** supported by the fallback (no `providers.json` access);
  fails with a clear "install pi-agent-dashboard or pi-flows" message.

This means: **subagents using literal or bare-id models always work**, with
or without the dashboard. Only `@role` requires a handler.

#### Failure surface

When resolution fails (handler error, fallback miss, no handler for `@role`),
the tool call returns `isError: true` with a structured message that:

- names the unresolved ref,
- includes the agent `.md` path that specified it,
- distinguishes "role unknown" vs "model unknown" vs "no resolver available",
- suggests the right fix (install plugin, use literal form, add to
  `providers.json`, etc.),
- on bare-id misses includes a hint of registered model ids (capped at 20).

#### Implementing a `model:resolve` handler

Any pi extension can register a handler. Use the cooperative early-return
idiom so multiple handlers (e.g. pi-flows + pi-agent-dashboard) coexist
without fighting:

```ts
pi.events.on("model:resolve", (probe) => {
  if (probe.model) return;                  // someone else already handled it

  // 1. @role indirection (if you own roles)
  // 2. provider/model split + registry.find()
  // 3. bare-id “like” query against registry.getAll()

  if (resolvedSuccessfully) {
    probe.resolved      = "provider/id";    // canonical literal
    probe.model         = m;                // Model object
    probe.thinkingLevel = thk;              // parsed from ":high" suffix, optional
    probe.auth          = a;                // optional, registry-defined shape
  } else {
    probe.error    ??= reason;              // first error sticks
    probe.available ??= { roles, models };  // optional diagnostics
  }
});
```

Probe shape (TypeScript):

```ts
interface ModelResolveProbe {
  ref: string;                                          // input
  resolved?: string;                                    // "provider/model-id"
  model?: Model<any>;
  thinkingLevel?: "minimal" | "low" | "medium" | "high" | "xhigh" | "off";
  auth?: { ok?: boolean; error?: string; [k: string]: unknown };
  error?: string;
  available?: {
    roles?: Record<string, string>;
    models?: string[];
  };
}
```

#### Standalone behaviour matrix

|                                 | `@role`      | `provider/id` | bare `id`  |
| ------------------------------- | ------------ | ------------- | ---------- |
| With pi-agent-dashboard         | event ✅      | event ✅       | event ✅    |
| With pi-flows (optional handler)| event ✅      | event ✅       | event ✅    |
| Neither — standalone pi         | ❌ (install)  | fallback ✅    | fallback ✅ |

When neither handler is loaded, only `@role` fails. Literal `provider/model`
and bare `model-id` continue to work via the in-process registry fallback.

#### Per-call model override (`model` tool-call param)

The `Agent` tool's parameter schema accepts an optional `model` field that
short-circuits any frontmatter `model:` value:

```js
Agent({
  subagent_type: "research-spike",   // any label — no `.md` required
  description:   "audit auth flow",
  prompt:        "Review extensions/agent.ts for auth issues.",
  model:         "@fast",            // OR "anthropic/claude-haiku-4-5"
                                     // OR bare "claude-haiku-4-5"
})
```

The `model` arg accepts the **same three forms** as the frontmatter field
(`@role`, `provider/model[:thinking]`, bare `model-id`) and resolves via the
**same `model:resolve` event-bus + in-process fallback** pipeline. No
duplication, no second resolver — it's the identical machinery.

**Precedence (highest wins):**

```
  args.model      (tool-call argument)
   > agentConfig.model    (`.md` frontmatter)
    > pi default (settings.json)
```

When `args.model` is non-empty it WINS and the `.md`'s `model:` is ignored.
When `args.model` is omitted (or empty/whitespace) the `.md` value applies.
When both are absent, the parent's default model is inherited.

Failure modes are identical to the frontmatter path. Error messages cite
the source of the unresolvable ref — either the `.md` file path or the
literal label `(tool-call argument)` — so operators can trace bad refs.

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
