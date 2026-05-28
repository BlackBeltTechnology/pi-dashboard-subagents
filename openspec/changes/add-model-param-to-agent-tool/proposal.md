## Why

Today the `Agent` tool reads its model from one source only: the frontmatter `model:` field of a curated `.md` file (3-tier lookup project → user → bundled). When the LLM calls `Agent({ subagent_type: "research-spike", … })` with a label that has NO matching `.md`, the tool silently inherits the parent's model — there is no way for the LLM to pick a model at call time.

That hole was discovered live (session log of 2026-05-28): calling `Agent({ subagent_type: "general-purpose" })` worked (no .md found → fall through to parent defaults), but with **no way to ask for `@fast` or any other model** without first authoring a `.md` file. The fallback resolver and the `model:resolve` event bus contract are **never reached** in this path because the gate `if (agentConfig?.model)` short-circuits.

The fix is a single optional schema field — `model?: string` — that routes through the SAME `resolveModelFromRef` function the frontmatter path uses. All three input forms (`@role`, `provider/model[:thinking]`, bare `model-id`) work for free because the resolver is unchanged. The change is purely additive: existing callers pass nothing for `model` and get today's behaviour.

## What Changes

- **ADDED** Optional `model` field on the `Agent` tool's parameter schema:
  - Accepts `"@role"`, `"provider/model[:thinking]"`, or bare `"model-id"`.
  - Resolved via `resolveModelFromRef(pi, args.model, agentMdPath)` — identical mechanism to frontmatter, including the `model:resolve` event-bus primary path and the in-process `pi.modelRegistry` fallback.
- **MODIFIED** `runAgentTool` precedence rule for model resolution: `args.model ?? agentConfig?.model`. If both are present, the tool-call arg wins. If both are absent, no `model` override is passed to `createAgentSession` (parent default applies — unchanged from today).
- **MODIFIED** `Agent` tool `description` field — teaches the LLM that there are two modes: curated (`.md` provides defaults) and inline (pass `model`, future-friendly for additional inline fields). The schema description for `subagent_type` clarifies that a missing `.md` is fine and runs with parent defaults.
- Error surface unchanged — same `resolveModelFromRef` produces the same error messages whether the ref came from `args.model` or `agentConfig.model`. The error message identifies the source (the agent .md path or `(tool-call argument)`).

Non-changes (deliberate):

- `tools` and per-call instructions (system-prompt preamble) are **NOT** added in this change. Per design Decision 2, those belong to curated `.md` agents; adding them inline would encourage skipping curation. Deferred to follow-up if/when the need arises.
- `isolated` is not promoted — it stays gated by the existing `exposeInheritanceInTool` setting.
- The bundled-agents tier and `BUNDLED_AGENTS_DIR` infrastructure are NOT touched here. (Explore.md has already been moved to pi-agent-dashboard's project directory in a separate hand-off; the tier removal is a separate concern.)

## Capabilities

### New Capabilities

(none — additive change to an existing capability)

### Modified Capabilities

- `subagent-emission`: the `Agent` tool registration's parameter schema now accepts the optional `model` field. New scenarios cover the three input forms and the precedence rule.
- `agent-md-frontmatter`: the "Frontmatter `model` field SHALL drive subagent model selection" requirement is amended with the precedence rule (tool-call `args.model` wins over `agentConfig.model` when both are present).

## Impact

- **Code (single repo, single file mostly):**
  - `extensions/agent.ts` — extend `buildAgentParametersSchema` with optional `model`, extend `AgentToolArgs`, replace the gate `if (agentConfig?.model)` with `if (effectiveModelRef)` using the precedence rule, update tool description string.
  - No new helpers, no new types beyond a one-line addition to `AgentToolArgs`.
- **Tests:** 5 new scenarios in `extensions/__tests__/agent.test.ts` (or a new small file) exercising the three input forms + the precedence rule + an invalid arg case.
- **Docs:** `README.md` "Model resolution" section gains a "Per-call override" subsection documenting the new field.
- **CHANGELOG:** additive entry under `[Unreleased]`.
- **No breaking changes.** Old callers omit `model` and get today's behaviour exactly.
- **No new dependencies.**
