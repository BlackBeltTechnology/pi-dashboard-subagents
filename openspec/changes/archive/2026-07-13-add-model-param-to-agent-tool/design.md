## Context

`extensions/agent.ts` today:

```ts
const agentConfig = agentMdPath ? parseAgentMd(agentMdPath) : undefined;
// …
if (agentConfig?.model) {
  const resolution = resolveModelFromRef(pi, agentConfig.model, agentMdPath);
  // hard-fail on resolution.error
}
```

The gate `if (agentConfig?.model)` is the only entry point to `resolveModelFromRef`. When no `.md` exists OR the `.md` has no `model:` field, `resolveModelFromRef` is never called and no `model` argument is passed to `createAgentSession` — the subagent silently inherits the parent's model.

That's fine for true general-purpose spawns, but it means the LLM cannot pick a model at call time without authoring a `.md` first. Discovered live on 2026-05-28: calling `Agent({ subagent_type: "general-purpose" })` worked structurally but had no way to specify `@fast`.

The fix is to add an optional `model` parameter to the tool schema and route it through the same resolver. Everything downstream of `resolveModelFromRef` already supports the three input forms (`@role`, `provider/model[:thinking]`, bare `model-id`) via the `model:resolve` event-bus contract introduced in the archived change `add-model-resolve-event-with-fallback`.

## Goals / Non-Goals

**Goals:**

- LLM can pass `model: "@fast"`, `model: "provider/id"`, or `model: "bare-id"` directly in the tool call, with no `.md` required.
- Resolution mechanism is **identical** to the frontmatter path — same function, same event, same fallback, same error messages.
- Tool-call `model` overrides `.md` `model` when both are present.
- Existing callers continue to work bit-for-bit (no breaking change).
- Tool description teaches the LLM that there are two modes.

**Non-Goals:**

- Adding `tools`, `instructions`/system-prompt, or other inline frontmatter fields. Those belong to curated agents.
- Promoting `isolated` to always-on. It stays gated by `exposeInheritanceInTool`.
- Touching the bundled-agents tier. Tier-removal is a separate concern; the dashboard now owns `Explore.md` via its project directory in `pi-agent-dashboard/.pi/agents/Explore.md` (hand-off already done outside this change).
- Changing the resolver itself. `resolveModelFromRef` is unchanged.
- Adding new error message shapes. `resolveModelFromRef` already covers the failure cases; we reuse them.

## Decisions

### Decision 1: Single field `model`, not a bundle

We considered exposing `tools`, `instructions`, `isolated`, and `model` all at once. Rejected for this change. Per user steer (2026-05-28): "*if general purpose have task only THAT is completely fine, the only NOT FINE THING IS not having anything*" — meaning the only urgent gap is **no way to pick a model**. The other fields are architectural curation knobs that belong in `.md` files where they're reusable; surfacing them inline pulls the LLM away from curation. We can revisit if a real use case emerges.

### Decision 2: Reuse `resolveModelFromRef` verbatim — no new resolver

The resolver already handles all three input forms via the `model:resolve` event. There's no reason to fork or duplicate logic for the tool-call path. The single behavioural difference is the value of `agentMdPath` in the error footer: when the ref comes from the tool call, the footer reads `Agent definition: (tool-call argument)` instead of a real file path. That's a literal-string change inside the same code path, captured by a single helper update.

### Decision 3: Precedence — args wins over .md

```
  args.model         (highest — explicit per-call intent)
   > agentConfig.model
    > pi default (settings.json)
```

Rationale: when both `args.model` and `agentConfig.model` are present, the LLM is asking for an exception ("use Explore.md's curation BUT spawn it on @fast for this one call"). Honouring `args.model` is the principle of least surprise. If the operator wants `.md` to win, they remove the inline arg.

Alternative considered: error on conflict. Rejected — noisy and unhelpful; the LLM's intent is clear.

### Decision 4: Error message footer carries the source name

`resolveModelFromRef` takes an `agentMdPath` parameter that goes into the "Agent definition: …" error footer. When the ref comes from the tool call, we pass a synthetic identifier (literal `"(tool-call argument)"` or similar) so error messages still tell the operator where the unresolvable ref came from. No new error shape; just a label switch.

### Decision 5: Schema field name and description

```ts
model: Type.Optional(Type.String({
  description:
    'Optional model override. Accepts "@role", "provider/model-id[:thinking]", or bare "model-id". ' +
    'When provided, overrides any model from the agent .md file. ' +
    'When omitted, the .md (if any) or the parent default applies.',
}))
```

Single field name `model` matches the frontmatter field exactly so the LLM doesn't have to remember two names for the same concept. The description carries the precedence rule.

### Decision 6: Tool top-level `description` rewritten to teach both modes

The current description is one paragraph about spawning a foreground subagent. We add a second short paragraph clarifying:

```
   "Two modes:
    • Curated — when <subagent_type> matches a project/user/bundled .md
      file, that file's frontmatter supplies model, tools, prompt preamble.
    • Inline — when no .md matches, the spawn runs with parent defaults;
      pass `model` to pick a specific model (@role, provider/model, or
      bare id) without curating an .md."
```

Keep concise — tool descriptions are visible context to every LLM call.

### Decision 7: No schema change to existing required fields

`subagent_type`, `description`, `prompt` stay exactly as today. The new `model` field is additive and optional. `isolated` (when exposed) stays as today.

## Risks / Trade-offs

- **[Risk]** LLMs over-use the inline path and stop curating `.md` files. → Mitigated by tool description steering ("Inline … to pick a specific model without curating"). Long-form curation (tools, system preamble) still requires an `.md`, so curation incentive remains.

- **[Risk]** A `model: "claude-haiku-4-5:high"` arg gets the `:thinking` suffix parsed off twice if the resolver is called twice. → Not a real risk; the resolver is called exactly once per spawn, and the suffix parser is idempotent (single `lastIndexOf(":")` split).

- **[Trade-off]** The synthetic "Agent definition: (tool-call argument)" footer is uglier than a real file path. Acceptable; the alternative (omitting the footer for tool-call refs) loses information about where the bad ref came from.

- **[Risk]** Backward compatibility break if `Agent` tool consumers parse the parameter schema strictly. → No risk: TypeBox-style schemas with optional fields are additive at the JSON Schema level. Existing parsers ignore unknown optional fields.

- **[Risk]** Spec drift between `subagent-emission` (where the tool schema lives) and `agent-md-frontmatter` (which now references args precedence). → Mitigated by writing the precedence rule once in `agent-md-frontmatter` and cross-referencing from `subagent-emission`.

## Migration Plan

No user migration. The change is purely additive. After landing:

- Existing `.md`-based agents continue to work bit-for-bit.
- Existing callers that pass only `{ subagent_type, description, prompt }` continue to work bit-for-bit.
- New callers that want to pick a model add `model: "@fast"` (or whatever) to their tool call.

Rollback: revert the change. Schema returns to today's form. No on-disk state involved.

## Open Questions

1. **Should the tool description include a 3-line example?** The dashboard inspector shows the tool description verbatim and we're already at a few lines. Lean: yes, one tight example like `Agent({ subagent_type: "spike", description: "audit auth", prompt: "...", model: "@research" })`. Documents the param at the point of use.

2. **Should `model` be exposed via `exposeInheritanceInTool` or always exposed?** Lean: always exposed. The inheritance toggle gates the `isolated` field because that affects sensitive parent-context handling. `model` is a per-call routing decision; no security surface to gate. Confirm in implementation.

3. **Companion follow-up for `tools`/`instructions` deferred?** Not in this change. If the need arises later, a separate proposal `expose-tools-and-instructions-as-tool-call-params` revisits.
