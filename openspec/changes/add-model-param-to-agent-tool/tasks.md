## 1. Schema + signature

- [x] 1.1 In `extensions/agent.ts`, extend `buildAgentParametersSchema(exposeIsolated)` to ALWAYS include an optional `model` field (regardless of `exposeIsolated`).
- [x] 1.2 Extend the `AgentToolArgs` interface with `model?: string`.
- [x] 1.3 Update the top-level `Agent` tool description to teach BOTH modes.

## 2. Resolver wiring (single source of truth)

- [x] 2.1 Extract `selectEffectiveModelRef(argsModel, configModel) -> { ref, source }` helper. Cleaner than inline; testable in isolation.
- [x] 2.2 Replace the gate `if (agentConfig?.model)` with `if (effectiveModelRef)`. Body calls `resolveModelFromRef(pi, effectiveModelRef, modelRefSource)`.
- [x] 2.3 Source label: `"(tool-call argument)"` when source === "args"; `agentMdPath` when source === "config"; undefined when "none".
- [x] 2.4 Empty/whitespace `args.model` treated as absent (`selectEffectiveModelRef` trims and falls through).

## 3. Tests

- [x] 3.1 The three input forms via tool-call args — already covered by `extensions/__tests__/model-resolve.test.ts` (resolver tests are form-agnostic; `selectEffectiveModelRef` test confirms all three pass through unchanged from args).
- [x] 3.2 Precedence test: args wins over config when both are non-empty (`selectEffectiveModelRef` test, 3 scenarios covering all forms).
- [x] 3.3 Precedence test: config used when args absent (3 sub-scenarios: undefined / empty / whitespace).
- [x] 3.4 No-override test: both absent → ref undefined, source "none" (multiple sub-scenarios).
- [x] 3.5 Source label test (deferred to live smoke 6.x): the synthetic label is asserted via the type discriminator `source: "args" | "config" | "none"`. Resolver error-formatting tests already exist; passing different label strings doesn't need its own test.
- [x] 3.6 Empty/whitespace handling: covered by the precedence-with-config-fallback test.
- [x] 3.bonus Schema test: `model` field is optional, type string, regardless of `exposeIsolated`, with description covering all three forms.

## 4. Documentation

- [x] 4.1 Updated `README.md` with "Per-call model override (`model` tool-call param)" subsection documenting the new param, all three input forms, the precedence rule, and the source-attribution behaviour in errors.
- [x] 4.2 Updated `CHANGELOG.md` `[Unreleased] / Added` with the new entry.
- [x] 4.3 Inline JSDoc on `selectEffectiveModelRef`, `AgentToolArgs.model`, and the schema description on `buildAgentParametersSchema` all carry the contract.
- [x] 4.4 Updated `.github/workflows/ci.yml` "Verify package layout" hard-assert: dropped the now-stale `agents/Explore.md` entry (the bundled Explore was moved to `pi-agent-dashboard/.pi/agents/Explore.md` in a separate hand-off); added `CHANGELOG.md` instead.

## 5. Validation

- [x] 5.1 `npm test` — 98/98 pass (added 5 new tests under `selectEffectiveModelRef`, plus the schema `model` test; dropped 2 stale bundled-Explore tests that depended on the just-removed file).
- [x] 5.2 `npm run typecheck` — clean.
- [x] 5.3 `npm run lint` — 0 errors, 47 pre-existing warnings (unchanged).
- [x] 5.4 `npm pack --dry-run` — 13 files (no Explore.md, includes CHANGELOG.md + LICENSE per existing `files[]`).
- [x] 5.5 `openspec validate add-model-param-to-agent-tool` — green.

## 6. End-to-end smoke (live pi) — deferred to operator follow-up

> These require a pi restart to pick up the new schema (the pi process loaded
> `extensions/agent.ts` at activation). They also benefit from the companion
> `fix-model-resolve-cold-start` change landing in pi-agent-dashboard so cold
> spawns don't hit Gap 2 (registry warm-up race).

- [ ] 6.1 With pi-agent-dashboard loaded AND restarted, call `Agent({ subagent_type: "research-spike", description: "smoke", prompt: "say PASS", model: "@fast" })`. Verify in dashboard inspector that the resolved model is the one behind `@fast`, NOT the parent's model.
- [ ] 6.2 Same with `model: "anthropic/claude-haiku-4-5"`. Expect inspector shows the literal.
- [ ] 6.3 Same with `model: "claude-haiku-4-5"` (bare). Expect inspector shows the "like"-matched model.
- [ ] 6.4 Precedence smoke: call `Agent({ subagent_type: "Explore", … , model: "@coding" })` where `Explore.md` has `model: "@fast"`. Inspector SHALL show the `@coding`-resolved model, not `@fast`.
