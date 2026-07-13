## 1. Resolver rewrite

- [x] 1.1 Add a `ModelResolveProbe` interface in `extensions/agent.ts` matching the design's probe shape (`ref`, `resolved?`, `model?`, `thinkingLevel?`, `auth?`, `error?`, `available?`).
- [x] 1.2 Rewrite `resolveModelFromRef(pi, ref, agentMdPath)` to follow the primary-then-fallback algorithm: emit `model:resolve`, inspect `probe.model` and `probe.error`, fall through to in-process resolver when silent.
- [x] 1.3 Extract the `:thinking` suffix parser into a small helper shared by the fallback (the handler does its own parsing).
- [x] 1.4 In-process fallback: implement `provider/model` split + `registry.find()`; implement bare-id "like" query via `registry.getAll().find(m => m.id === literal)`; reject `@role` with actionable error pointing at dashboard/pi-flows install.
- [x] 1.5 Error message catalogue: produce distinct, structured error text for (a) handler-reported error, (b) `@role` with no handler, (c) unknown literal / unknown bare id, (d) registry unavailable. Each MUST include the agent .md file path.
- [x] 1.6 Remove the legacy `role:resolve-model` emit and its associated probe shape from the codebase.

## 2. Tests

- [x] 2.1 Add `extensions/__tests__/model-resolve.test.ts` (new file) covering the resolver in isolation with a stub `pi.events` and a stub `pi.modelRegistry`.
- [x] 2.2 Scenario test: handler fills `probe.model` for `@role` → resolver returns that Model + thinkingLevel, fallback NOT invoked.
- [x] 2.3 Scenario test: handler fills `probe.model` for `provider/model` → same.
- [x] 2.4 Scenario test: handler fills `probe.model` for bare `model` → same.
- [x] 2.5 Scenario test: handler sets `probe.error` for `@unknownrole` → resolver returns error including `available.roles`.
- [x] 2.6 Scenario test: silent emit (no handler) + `provider/model` → fallback uses `registry.find()`, succeeds.
- [x] 2.7 Scenario test: silent emit + bare `model` → fallback uses `registry.getAll().find()`, succeeds.
- [x] 2.8 Scenario test: silent emit + `@role` → fallback refuses with "install pi-agent-dashboard or pi-flows" message; verify message contains the agent .md path.
- [x] 2.9 Scenario test: silent emit + unknown bare id → fallback returns error naming the ref, with a models hint.
- [x] 2.10 Scenario test: thinking suffix `:high` is parsed in BOTH paths (handler-supplied probe carries `thinkingLevel`, fallback parses it locally).
- [x] 2.11 Update `extensions/__tests__/agent.test.ts` end-to-end spawn tests to use the new event name and probe shape where they touch model resolution. Remove any leftover `role:resolve-model` references.

## 3. Documentation

- [x] 3.1 Update `README.md` "Frontmatter `model:`" section: replace the `role:resolve-model` example block with `model:resolve`, document the three accepted input forms (`@role`, `provider/model`, bare `model`), and the thinking suffix.
- [x] 3.2 Add a new README subsection "Implementing a `model:resolve` handler" with the probe contract, the cooperative `if (probe.model) return;` early-return idiom, and a 5–10 line worked example.
- [x] 3.3 Update the README's "Standalone behavior" / "Without the dashboard" note to reflect the new degradation matrix: dashboard present (full), pi-flows present + handler (full), neither (literal+bare-id only, `@role` fails).
- [x] 3.4 Update CHANGELOG `## [Unreleased]` with a BREAKING entry naming the event rename and the new bare-id form.

## 4. Validation

- [x] 4.1 Run `npm test` — all existing + new tests pass. (94/94 green)
- [x] 4.2 Run `npm run typecheck` — no new errors introduced by the resolver rewrite.
- [x] 4.3 Run `npm run lint` — no new errors (existing warnings unchanged: 0 errors, 47 warnings).
- [x] 4.4 Run `npm pack --dry-run` and confirm the packed file list is unchanged plus the new `model-resolve.test.ts` and `CHANGELOG.md` (added `CHANGELOG.md` + `LICENSE` to `files[]` while here).
- [x] 4.5 Run `openspec validate add-model-resolve-event-with-fallback` and confirm it still passes after any artifact tweaks during implementation.

## 5. Companion-change coordination (out-of-repo, tracked here for visibility)

> These are deferred to follow-up changes in their respective repos. They are
> out of scope for THIS implementation (which is purely subagent-side wiring).
> The proposal cross-link in §5.3 has been folded into the proposal.md Impact
> section already.

- [ ] 5.1 Open a corresponding change proposal in `pi-agent-dashboard` to rename `flow:resolve-model` → `model:resolve`, extend the handler with `@role` lookup against `providers.json`, thinking-suffix parse, and the bare-id "like" fallback. (Tracked, not implemented in this change.)
- [ ] 5.2 Open an optional change proposal in `pi-flows` for `role-manager.ts` to register a `model:resolve` handler so subagents resolve `@role` even when only pi-flows is loaded. (Tracked, not implemented in this change.)
- [x] 5.3 Note in the proposal cross-link section that until 5.1 lands, `@role` continues to fail in production — but with a strictly better error message than before this change. (Captured in proposal.md §Impact.)
