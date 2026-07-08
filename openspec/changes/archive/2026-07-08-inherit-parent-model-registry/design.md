## Context

Subagents are spawned in-memory via `createAgentSession` inside `runAgentTool` (`extensions/agent.ts`). The `execute` callback receives `ctx: ExtensionContext`, which exposes a non-optional `modelRegistry: ModelRegistry` (`extensions/types.d.ts`) — the parent session's live registry. `ModelRegistry` carries a public readonly `authStorage: AuthStorage` (`model-registry.d.ts`).

Today the spawn call passes only `cwd`, `sessionManager`, and optional `model`/`thinkingLevel`. Because `createAgentSession` resolves the registry as `options.modelRegistry ?? ModelRegistry.create(authStorage, modelsPath)` (`sdk.js:96`), omitting `modelRegistry` forces a fresh disk build. That disk registry lacks any custom provider registered on the parent at runtime, so `getApiKeyAndHeaders(model)` (`sdk.js:204`) has no `providerRequestConfigs` for it → "No API key found for <provider>".

Flows already pass the parent registry (and its `authStorage`) into `createAgentSession`. Subagents diverge only by omission.

## Goals / Non-Goals

**Goals:**
- Subagents resolve any provider the parent can resolve, including custom providers (models + auth).
- Behavioral parity with the flows spawn path.
- Type-clean change: no casts.

**Non-Goals:**
- The dashboard-side fix (registering custom-provider auth synchronously before `discoverModels`). That is a separate, complementary change; without it the parent registry itself may lack the provider before a spawn.
- Changing how models are resolved/selected (`resolveModelFromRef`, `selectEffectiveModelRef`) — untouched.
- Removing the dead `getModelRegistry(pi)` fallback at `agent.ts:472` — unrelated.

## Decisions

**Decision: Pass `ctx.modelRegistry` into `createAgentSession`.**
This is the load-bearing change. Passing the parent's live instance short-circuits the disk build (`?? ModelRegistry.create(...)`), so request-time auth reads the parent's `providerRequestConfigs`. This is exactly the seam flows use.
- Alternative — rebuild a registry from `providers.json` inside the extension: rejected. Duplicates SDK logic, drifts from flows, and still races the dashboard's runtime registration.

**Decision: Also pass `authStorage: ctx.modelRegistry.authStorage`.**
Parity with flows (`options.authStorage ?? options.modelRegistry?.authStorage`). The passed registry already carries its own `authStorage` internally, so this is belt-and-suspenders for built-in (auth.json) providers. Harmless and keeps the two spawn paths identical.

**Decision: Keep conditional-spread style.**
Both fields are non-optional on `ExtensionContext`, so the guards are always-true and the spreads always fire — which is the intended behavior. The conditional form matches the adjacent `resolvedModel` / `resolvedThinkingLevel` spreads for local consistency. A flat assignment would also compile clean; either is acceptable.

## Risks / Trade-offs

- [Parent registry itself lacks the custom provider at spawn time] → Out of scope here; addressed by the dashboard-side synchronous-registration fix. This change is necessary but not sufficient on its own for the dashboard path.
- [Sharing a live registry instance across parent and subagent] → Read-only usage at request time; no subagent-side mutation introduced. Same sharing model flows already rely on.
- [Spread key collisions] → None; `modelRegistry`/`authStorage` do not collide with `model`/`thinkingLevel`.
