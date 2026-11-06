# pi-dashboard-subagents

A lightweight subagent extension for [pi](https://github.com/mariozechner/pi):
foreground by default, with optional [background subagents](#background-subagents).

Spawns subagents **in-memory** (no new sessions appear in `~/.pi/agent/sessions/`, no
clutter in the dashboard's session list) and emits **every event, tool call, and
reasoning step** as a structured timeline the pi-agent-dashboard can render in its
subagent inspector and pop out into a new tab.

## Scope

- **Foreground by default.** An `Agent` call blocks the caller until completion.
- **Optional background spawning.** `Agent({ run_in_background: true })` returns
  a `bg-` id at once; `AgentStatus`, `AgentMessages`, `AgentList` and
  `AgentCancel` check, read, list and stop it. Results are read on request and
  never pushed into the parent. No steering of a running subagent. Turn the
  whole feature off with `"allowBackground": false`.
- **No new sessions on disk.** Sessions live entirely in memory.
- **Full observability.** Every `tool_execution_end`, `text_end`, `thinking_end`,
  and error from the subagent's session is mirrored to the dashboard as a
  `SubagentTimelineEntry`.
- **Inherits parent context by default.** Opt-out with `isolated: true`.

## Context inheritance

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
  "maxConcurrent": 4,
  "resultMaxChars": 16000,
  "detailsMaxChars": 20000,
  "entryFieldMaxChars": 2000,
  "allowBackground": true,
  "maxBackgroundPending": 8,
  "backgroundTimeoutSec": 0,
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
| `maxConcurrent`            | Maximum subagents running at once in this process (default 4, clamped to 0–64). Extra spawns wait FIFO and their dashboard card shows `queued` (with `queuePosition`) until a slot frees. `0` = unlimited (the pre-0.2.5 behaviour). Re-read from disk per spawn, and every ~1 s while calls wait, so raising it starts waiting calls live; lowering it never stops running ones. |
| `resultMaxChars`           | Cap on the result text in the tool result pi saves to the parent session (default 16000). Head and tail are kept around a `[… N chars truncated …]` marker. `0` = unlimited. Re-read per spawn. |
| `detailsMaxChars`          | Cap on the serialized `details.entries` in that saved tool result (default 20000). Head and tail entries are kept around one `[N timeline entries omitted]` entry; `details.entriesOmitted` = N. `0` = unlimited. |
| `entryFieldMaxChars`       | Cap on each timeline entry's text / tool input / tool output in that saved tool result (default 2000). `0` = unlimited. |
| `allowBackground`          | When `true` (default), `Agent` gains `run_in_background` and `timeout_s`, and the `AgentStatus` / `AgentMessages` / `AgentList` / `AgentCancel` tools are registered. When `false`, the tool surface is exactly the foreground-only one. Read once at activation: changes need `/reload`. |
| `maxBackgroundPending`     | Cap on background subagents that are queued or running (default 8). A background spawn at the cap is rejected with the outstanding ids. Foreground calls never count. `0` = unlimited. Re-read per call. |
| `backgroundTimeoutSec`     | Default run-time limit for background subagents, in seconds, counted from when they start running (queue time is free). On expiry the subagent is stopped (`stoppedBy: "timeout"`). `timeout_s` overrides it per call. `0` (default) = no limit. Re-read per call. |

#### Why a concurrency cap

Subagents run **in the parent process** (one V8 heap, one event loop). An
unbounded fan-out of parallel `Agent` calls stacks every child's per-turn
extension work onto the parent's loop, which can stall the parent long enough
for the dashboard bridge watchdog to force-close the session. The cap bounds
that worst case; set `maxConcurrent: 0` to opt out.

#### Child resource loading

Each child session gets its **own** lean resource loader: extensions are loaded
(so the child keeps the full tool surface, minus `Agent`), but **skills, prompt
templates and themes are not** — a headless child never reads them, and
skipping them cuts memory noticeably on wide fan-outs. Skills remain reachable
by path if the parent passes them in the prompt.

Extension handlers for the **settlement events** `turn_end`, `agent_end`,
`agent_before_settle` and `agent_settled` are removed from the child (via pi's
`extensionsOverride`). pi awaits those hooks inside every run, so a
parent-scoped hook (a memory summary, a telemetry flush) would otherwise delay
or extend each subagent. Tool, provider and `message_end` hooks still run.

#### Outcome and Stop

- The **final assistant message** decides the outcome. If it errored
  (`stopReason: "error"` after pi's own retries) or was aborted, or it has no
  text, the call fails (`subagents:failed`, `isError: true`). Text from an
  earlier turn is never returned as the result.
- **Provider retries are pi's.** Each subagent session reads pi's own
  `settings.retry` (`~/.pi/agent/settings.json`) and pi retries transient
  provider errors (overload, 429, 5xx, dropped connections) inside the run,
  with exponential backoff. This package adds no retry policy; it makes the
  retries visible. Each scheduled retry adds a `retry` timeline entry, the
  activity line reads `retrying (attempt N/M) in 4s…` during the backoff, and
  `details.retries` counts the attempts, and each retry is published on
  [`subagents:retry`](#subagentsretry). When a run fails after its last retry
  sequence also failed, the error says so, e.g.
  `429 rate_limit_error (after 2 retries)`. Errors pi classifies as permanent
  (quota exhausted, 400, 404) fail at once without a `retry` entry. A stop
  during a backoff cancels it immediately.
- **Stop** is honored at every stage: while queued, while the child loader is
  built, and while the session is created. An early Stop sends no model request.
- **Per-subagent stop.** `pi.events.emit("subagents:stop", { agentId })` stops
  ONE subagent of the session whose bus received it, without touching the
  parent turn or its siblings. A queued one leaves the queue without using a
  slot; a running one has only its child aborted and frees its slot for the
  next waiter. It ends `status: "stopped"` (`stopReason: "queued" | "running"`)
  on `subagents:completed` with a **non-error** tool result
  (`Subagent removed from queue before starting.` / `Subagent stopped by user.`
  plus any partial output), so the parent continues. Whichever comes first,
  stop or parent abort, decides the outcome. Unknown or finished ids are
  ignored; every request is logged. Snapshots carry `stoppable: true`.

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

Missing file or fields fall back to baked-in defaults. Settings are cached,
and every spawn re-checks the file's mtime, so edits apply on the **next
spawn** without a restart. The exceptions are `exposeInheritanceInTool` and
`allowBackground`: they shape the tool surface, which is fixed at activation,
so they need `/reload`.
Waiting calls also re-read `maxConcurrent` about every second.
`invalidateSettingsCache()` forces a re-read programmatically.

### Compression is operator-controlled only

`recentTurns`, `toolOutputWindow`, and `maxChars` are never exposed to the
LLM under any setting. They're operator concerns — fine-tune them globally
by editing the config file; the next spawn uses the new values.

## Background subagents

With `allowBackground` on (the default), the parent can start subagents that
run while it keeps working, then check on them later.

```
Agent({ subagent_type, description, prompt, run_in_background: true, timeout_s? })
  → "Started background subagent bg-3fa91c (running). Background: 1 running, 0 queued, 0 finished-unread. …"

AgentStatus({ ids: ["bg-3fa91c"], wait?: "none" | "any" | "all", timeout_s? })
AgentMessages({ id: "bg-3fa91c", from?, limit?, kinds? })
AgentList()
AgentCancel({ ids: ["bg-3fa91c"] | "all", status?: "queued" | "running" })
```

- **Same run, not awaited.** A background subagent runs exactly like a
  foreground one: same `subagents:*` events (with `details.background: true`),
  same `maxConcurrent` slots, same queue info, same `subagents:stop`. The
  `Agent` call returns at once with a short `bg-` id, its queue position and
  the running / queued / finished-unread counts. Its result `details` carry
  `{ background: true, id, status }` and **no `agentId`**, so the dashboard
  does not mark the card finished early.
- **Not tied to the parent turn.** Interrupting the parent turn does not stop
  background work. `AgentCancel`, `subagents:stop`, the run-time limit and
  session shutdown do.
- **Ids.** Every tool accepts the short `bg-` id, the full `agentId`, or a
  unique prefix of either.
- **Nothing is delivered.** A finished result is stored in memory and read on
  request (`AgentStatus`). No message, follow-up or steer is sent into the
  parent. Results last for the rest of the session and do **not** survive
  `/reload`, `/resume` or a restart.
- **`AgentStatus`** returns current state, or waits for `"any"` / `"all"` ids
  to finish. `timeout_s` caps the wait and never cancels anything; aborting
  the call ends only the wait. Unknown ids report `not_found`.
- **`AgentMessages`** pages a subagent's timeline, live or finished: the last
  20 entries by default, or from `from` onward (pass the returned `next_from`
  to read only new entries). `kinds` filters before paging.
- **`AgentList`** lists every background subagent of the session with status,
  age, tokens and whether its finished result is still unread.
- **`AgentCancel`** stops through the same path as `subagents:stop`: a queued
  subagent leaves the queue without using a slot, a running one is aborted.
  They end `stopped` (not an error), with `stoppedBy: "tool"`, and their
  partial timeline stays readable. `ids: "all", status: "queued"` clears a
  forgotten queue. It does not wait for the stop to finish.
- **Safeguards.** `maxBackgroundPending` caps outstanding background work.
  Foreground calls always take the next free slot before any queued
  background call (FIFO within each). `backgroundTimeoutSec` / `timeout_s`
  bound run time. On `session_shutdown` every queued or running background
  subagent is stopped (`stoppedBy: "shutdown"`).
- **Children never manage subagents.** `Agent` and all four background tools
  are removed from every child session.

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
| **`pi-dashboard-subagents` (this)**| **In-memory ✓**    | **Clean ✓**   | **Full ✓**    | Optional, pull-only |

This extension focuses on first-class observability for the pi-agent-dashboard
inspector. Background runs are the same in-memory runs with the same timeline;
results are pulled on request, never pushed into the parent.

## Install

Requires pi **>=0.80.8 <2** (`@earendil-works/pi-coding-agent`, `pi-ai`,
`pi-tui`); developed and tested on pi 1.x. On pi <0.80.8 stay on 0.2.5.

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

`subagent_type` can be any label. When it matches an agent `.md` (see
[Agent `.md` files](#agent-md-files)) that file supplies the model, tools and
prompt; otherwise the subagent runs with the parent's defaults. This package
ships no agents itself; `Explore` above resolves only when some tier provides
an `Explore.md` (pi-agent-dashboard ships one as a project-level agent).

The subagent runs in-memory under the parent pi process. Live progress is
streamed back to the caller via the standard `AgentDetails` payload plus the
`entries[]` timeline field. The subagent never appears as a separate session.

## Agent `.md` files

Agent `.md` files define reusable subagent types: YAML frontmatter for
model, tools and inheritance, plus a prompt. They are found by a four-tier
resolver (project, user, bundled, package).

### Frontmatter schema

Every field is optional. Missing fields fall through to current pre-frontmatter
behaviour, so an `.md` with no frontmatter still works.

```yaml
---
description: Fast read-only codebase & docs exploration
model: anthropic/claude-haiku-4-5      # OR "@role" — see below
                                        # thinking level: use a ":high" suffix on model
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
| `model`           | `"@role"`, `"provider/model-id"`, `"provider/model-id:thinking"`, or bare `"model-id"`. See [Model resolution](#model-resolution-model) and [Thinking level](#thinking-level). |
| `tools`           | Allowlist intersected with the parent's active tool set (minus `Agent`). Unknown names dropped silently. |
| `inherit_context` | `true` → inherit parent context. `false` → isolated. Per-agent; overrides the global `inheritContext`.|
| `prompt`          | Prepended as `<agent-prompt>...</agent-prompt>` before the task. Body of the `.md` is used if the field is absent. |

All fields are read once at spawn time. Editing the `.md` while a subagent is
running has no effect on that subagent; the next spawn picks up changes.

### Four-tier resolution

When the LLM calls `Agent({ subagent_type: "Explore", ... })`, the extension
looks up `Explore.md` in four tiers, most-specific first:

```
1. <cwd>/.pi/agents/Explore.md          → source: "project"   (per-project override)
2. ~/.pi/agent/agents/Explore.md        → source: "user"      (per-user override)
3. <EXTENSION_ROOT>/agents/Explore.md   → source: "bundled"   (this package's own agents/; none shipped today)
4. <installedPath>/agents/Explore.md    → source: "package"   (any other installed pi package)
```

The first match wins. The tier is surfaced as `AgentDetails.agentMdSource` so
the dashboard card can render "Explore (bundled)" / "Explore (user)" badges;
for tier 4 the originating package is also carried in `AgentDetails.agentMdPkg`
("reviewer (package: @acme/pi-reviewers)").

### Shipping agents from a package

Any installed pi package can ship spawnable agents — no manual copying into
`.pi/agents/` required. Drop `agents/<name>.md` into the package, make sure
`agents/` is included in the package's `files[]` (so it ends up in the
published tarball), install the package, and `Agent({ subagent_type: "<name>" })`
can spawn it. The `.md` uses the exact same [frontmatter schema](#frontmatter-schema)
as project/user/bundled agents.

```jsonc
// the providing package's package.json
{
  "files": ["agents/", "..."]
}
```

Resolution rules for the package tier:

- **Ranks last (tier 4).** Package agents fill a name only when the project,
  user, and bundled tiers all miss — no name that resolves today can be
  shadowed by a newly installed package. Place a `.pi/agents/<name>.md` in your
  project (or `~/.pi/agent/agents/<name>.md`) to override a package agent.
- **User-scope only.** Only packages installed into `~/.pi/agent` (user scope)
  are scanned. Project-scoped packages (declared in a repo's `.pi/settings.json`)
  are **never** indexed for agents — an untrusted checkout cannot register
  spawnable agents. This is a deliberate conservative default, not an SDK
  limitation: skipping project scope closes the untrusted-checkout injection
  surface without having to reason about trust. (The SDK *does* expose a
  project-trust signal — `ExtensionContext.isProjectTrusted()` /
  `SettingsManagerCreateOptions.projectTrusted` — so a future opt-in could gate
  project scope on trust; deferred by choice.)
- **Deterministic collisions.** If two packages ship the same basename, the
  package whose `source` string sorts first wins; the loser is dropped and a
  warning naming both is written to stderr.
- **`filtered` packages skipped.** A package configured with a resource
  allowlist (`{ source, skills: [...] }` form) contributes no agents — there is
  no `agents` filter key, so it is treated as not opted in.
- **Discovery is lazy + cached.** The index is built on `resources_discover`
  (startup / `/reload`) and, as a fallback, on the first spawn; it rebuilds on
  `/reload` or a working-directory change. A newly installed package becomes
  spawnable after `/reload` (no full restart needed).

### Bundled agents

The bundled tier (3) is kept so this package *can* ship agents, but **none are
shipped**. The `Explore` agent that 0.2.0 bundled moved out in 0.2.1: the
dashboard now ships it as a project-level agent. To get one without the
dashboard, write your own, e.g. `~/.pi/agent/agents/Explore.md`:

```markdown
---
description: Fast read-only codebase & docs exploration
model: anthropic/claude-haiku-4-5   # or "@fast" when a model:resolve handler is loaded
tools: [read, grep, find, ls, bash]
inherit_context: false
---
You are an Explore subagent. Be fast and read-only. Answer with
## Answer / ## Evidence / ## Notes, no raw file dumps.
```

`@role` refs such as `@fast` need a `model:resolve` handler (pi-agent-dashboard
or pi-flows); literal ids work without one. See
[Model resolution](#model-resolution-model).

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

#### Thinking level

A subagent's thinking level is chosen in this order, first match wins:

1. **Explicit suffix** on the effective model ref (tool-call `model`,
   frontmatter `model:`, or the ref an `@role` resolves to), e.g.
   `anthropic/claude-haiku-4-5:off`. `:off` is honored, not dropped.
2. **Parent's live level**: the parent session's current `/thinking`
   value, even when it was not saved to settings.
3. **pi defaults**: per-model thinking setting, then
   `defaultThinkingLevel`, then `medium`.

pi clamps the result to what the child's model supports. Note that the
parent's level outranks a per-model thinking setting; use a suffix to pin a
subagent's level regardless of the parent.

#### Custom providers

Subagents inherit the parent session's live model runtime, so providers
registered at runtime (e.g. custom providers from `providers.json`, with
their auth) resolve in children exactly as in the parent. pi exposes no
public accessor for this runtime; if a future pi renames the internal
field, the extension logs one warning and children fall back to a
disk-only runtime (custom providers may then fail with "No API key found").

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
  thinkingLevel?: "minimal" | "low" | "medium" | "high" | "xhigh" | "max" | "off";
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
    > parent's live model (ctx.model — what the parent runs right now)
     > SDK default (settings `defaultModel`)
```

When `args.model` is non-empty it WINS and the `.md`'s `model:` is ignored.
When `args.model` is omitted (or empty/whitespace) the `.md` value applies.
When both are absent, the subagent runs on the **parent's current model**
(including a model switched mid-session), not the settings default; the SDK
default applies only when the parent has no live model.

Failure modes are identical to the frontmatter path. Error messages cite
the source of the unresolvable ref — either the `.md` file path or the
literal label `(tool-call argument)` — so operators can trace bad refs.

## Wire-protocol contract

This section locks the producer-side contract consumed by the dashboard inspector.

### Emission channels

Every run emits on six `pi.events.emit(channel, data)` channels. The dashboard
bridge's emit intercept renames the four lifecycle channels to its protocol
event types; any listener on `pi.events` (a TUI widget, a logger, the
dashboard) can consume all six:

| Producer channel        | Dashboard protocol event | When                                          |
| ----------------------- | ------------------------ | --------------------------------------------- |
| `subagents:created`     | `subagent_created`       | Tool invocation begins (before any session work) |
| `subagents:started`     | `subagent_started`       | Initial "running" emission, AND all progress ticks (re-uses channel; progress ticks omit `entries`, carry `entryCount`) |
| `subagents:entry`       | — (not forwarded by core) | Once per timeline step, the moment it is appended (never throttled). Steps finishing a streamed text/thinking block carry `blockId` |
| `subagents:delta`       | —                        | Append-only pieces of the streaming text/thinking block (see below) |
| `subagents:retry`       | —                        | pi scheduled an auto-retry (`phase: "scheduled"`) or finished a retry sequence (`phase: "ended"`); see [`subagents:retry`](#subagentsretry) |
| `subagents:completed`   | `subagent_completed`     | `await session.prompt(...)` resolves and the final assistant reply succeeded with text |
| `subagents:failed`      | `subagent_failed`        | Any throw, abort, errored/empty final reply, or session error path |

Inbound control channel (listened to, never emitted):

| Channel           | Payload       | Effect |
| ----------------- | ------------- | ------ |
| `subagents:stop`  | `{ agentId }` | Stops that queued or running subagent of this session → `subagents:completed` with `details.status: "stopped"`, `stoppedBy: "event"` |

### Plugin hooks

Other packages can observe, intercept and query subagents on `pi.events`.
Intercept and query channels pass a **mutable payload that handlers fill
synchronously** during `emit`; values set after `emit` returns are ignored,
and a throwing handler is ignored as if absent.

| Kind      | Channel                   | Payload                                                     | Contract |
| --------- | ------------------------- | ----------------------------------------------------------- | -------- |
| observe   | `subagents:*` lifecycle   | `details.background`, `details.stoppedBy`                   | Every lifecycle event says whether the run is background; stopped runs say who stopped them (`tool` / `event` / `timeout` / `shutdown`). |
| observe   | `subagents:result_read`   | `{ id, agentId, via: "status" \| "messages" }`              | A stored background result (`AgentStatus`) or timeline page (`AgentMessages`) was returned. |
| intercept | `subagents:before_spawn`  | `{ args, background, veto?, reason?, patch? }`              | Runs before anything is created, for foreground and background spawns. `veto: true` → the call returns an error containing `reason`. `patch` may override `prompt`, `model`, `description`. |
| intercept | `subagents:before_store`  | `{ id?, agentId, background, status, result, patch? }`      | Runs on every terminal state before the result is emitted, bounded, stored or returned. A string `patch.result` replaces the result text (e.g. redaction). |
| query     | `subagents:list`          | `{ filter?: { status? }, out? }`                            | The owning session fills `out` with the same rows as `AgentList`. |
| query     | `subagents:get`           | `{ id, from?, limit?, kinds?, out? }`                       | The owning session fills `out` with `{ status, messages }` (as `AgentStatus` / `AgentMessages`). Unknown ids leave `out` unset. Never marks a result read. |
| control   | `subagents:stop`          | `{ agentId }`                                               | See above. There is no separate cancel channel. |

A query handler answers only when `out` is still unset, and only from its own
session, so several sessions on one bus never overwrite each other. Typed
helpers are exported so plugins need not hand-write channel names:

```ts
import {
  onSubagentEvent, listBackgroundAgents, getBackgroundAgent, stopSubagent, SUBAGENT_CHANNELS,
  type BeforeSpawnPayload,
} from "@blackbelt-technology/pi-dashboard-subagents";

pi.events.on(SUBAGENT_CHANNELS.beforeSpawn, (p) => {
  const payload = p as BeforeSpawnPayload;
  if (overBudget()) { payload.veto = true; payload.reason = "budget exceeded"; }
});
const off = onSubagentEvent(pi, "subagents:completed", (e) => log(e.id, e.result));
const running = listBackgroundAgents(pi, { status: "running" });
const one = getBackgroundAgent(pi, "bg-3fa91c", { limit: 10 });
stopSubagent(pi, running[0].agentId);
```

While calls wait for a slot, every queue change (slot granted, waiter removed,
limit changed) re-pushes a queued snapshot to each remaining waiter, batched to
one frame per waiter per task, through the tool's `onUpdate`
(`tool_execution_update`) only. The bus gets each call's initial place on
`subagents:created`, so bus volume stays proportional to the number of runs.

Progress emissions are throttled to **≤4 per second per subagent** (`PROGRESS_THROTTLE_MS = 250`). The final progress snapshot is always flushed before `completed`/`failed`.

`subagents:delta` carries the block currently streaming as exact, append-only
pieces: `{ v: 1, agentId, toolCallId, blockId, kind, offset, text, final }`
(`SubagentDeltaEvent`). `blockId` counts blocks per run from 0; `offset` is the
block-relative start of `text` in UTF-16 code units, so a block's pieces are
contiguous and concatenate to exactly what was streamed. Pieces are batched to
**≤4 per second per subagent**, never coalesced away, and flushed synchronously
at block end, next block start, message end and on any terminal path. Every
opened block gets exactly one `final: true` piece, emitted **before** its
`subagents:entry`; that entry carries the same `blockId` and is the source of
truth. Steps backfilled at `message_end` (providers without `_end` events),
tools and errors carry no `blockId`. `details.liveTail` (≤ 280-char preview on
ticks) is unchanged.

Emissions are no-ops when `pi.events` is undefined — the run continues; the parent just doesn't get the rich UI.

### Payload shape

All four channels send `{ id: string, ..., details: AgentDetails }`. The `id` equals `details.agentId`.

Per-channel extras:

```ts
subagents:created   → { id, type, description, details }
subagents:started   → { id, type?, description?, details }    // type/description on first emission only
subagents:completed → { id, result, durationMs, tokens, toolUses, details }
subagents:failed    → { id, error, durationMs, toolUses?, details }
subagents:entry     → { v: 1, agentId, toolCallId, index, entry }  // SubagentEntryEvent
```

**Timeline steps go out once each.** Rebuild a live timeline by appending
`subagents:entry` payloads by `index` (0-based, contiguous, never rewritten;
`toolCallId` is the parent `Agent` tool call id, `""` when unknown). Progress
ticks on `subagents:started` deliberately OMIT the `entries` key and carry
`details.entryCount` instead, so per-tick cost stays constant however long the
run is. `subagents:created`, the initial `subagents:started`,
`subagents:completed` and `subagents:failed` keep the full `details.entries[]`.
The terminal `onUpdate` and the final tool result (what pi saves to the parent
session) carry it **size-bounded** per `resultMaxChars` / `detailsMaxChars` /
`entryFieldMaxChars`; `details.entriesOmitted` says how many steps were dropped.

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
| `entries?`     | `SubagentTimelineEntry[]`       | Full timeline. Absent on progress ticks (use `subagents:entry`)          |
| `entryCount?`  | `number`                        | `entries.length` at snapshot time; on every emission (the original count on a bounded tool result) |
| `entriesOmitted?` | `number`                     | Bounded tool result / terminal `onUpdate` only: steps replaced by the omission marker |
| `toolUses`    | `number`                        | Cumulative count of completed tool calls                                 |
| `tokens`       | `string`                        | Display-formatted total (`"12.3k"`)                                      |
| `tokensUsage?` | `{ input, output, total }`      | Raw integer counts (populated on `completed`/`failed`)                    |
| `turnCount?`   | `number`                        | Assistant turns so far                                                   |
| `maxTurns?`    | `number`                        | Reserved — not enforced in v0.1.x                                        |
| `durationMs`   | `number`                        | Elapsed milliseconds since `subagents:created`                            |
| `modelName?`   | `string`                        | Resolved model id (e.g. `"claude-sonnet-4-6"`)                          |
| `tags?`        | `string[]`                      | Notable config flags (e.g. `["thinking: high"]`)                         |
| `agentMdPath?` | `string`                        | Absolute path to the `.md` definition (project > user > bundled > package) |
| `agentMdSource?` | `"project" \| "user" \| "bundled" \| "package"` | Tier that supplied `agentMdPath`. v0.2.0+ (`"package"` added in the package-discovery tier). Undefined when path is undefined or producer is older. |
| `agentMdPkg?`  | `string`                        | Originating package `source` string when `agentMdSource === "package"` (e.g. `"@acme/pi-reviewers"`); undefined otherwise |
| `error?`       | `string`                        | Set on `failed` emissions                                                |
| `stoppable?`   | `true`                          | Producer honours `subagents:stop`; on every snapshot (0.6.0+)            |
| `stopReason?`  | `"queued" \| "running"`         | Phase the stop landed in; only when `status === "stopped"`               |
| `queuePosition?` | `number`                      | 1-based place in the spawn FIFO, no gaps; only while waiting             |
| `activeSlots?` | `number`                        | Slots in use; only on queued snapshots                                   |
| `maxConcurrent?` | `number`                      | Effective limit (`0` = unlimited); only on queued snapshots              |
| `slotGrantedAt?` | `number`                      | Epoch ms the slot was granted; `durationMs` still counts from creation   |
| `background?`  | `boolean`                       | `true` for a background run, `false` for foreground; set on every snapshot |
| `stoppedBy?`   | `"tool" \| "event" \| "timeout" \| "shutdown"` | Who stopped the run; only when `status === "stopped"` |
| `retries?`     | `number`                        | Auto-retry attempts pi scheduled in this run, summed over all retry sequences; absent until the first |

### `SubagentTimelineEntry` kinds

```ts
| { kind: "tool";     toolName, input, output?, isError?, ts }
| { kind: "text";     text, ts }              // assistant text (text_end)
| { kind: "thinking"; text, ts }              // assistant thinking (thinking_end)
| { kind: "error";    text, ts }              // assistant error
| { kind: "retry";    attempt, maxAttempts, delayMs, text, ts }  // pi scheduled an auto-retry (text = provider error)
```

Only `_end`-flavored session events become entries — each entry is final / idempotent. Live activity is conveyed via `details.activity` instead.

A `retry` entry is appended each time pi schedules an auto-retry of a failed
provider call (`auto_retry_start`): `attempt` is the 1-based retry number,
`maxAttempts` the budget from pi's `settings.retry.maxRetries`, `delayMs` the
scheduled backoff and `text` the provider error. It is the only timeline record
of the failed attempt; a retried attempt gets no `error` entry. Consumers that
switch exhaustively on `kind` must handle it (added in the release after 0.6.0).

### `subagents:retry`

pi's auto-retry inside a subagent is also published on its own channel, so a
listener can follow retries without filtering the timeline. Never throttled.

```ts
// SubagentRetryEvent
{ v: 1, agentId, toolCallId, phase: "scheduled", attempt, maxAttempts, delayMs, error, retries }
{ v: 1, agentId, toolCallId, phase: "ended",     attempt, success, finalError?, retries }
```

`scheduled` fires when a backoff starts; `ended` fires when the retry sequence
finishes (`success: false` with `finalError` when it gave up or the retried
call failed permanently). `retries` is the run's running total, the same
number as `details.retries`. Subscribe with
`onSubagentEvent(pi, "subagents:retry", handler)` or
`pi.events.on(SUBAGENT_CHANNELS.retry, handler)`.

### Persistence model

- **Subagent's conversation** — in-memory only, dies with the parent turn (uses `SessionManager.inMemory(cwd)`).
- **Subagent's final result + timeline** — embedded in the `AgentToolResult<AgentDetails>` returned to the parent, size-bounded (see `resultMaxChars` / `detailsMaxChars`). Pi persists it inside the parent's `ToolResultMessage.details` in the parent session's JSONL. Survives `/resume`; a replayed timeline keeps head and tail steps around an omission marker.
- **Background results** — held in memory by the session that spawned them, for the rest of that session. The background `Agent` call's own tool result holds only the `bg-` id, so a background subagent's result and timeline are **not** in the parent JSONL and do not survive `/reload`, `/resume` or a restart (`AgentStatus` then reports `not_found`).
- **Live progress** — streamed only; not buffered server-side. A dashboard refresh while a subagent is still running loses the live card until the parent's tool result lands in JSONL (then state-replay re-hydrates from `details`). See the dashboard's `add-subagent-inspector` change for the consumer-side replay seam.

## License

MIT
