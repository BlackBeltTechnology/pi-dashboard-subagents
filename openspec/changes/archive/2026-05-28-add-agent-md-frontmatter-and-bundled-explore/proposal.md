## Why

`pi-dashboard-subagents` registers a foreground `Agent` tool that spawns subagents, but the
`.md` agent definition files it resolves are used solely as a file-path reference for the
dashboard card's "View source" link. Frontmatter fields (`model:`, `tools:`, `prompt:`,
`inherit_context:`) are silently ignored — the subagent always inherits the parent's default
model, every parent tool minus `Agent`, pi's default system prompt, and the global
`inheritContext` setting. This means:

- **No per-agent model selection.** The `research.md` that says `model: google/gemini-3.1-pro`
  has no effect — the subagent runs on whatever the parent's `settings.json` default is.
- **No tool allowlisting.** Every subagent gets the parent's full tool set (50+ tools),
  including dangerous ones (`document_parse`, `mcp__pi__browser`). This caused a production
  system crash when an unconstrained research subagent ran `document_parse(screenshotPages="all")`
  on a lecture PDF, producing 25–60 MB of inline base64 images that exhausted system RAM.
- **No subagent system prompt.** The agent personality defined in `.md` `prompt:` blocks is lost.
  Subagents run with pi's default system prompt + skills XML, not the agent-specific instructions.
- **No bundled defaults.** Every user must write their own agent.md from scratch. There's no
  shipped Explore agent that can be used out of the box.

This change adds frontmatter parsing, ships a bundled default `Explore` agent with read-only
tools and a fast-model default, and expands agent resolution to a three-tier system
(project → user-global → bundled). The bundled Explore is informed by established read-only
exploration agent conventions from Claude Code, Aider, and Cline.

### Companion change in pi-agent-dashboard

This change is paired with a companion change in the pi-agent-dashboard repo — the `roles-plugin`
gets a bridge entry that registers a `role:resolve-model` handler on `pi.events`. This bridge
reads `~/.pi/agent/providers.json` directly (zero dependency on pi-flows). Any pi extension can
then resolve `@role` references via a 3-line call:

```ts
const probe = { ref: "@fast" };
pi.events.emit("role:resolve-model", probe);
// probe.resolved === "opencode-go/deepseek-v4-flash"
```

The companion change is small (~25 lines in `packages/roles-plugin/src/bridge/index.ts` + a
`"bridge"` field in the manifest) but it makes `@role` resolution available to EVERY pi
extension — pi-dashboard-subagents, pi-flows, future subagent spawners, anything — through
the shared `pi.events` EventBus. No imports, no npm dependencies, no new packages.

## What Changes

### New capabilities
- **NEW** `extensions/agent.ts` gains `parseAgentMd(path)` — reads the `.md` file at the
  resolved path, parses YAML frontmatter via pi-coding-agent's included `parseFrontmatter`
  utility, and returns a typed `AgentMdConfig` object. Missing or unparseable files return
  `undefined` (no crash; current behavior preserved as fallback).
- **NEW** Frontmatter fields honored:
  - `model` — literal `"provider/model-id"`, `"id:thinking-level"`, or `"@role"` (role alias).
    When present, resolved to a concrete model and passed to `createAgentSession({ model })`.
    When absent, inherits parent default (unchanged).
  - `tools` — string array of tool names. Applied as `session.setActiveToolsByName(tools)`
    after session creation, filtering both built-in AND extension tools. When absent, all
    parent tools minus `Agent` are active (unchanged).
  - `prompt` — prepended to pi's default system prompt as an agent-specific preamble.
    The .md's `prompt:` body is wrapped in `<agent-prompt>` tags followed by pi's standard
    system prompt + skills XML. When absent, pi's default is used (unchanged).
  - `inherit_context` — boolean. Overrides the global `inheritContext` setting for this
    specific agent. When absent, global setting applies (unchanged).
  - `description` — string. Overrides the `displayName` on the dashboard card. Falls back
    to `subagent_type` when absent (unchanged).
- **NEW** `@role` resolution for the `model:` field. When frontmatter contains `model: @role`,
  the extension resolves it via `pi.events.emit("role:resolve-model", probe)`. The handler
  is provided by the roles-plugin bridge (companion change in pi-agent-dashboard) and reads
  `~/.pi/agent/providers.json` directly — no dependency on pi-flows. If the handler is not
  registered (roles-plugin bridge not loaded) and a `@role` is used, the tool call fails with
  a clear error naming the unresolved role and the path to the .md file. Literal model
  references (`provider/id` or `id:thinking-level`) are unaffected and pass through directly.
- **NEW** `agents/Explore.md` shipped in the extension package — a fast, read-only codebase
  exploration agent. Uses a **literal model** (`anthropic/claude-haiku-4-5`) as the bundled
  default so it works out of the box without roles infrastructure. Includes `tools: [read,
  grep, find, ls, bash]`, `inherit_context: false`, and an extensive system prompt defining:
  read-only contract, tool-use workflow, structured output format (Answer/Evidence/Notes),
  parallel tool guidance, and failure modes to avoid. Users who want `@role` indirection can
  copy the file to `~/.pi/agent/agents/Explore.md` and change the `model:` field to `@fast`.
- **NEW** Three-tier agent resolution in `resolveAgentMdPath`:
  1. `<cwd>/.pi/agents/<type>.md` — project-local override
  2. `<getAgentDir()>/agents/<type>.md` — user-global override
  3. `<extensionDir>/agents/<type>.md` — bundled fallback (this package)
  Extension dir is computed once at module load from `import.meta.url`. Returns
  `{ path, source: "project" | "user" | "bundled" }` discriminator so the dashboard
  card can show the source tier.

### Modified capabilities
- **MODIFIED** `extensions/agent.ts:resolveAgentMdPath` — signature changes from
  `(type, cwd) → string|undefined` to `(type, cwd) → {path, source}|undefined`.
  Callers (`runAgentTool`, `snapshotDetails`, `AgentDetails`) updated. Backward-compatible
  at the `AgentDetails` level (path field unchanged; `source` is additive).
- **MODIFIED** `extensions/events.ts` — `AgentDetails.agentMdPath` type accepts the new
  shape. `buildDetails` passthrough updated.

### Breaking changes
- **BREAKING** Agent .md files with existing frontmatter will now be parsed and honored.
  Existing `research.md` that says `model: google/gemini-3.1-pro` will now actually run
  on Gemini instead of the parent default. This is the desired behavior; the previous
  behavior was a bug. Major version bump to 0.2.0.

## Capabilities

### New Capabilities
- `agent-md-frontmatter`: Parse and honor YAML frontmatter in agent `.md` definition files
  for `model`, `tools`, `prompt`, `inherit_context`, and `description` fields.
- `bundled-agents`: Ship default agent definitions with the package, resolved via a
  3-tier fallback (project → user → bundled). Bundle includes `Explore.md` with
  a literal model that works standalone.
- `subagent-role-aliasing`: Support `@role` syntax in agent frontmatter `model:` field.
  Resolve via the `role:resolve-model` event bus convention provided by the roles-plugin
  bridge (companion change). When the handler is not registered and a `@role` is used,
  fail the tool call with a clear error. Literal model references pass through unchanged.

### Modified Capabilities
- `subagent-emission`: `AgentDetails.agentMdPath` encodes the resolution source
  (`"project" | "user" | "bundled"`). Dashboard card can surface this as a badge.
  Backward-compatible: path field preserved; source is additive.

## Impact

**This repo (pi-dashboard-subagents):**
- `extensions/agent.ts` — `resolveAgentMdPath` signature change; `parseAgentMd` added;
  `runAgentTool` extended with frontmatter-driven model/tools/prompt selection;
  `@role` resolution via `pi.events.emit("role:resolve-model", probe)`
- `extensions/events.ts` — `AgentDetails.agentMdPath` type preserved, source is additive
- `extensions/index.ts` — re-exports updated
- `agents/Explore.md` — new file, shipped in package `files[]`
- `package.json` — add `"agents/"` to `files`, bump version to 0.2.0
- `README.md` — document bundled agents, frontmatter schema, override mechanic,
  `@role` convention

**Companion repo (pi-agent-dashboard):**
- `packages/roles-plugin/package.json` — add `"bridge": "./src/bridge/index.ts"`
- `packages/roles-plugin/src/bridge/index.ts` — NEW: ~25-line bridge that registers
  `role:resolve-model` handler on `pi.events`, reads `~/.pi/agent/providers.json`
- `packages/dashboard-plugin-runtime` — no changes; bridge auto-loading already
  handled by existing `dashboardPluginBridges` infrastructure
- No changes to `subagents-plugin` required
