## Context

`runAgentTool` (`extensions/agent.ts`) builds an in-memory child session via `createAgentSession`. Evidence from pi-coding-agent 1.0.3 `dist/core/sdk.js`:

- L120-136: thinking level = `options.thinkingLevel` -> per-model setting -> `defaultThinkingLevel` -> `medium`.
- L74: `modelRuntime = options.modelRuntime ?? ModelRuntime.create({authPath, modelsPath})`. No `modelRegistry`/`authStorage` options exist since 0.80.8.

Current code (L1228-1236) passes `modelRegistry`/`authStorage` (ignored) and drops `thinkingLevel` when it is `"off"`.

Extension surfaces available in 1.0.3: `ctx.thinkingLevel?` (ExtensionContext), `pi.getThinkingLevel()` (ExtensionAPI), `ctx.modelRegistry` (ModelRegistry wrapping a private `runtime: ModelRuntime`).

## Goals / Non-Goals

**Goals:** honor `:off`, inherit the parent's live level, restore runtime inheritance on pi 1.x, allow 1.x peers.

**Non-Goals:** per-agent `thinking:` frontmatter field; changing role resolution; supporting pi <0.80.8.

## Decisions

1. **Thinking precedence: suffix > parent live level > pi defaults.**
   Parent level source: `ctx.thinkingLevel ?? pi.getThinkingLevel?.()`.
   Alternative: let pi's per-model setting beat the parent level. Rejected because the user's live choice is the most recent intent, and an explicit suffix remains the override.
2. **Pass `thinkingLevel` whenever defined.** Remove the `!== "off"` guard. pi clamps unsupported levels itself.
3. **Runtime inheritance via `modelRuntime`.** Obtain it from `ctx.modelRegistry`. The SDK declares `runtime` private, so read it through a small typed accessor `getParentModelRuntime(ctx)` that returns `undefined` if the field is missing. Pass `{ modelRuntime }` only when defined; otherwise log one stderr warning and let pi build its default.
   Alternative: construct a new `ModelRegistry`. Rejected because it loses extension-registered providers, which is the whole point.
   Open risk: relying on a private field. Mitigation: guarded accessor + test, plus an upstream request for a public accessor.
4. **Drop `modelRegistry`/`authStorage` from the call.** They are dead options on the supported range.
6. **Develop and test against pi 1.0.4.** Dev deps pin `^1.0.4` so CI type-checks against 1.x. The pi 1.x API break also hits test code: `fanout-memory.test.ts` uses the removed `AuthStorage`, `ModelRegistry.inMemory` and `registerFauxProvider`, so it gets ported to `ModelRuntime` + `fauxProvider()`.
5. **Peer range `>=0.80.8 <2`.** 0.80.8 is the floor where `modelRuntime` exists. pi <0.80.8 is dropped (**BREAKING** for those users, so release notes call it out).

## Risks / Trade-offs

- Private `runtime` field may be renamed -> accessor returns undefined -> fallback + warning; covered by test.
- Inheriting the parent level changes subagent cost/latency for users who relied on the settings default. Documented in CHANGELOG.

## Migration Plan

Release 0.2.6. pi-agent-dashboard bumps its dependency. Rollback: reinstall 0.2.5.
