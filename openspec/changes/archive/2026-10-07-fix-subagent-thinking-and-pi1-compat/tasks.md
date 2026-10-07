## 1. Thinking level

- [x] 1.1 Write failing tests in `extensions/__tests__/`: `:off` suffix reaches `createAgentSession` as `thinkingLevel: "off"`; `@role` resolving to `:off` does the same; `:high` is passed through
- [x] 1.2 Write failing tests: no suffix + parent `ctx.thinkingLevel = "low"` -> child `low`; no suffix + no parent level -> `thinkingLevel` omitted
- [x] 1.3 In `runAgentTool`, compute `effectiveThinking = resolvedThinkingLevel ?? ctx.thinkingLevel ?? pi.getThinkingLevel?.()` and pass it whenever defined (remove the `!== "off"` guard)
- [x] 1.4 Tests green

## 2. Model runtime inheritance

- [x] 2.1 Write failing test: `createAgentSession` receives `modelRuntime` equal to the parent registry's runtime; `modelRegistry`/`authStorage` are no longer passed
- [x] 2.2 Write failing test: when the runtime is unavailable, `modelRuntime` is omitted and one stderr warning is logged
- [x] 2.3 Add `getParentModelRuntime(ctx)` guarded accessor and use it in the `createAgentSession` call
- [x] 2.4 Manual check (run on pi 1.0.3, the installed CLI): subagent on custom provider `proxy/glm/glm-5.3-flash` resolved auth, answered PONG; `runtimeInherited=true` (no "No API key found")

## 3. Packaging and docs

- [x] 3.1 `package.json`: peer deps `@earendil-works/pi-ai`, `pi-coding-agent`, `pi-tui` -> `>=0.80.8 <2`; dev deps -> `^1.0.4`; lockfile refreshed
- [x] 3.1a Version 0.2.6 in `package.json`
- [x] 3.1b `npx tsc --noEmit` clean against pi 1.0.4 (currently fails: `agent.ts` L1231 `authStorage` (fixed by 2.3); `fanout-memory.test.ts` below)
- [x] 3.1c Port `extensions/__tests__/fanout-memory.test.ts` to the pi 1.x API: `registerFauxProvider` -> `fauxProvider()`; `AuthStorage.inMemory()` + `ModelRegistry.inMemory()` -> `ModelRuntime.create()` + `registerNativeProvider(faux.provider)` + `setRuntimeApiKey`; pass `modelRuntime` through ctx; fix `context.tools` typing on `TranscriptContext`
- [x] 3.1d Run `npm run test:fanout-memory` (gc-gated, skipped in `npm test`) green on 1.0.4
- [x] 3.2 `CHANGELOG.md`: Fixed (`:off`, parent level, runtime inheritance); Changed (peer range, pi <0.80.8 dropped)
- [x] 3.3 Update `extensions/AGENTS.md` row for `agent.ts`
- [x] 3.4 `npm test` (138 pass) + fanout-memory + lint (0 errors, no new warnings) + tsc green; `review-code` pass: 1 blocker (missing pi 1.x `max` level) fixed + re-reviewed

## 4. Verification

- [x] 4.1 Manual check via pi RPC (headless; equivalent session-scoped `set_thinking_level low`, not saved; settings default `medium`): no suffix -> child `thinking=low`; `:off` -> child `thinking=off`. Observed with a temporary stderr probe of `session.thinkingLevel`, since removed. Dashboard-inspector visual not checked

## 5. Follow-ups (out of scope)

- [x] 5.1 `.pi/skills/manage-flows/SKILL.md` (pi-flows agent format) lists thinking levels without `max`; fix upstream in pi-flows, not here (handed off: pi-flows also lacks prod `modelRuntime` wiring; separate change there)
