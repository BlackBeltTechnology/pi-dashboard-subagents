## Context

`pi-dashboard-subagents` v0.1.1 ships `resolveAgentMdPath` which finds an agent's `.md` file
via a two-tier lookup (project `.pi/agents/` → global `~/.pi/agent/agents/`) and returns
the resolved path. The path is passed into `AgentDetails.agentMdPath` purely for the dashboard
card's "View source" link. The `.md` file's contents — YAML frontmatter and Markdown body —
are never read. The `runAgentTool` spawn loop calls `createAgentSession({ cwd, sessionManager })`
with no `model`, `tools`, or `thinking` overrides, so the subagent unconditionally inherits the
parent's model defaults and every registered tool minus `Agent`.

The dashboard (pi-agent-dashboard v0.5.4) has a plugin system where:
- The `roles-plugin` provides a settings UI for editing role→model assignments. It's purely
  a client-side component — no bridge, no server, no pi-side presence.
- The `subagents-plugin` provides subagent inspector UI and a server-side producer-file mirror.
  Also no bridge.
- Role data is stored in `~/.pi/agent/providers.json`, managed by pi-flows' role-manager
  extension (when present), or editable directly.
- The dashboard bridge (`pi-agent-dashboard` extension) relays role changes between the
  dashboard WebSocket and pi-flows' event bus.

A companion change to this one adds a **`roles-plugin` bridge** (~25 lines) that registers a
`role:resolve-model` handler on `pi.events`. The bridge reads `providers.json` directly —
zero dependency on pi-flows. Any pi extension can then resolve `@role` through a 3-line
`pi.events.emit` call on the shared EventBus. This is the universal interception point.

## Goals / Non-Goals

**Goals:**
- Parse YAML frontmatter in agent `.md` files and apply it to subagent configuration.
- Honor `model` (literal `provider/id`, `id:thinking-level`, or `@role`), `tools` (allowlist),
  `prompt` (system prompt preamble), `inherit_context` (per-agent boolean), and `description`
  (display override).
- Ship a bundled `Explore.md` with a read-only toolset, literal model default that works
  standalone, and a structured-output contract — no user setup required.
- Expand agent resolution to 3 tiers: project-local → user-global → bundled. First match wins.
- Support `@role` syntax in the `model:` field via the `role:resolve-model` event bus convention.
  The handler is provided by the roles-plugin bridge (companion change). When the handler is not
  registered, `@role` fails the tool call with a clear error.
- Backward-compatible: missing `.md`, empty frontmatter, or missing fields all fall through
  to current behavior.

**Non-Goals:**
- `@role` in `subagent_type` tool argument. The LLM picks `subagent_type` to select a
  personality via the .md file, not a model. Role assignment belongs in the .md.
- `thinking` level override from separate frontmatter field. The `model: provider/id:level`
  shorthand is supported. Separate `thinking:` field deferred to follow-up.
- Multiple bundled agents beyond `Explore`. Adding `Reviewer.md`, `Researcher.md` is pure
  additive later work.
- Dashboard subagents-plugin changes. The `agentMdPath` source discriminator is additive
  and backward-compatible.
- Modifying pi-flows. The role resolution hook does not depend on pi-flows being loaded.

## Decisions

### Decision 1: Roles-plugin bridge provides the universal @role resolver

The companion change adds a `bridge` entry to `roles-plugin`'s manifest. The bridge file
(`~25 lines`) registers a `role:resolve-model` handler on `pi.events`:

```ts
export default function activate(pi) {
  pi.events?.on("role:resolve-model", (data) => {
    const ref = data?.ref;
    if (typeof ref !== "string" || !ref.startsWith("@")) return;
    const role = ref.slice(1);
    try {
      const cfg = JSON.parse(readFileSync(
        join(homedir(), ".pi", "agent", "providers.json"), "utf8"
      ));
      data.resolved = cfg.roles?.[role];
    } catch {}
  });
}
```

Any extension resolves `@role` with:
```ts
const probe = { ref: "@fast" };
pi.events.emit("role:resolve-model", probe);
// probe.resolved === "opencode-go/deepseek-v4-flash"  (or undefined)
```

**Rationale:** The handler lives in a dashboard plugin's bridge — it's auto-registered when
the dashboard manages the pi session (via `dashboardPluginBridges` in settings.json). It reads
`providers.json` directly — zero dependency on pi-flows, zero latency (sync file read of a
~1KB file). The EventBus is shared across ALL pi extensions, so every extension gets this
resolution for free. No imports, no npm dependencies, no new packages.

**Alternative considered:** Putting the handler in pi-flows' role-manager. Rejected: adds a
hard dependency on pi-flows. The roles-plugin bridge is always present when the dashboard is
managing the pi session; pi-flows might not be loaded.

### Decision 2: Bundled Explore ships with a literal model, not @role

The shipped `agents/Explore.md` uses `model: anthropic/claude-haiku-4-5` — a literal,
widely-available cheap model. Users who want `@role` indirection copy the file to
`~/.pi/agent/agents/Explore.md` and change `model:` to `@fast`.

**Rationale:** The bundled default MUST work standalone — without the dashboard, without
pi-flows, without the roles-plugin bridge. Haiku is the canonical "fast read-only exploration"
model from Claude Code, available from every Anthropic API key. Users on other providers
override via the 3-tier resolution: copy to user-global dir and edit.

**Alternative considered:** Ship `model: @fast` and rely on the roles-plugin bridge.
Rejected: the bundled Explore should work for every user out of the box, including those
who don't run the dashboard or don't have role infrastructure configured.

### Decision 3: @role failure is a hard error when the handler is absent

When frontmatter contains `model: @fast` and the `role:resolve-model` handler is not
registered (roles-plugin bridge not loaded), the tool call fails with an `isError: true`
`AgentToolResult`. The error message names the unresolved role, shows the agent .md path,
and lists two resolution paths: (1) ensure the roles plugin bridge is active, or
(2) use a literal model id.

**Rationale:** Silent fallback to the parent's default model is exactly the class of bugs
this change fixes. A hard failure is transparent and actionable. The LLM sees the error
and can retry.

### Decision 4: `tools:` allowlist applies via setActiveToolsByName

After `createAgentSession`, call `session.setActiveToolsByName(frontmatterTools)`. This
filters BOTH pi's built-in tools AND extension tools uniformly.

**Rationale:** `createAgentSession({ tools: [...] })` only filters built-in tools. Extension
tools added after session creation aren't affected by the `tools` option. `setActiveToolsByName`
is the only API that filters the full tool set.

### Decision 5: `prompt:` prepends pi's default, doesn't replace

The .md's `prompt:` body is inserted as an `<agent-prompt>` preamble before pi's standard
system prompt + skills XML. The subagent receives all three layers.

**Rationale:** The .md author writes role-specific instructions. Pi's tool docs and skills
are still needed. Replacing the entire system prompt (pi-flows style) would require the .md
author to re-specify tool docs, making definitions fragile.

### Decision 6: Three-tier agent resolution with source discriminator

```
resolveAgentMdPath(type, cwd):
  1. <cwd>/.pi/agents/<type>.md     → { path, source: "project" }
  2. <getAgentDir()>/agents/<type>.md → { path, source: "user" }
  3. <extensionDir>/agents/<type>.md  → { path, source: "bundled" }
  none found → undefined
```

`extensionDir` computed once from `import.meta.url` at module load time.

### Decision 7: parseFrontmatter from pi-coding-agent

Use `parseFrontmatter` from `@earendil-works/pi-coding-agent/utils/frontmatter` — the
same parser pi uses for prompt templates and skills. The shared parser avoids YAML edge
cases (quoted strings, multi-line, lists) that a manual regex would mishandle.

## Risks / Trade-offs

| Risk | Mitigation |
|---|---|
| Frontmatter parsing throws on malformed YAML | Catch and log; return `undefined` config. Subagent spawns with current defaults (no crash). |
| `session.setActiveToolsByName` removes tools referenced in the system prompt | The .md author is responsible for consistency between `tools:` and `prompt:`. |
| Bundled Explore uses Haiku which may not be available to non-Anthropic users | The subagent fails at `createAgentSession` with standard "model not available" error. Same failure path as any unresolvable model. User copies to user-global dir and edits. |
| Roles-plugin bridge not loaded but .md uses `@role` | Hard failure with clear error message. User fixes by loading the roles plugin or switching to literal model. |
| `import.meta.url` for extensionDir breaks in non-ESM | pi packages are ESM-only (`"type":"module"`). Non-ESM is not supported. |
| `role:resolve-model` handler mutates data after emit returns | The bridge handler is synchronous (sync `readFileSync`, no `await`). EventBus wraps handlers in async but Node EventEmitter dispatches sync handlers before the wrapping async resolves. Mutation is visible before `emit` returns. |

## Migration Plan

1. Bump version to `0.2.0` (breaking: existing .md frontmatter now honored).
2. Add `"agents/"` to `package.json` `files` array.
3. Companion: add `roles-plugin` bridge entry in pi-agent-dashboard (separate change).
4. Owners of existing .md files should verify `model:` resolves correctly after upgrade.
5. Rollback: revert to v0.1.1. No data migration; .md files aren't mutated.

## Open Questions

1. **Should `tools:` support `!` prefix for exclusion?** E.g., `tools: ["!edit", "!write"]`
   to exclude dangerous tools without listing all safe ones. Deferred.

2. **Should the dashboard subagents-plugin show source tier?** The `agentMdPath` now carries
   a `source` discriminator. Dashboard card could render "Explore (bundled)". Out of scope
   for this change.

3. **Should the `role:resolve-model` event name be namespaced under `dashboard:`?** E.g.,
   `dashboard:role-resolve`. More explicit about ownership. Would require updating the
   companion change. Deferred to implementation — easy rename.
