## 1. Implementation

- [x] 1.1 In `extensions/agent.ts`, at the `createAgentSession` call inside `runAgentTool` (~line 914), add `modelRegistry: ctx.modelRegistry` (conditional-spread, matching adjacent options)
- [x] 1.2 Add `authStorage: ctx.modelRegistry.authStorage` alongside, for parity with the flows spawn path
- [x] 1.3 Add an inline comment explaining why the parent registry is inherited (custom-provider models + `providerRequestConfigs` auth)

## 2. Verification

- [x] 2.1 Type-check passes with no casts (`as any`) introduced
- [x] 2.2 Manual/integration check: a subagent targeting a custom-provider model resolves without "No API key found for <provider>" (mechanism verified: `sdk.js:96` `?? ModelRegistry.create` short-circuit + `sdk.js:204` request-time auth read; full suite incl. `inheritance-e2e` green)
- [x] 2.3 Regression check: a subagent targeting a built-in (auth.json) provider still resolves unchanged (98/98 tests pass, typecheck clean)
