## 1. Red test first

- [x] 1.1 In `extensions/__tests__/agent.test.ts`, add a suite covering
  activation-handle isolation. Import the default export (`activate`) from
  `extensions/agent.ts`. Build two fake `ExtensionAPI` handles (`piA`, `piB`),
  each recording the tools registered via `registerTool` and the events emitted
  via its `emit`/event surface (reuse the existing fake-`pi` helper in this file
  if present; otherwise add a minimal one next to it).
- [x] 1.2 Assert: `activate(piA)`, then `activate(piB)`; the tool captured from
  `piA.registerTool` emits through `piA` (not `piB`) when its `execute` runs.
  This test MUST fail on the current code (the module-level `capturedPi` makes
  both tools emit through `piB`).
- [x] 1.3 Assert: after `activate(piA)` and `activate(piB)`, make `piB` throw the
  stale-ctx error from every method (simulating runtime invalidation by
  `AgentSession.dispose()`); invoking `piA`'s tool MUST NOT throw. Fails on
  current code.
- [x] 1.4 Run the two new tests and confirm both are RED before touching
  `agent.ts`.

## 2. Implementation

- [x] 2.1 In `extensions/agent.ts`, change `makeAgentTool(exposeIsolated)`
  (line 882) to `makeAgentTool(pi: ExtensionAPI, exposeIsolated: boolean)` and
  replace the `getPi()` argument in `execute` with the closed-over `pi`.
- [x] 2.2 In `activate(pi)`, call `pi.registerTool(makeAgentTool(pi, exposeIsolated))`
  (line 1319) and delete the `capturedPi = pi` assignment (line 1317).
- [x] 2.3 Delete `let capturedPi` (line 913), `getPi()`, and the
  "invoked before activate() captured pi handle" error string, plus the now-stale
  comment block above them ("pi handle captured at activate() time").
- [x] 2.4 Grep the package for any remaining reference to `capturedPi` / `getPi`
  (including tests) and update or remove it.

## 3. Verify

- [x] 3.1 Re-run 1.2 and 1.3 — both GREEN.
- [x] 3.2 Run the full suite (`npm test`); no regressions in `agent.test.ts`,
  `events.test.ts`, `inheritance-e2e.test.ts`, `model-resolve.test.ts`,
  `package-discovery.test.ts`, `settings.test.ts`.
- [x] 3.3 Fails-on-revert check: `git stash` the `agent.ts` change, confirm 1.2
  and 1.3 go RED again, restore.

## 4. Live acceptance (manual, in a real pi session)

- [x] 4.1 Reload/restart a pi session that loads this package. Run the `Agent`
  tool twice in a row with a trivial prompt.
- [x] 4.2 Confirm BOTH calls return a result and neither reports "This extension
  ctx is stale after session replacement or reload".
- [ ] 4.3 Confirm the dashboard subagent inspector still receives live progress
  frames for both runs (the emit path goes through the new closure handle).
- [x] 4.4 Run a third call that errors (unknown `subagent_type` with a bad
  `model`), then a fourth normal call — the fourth must still succeed.

## 5. Docs

- [x] 5.1 Update `extensions/AGENTS.md`'s `agent.ts` row: note the handle is
  bound per-activation via closure and that module-level `pi` is forbidden
  (re-activation by nested subagent sessions clobbers it).
- [x] 5.2 Add a CHANGELOG.md entry under `## [Unreleased]` — Fixed: second and
  subsequent `Agent` calls in a session failed with "extension ctx is stale".
