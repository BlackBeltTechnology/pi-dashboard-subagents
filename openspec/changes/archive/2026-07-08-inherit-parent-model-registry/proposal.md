## Why

When a subagent spawns via `createAgentSession`, it builds a fresh `ModelRegistry` from disk (`models.json` + `auth.json`). That fresh registry does not contain custom providers registered on the parent session at runtime (e.g. from `providers.json`), so any subagent targeting a custom-provider model fails at request time with "No API key found for <provider>". Flows already avoid this by passing the parent's live registry; subagents should behave identically.

## What Changes

- Subagent spawn inherits the parent session's live `ModelRegistry` instance instead of letting `createAgentSession` construct a fresh disk-backed one.
- The parent registry's `authStorage` is passed alongside for parity with the flows spawn path.
- Custom-provider models (models AND `providerRequestConfigs` auth) resolvable in the parent become resolvable in subagents.

## Capabilities

### New Capabilities
- `subagent-model-registry-inheritance`: A spawned subagent session inherits the parent session's live model registry and auth storage, so any provider (built-in or custom) resolvable in the parent is resolvable in the subagent.

### Modified Capabilities
<!-- None: no existing spec's requirements change. -->

## Impact

- Code: `extensions/agent.ts` — the `createAgentSession` call inside `runAgentTool` (~line 914).
- SDK seam: `createAgentSession` uses `options.modelRegistry ?? ModelRegistry.create(...)`; passing the parent registry short-circuits the disk build. Auth is read at request time via `modelRegistry.getApiKeyAndHeaders(model)`.
- No breaking changes. Built-in (auth.json) provider behavior is unchanged; the effect is additive (custom providers now resolve).
- Complements a dashboard-side fix that registers custom-provider auth synchronously before `discoverModels`, so the parent registry carries it before any spawn.
