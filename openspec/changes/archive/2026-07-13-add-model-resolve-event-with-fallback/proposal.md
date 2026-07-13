## Why

The current subagent spec promises a `role:resolve-model` event for `@role` aliasing, but no handler exists in any sibling package (`grep -rn role:resolve-model` in `pi-agent-dashboard/` returns zero hits). The dashboard *does* have a sibling event `flow:resolve-model` that solves an almost-identical problem (literal `provider/model` → `Model` object + auth), but it's mis-namespaced (`flow:` for a non-flow-specific concern), it explicitly skips `@role` strings (delegating to in-process `pi-flows`), and it has no in-workspace emitters — i.e. it's an orphan listener.

The net effect today: subagents with `model: "@fast"` in frontmatter **always fail**, even though the spec says they should work. And anyone wanting to resolve a model reference from a third extension has to choose between mis-namespaced `flow:resolve-model` (which won't handle `@role`) or invent their own.

We unify both into a single, properly namespaced `model:resolve` event that handles all three input forms (`@role`, `provider/model`, bare `model`), with an in-process fallback so subagents still degrade gracefully when neither the dashboard nor pi-flows is loaded.

## What Changes

- **BREAKING** Rename emitted event in `pi-dashboard-subagents` from `role:resolve-model` → `model:resolve`. The old event had no listeners, so the breakage is theoretical, but it's still a rename in our published API.
- **BREAKING** Widen the probe shape: `{ ref, resolved?, model?, thinkingLevel?, auth?, error?, available? }`. Old shape `{ ref, resolved, available }` is a subset, so handlers reading only the old fields still work; emitters that set extra fields will be ignored by old handlers (there are none).
- Frontmatter `model:` field accepts three forms transparently:
  1. `@role` (existing) — resolved via event-bus handler.
  2. `provider/model[:thinking]` (existing) — resolved via registry directly or via event.
  3. Bare `model` (new) — "like" query against `pi.modelRegistry.getAll()` looking for first `m.id === ref`. Tried only after the `provider/model` and `@role` paths miss.
- In-process fallback (always available, no extension required):
  - Handles `provider/model` via `pi.modelRegistry.find()`.
  - Handles bare `model` via the "like" query.
  - Does **not** handle `@role` — fails cleanly with a "install pi-agent-dashboard or pi-flows" hint.
- Companion changes (separate proposals, not part of this change):
  - `pi-agent-dashboard`: rename `flow:resolve-model` → `model:resolve`, extend handler to cover `@role` (reading `~/.pi/agent/providers.json`), thinking suffix parse, bare-id "like" fallback. Drop `@role` early-return.
  - `pi-flows` (optional but recommended): `role-manager.ts` also registers `model:resolve` so subagents can resolve `@role` standalone with pi-flows even when the dashboard isn't loaded.

## Capabilities

### New Capabilities

(none — this change modifies existing capabilities only)

### Modified Capabilities

- `subagent-role-aliasing`: rename event, widen probe, add bare-id form, add in-process fallback, restructure scenarios to cover the three resolver topologies (dashboard present / pi-flows-only with optional handler / neither).
- `agent-md-frontmatter`: add bare-id form as a valid value for `model:` field, update the "thinking suffix" scenario to make explicit that the suffix is parsed before any lookup (whether event or fallback).

## Impact

- **Code**: `extensions/agent.ts::resolveModelFromRef` is rewritten to follow the primary-then-fallback algorithm; type for the model registry access stays the same (small typed shim). No other files in this repo change.
- **Tests**: `extensions/__tests__/agent.test.ts` gains scenarios for each input form, each topology (event-handler present, event-handler absent), and failure paths (unknown role, unknown model, dashboard absent + `@role`).
- **README**: documents the `model:resolve` event contract (probe shape, handler responsibility) and the three input forms accepted in frontmatter `model:`.
- **Downstream**: pi-agent-dashboard and pi-flows each need a companion change to register the new handler. Until those land, subagents using `@role` continue to fail (status quo); subagents using literal `provider/model` continue to work (status quo); subagents using bare `model` start working (improvement) thanks to the in-process fallback.
- **No new runtime dependencies.** No new files. No new exports.
