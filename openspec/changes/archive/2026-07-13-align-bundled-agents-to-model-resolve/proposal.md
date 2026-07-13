## Why

The `add-model-resolve-event-with-fallback` change renamed the model-resolution
event `role:resolve-model` → `model:resolve` and widened the probe shape (handler
now fills `probe.model` with a Model object, not just `probe.resolved`). It updated
`subagent-role-aliasing` and `agent-md-frontmatter`, but left the `bundled-agents`
capability describing the removed `role:resolve-model` event and the old probe. The
main specs are now internally inconsistent: `bundled-agents` documents an event no
extension emits.

This is a spec-only alignment — the code, the bundled `Explore.md`, and the other
specs already use `model:resolve`. No behavior changes.

## What Changes

- Update the `bundled-agents` requirement "The bundled Explore agent SHALL use a
  role alias for its model" and its scenarios to reference the `model:resolve`
  event, the widened probe (`probe.model`), and the "install pi-agent-dashboard or
  pi-flows" degradation messaging — consistent with `subagent-role-aliasing`.
- Replace `probe.resolved` + `role:resolve-model` mentions with the new contract.
- Reframe "roles-plugin bridge" dependency as "a registered `model:resolve`
  handler (pi-agent-dashboard or pi-flows)".

## Capabilities

### New Capabilities

(none)

### Modified Capabilities

- `bundled-agents`: align the Explore role-alias requirement + 3 scenarios to the
  `model:resolve` event contract. Doc-only; no code or test impact.

## Impact

- **Code**: none.
- **Tests**: none.
- **Specs**: `openspec/specs/bundled-agents/spec.md` — one requirement + three
  scenarios rewritten to the new event name and probe shape.
