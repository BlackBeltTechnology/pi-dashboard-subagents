## Context

The subagent extension today does:

```ts
if (ref.startsWith("@")) {
  pi.events.emit("role:resolve-model", probe);     // ← no handler exists
  literal = probe.resolved;                         // ← always undefined
}
// then registry.find(provider, modelId) for the literal
```

Two unrelated facts in the workspace:

1. `pi-agent-dashboard/packages/extension/src/provider-register.ts:564` listens on `flow:resolve-model` with a probe shape `{ modelRef, model, auth }`. Nothing in any sibling package emits this event. The handler explicitly skips `@role` (line 569) deferring to pi-flows' in-process `getModelRole()`.
2. `pi-flows/extensions/role-manager.ts` reads `~/.pi/agent/providers.json` and exposes `getModelRole(role)` for in-process resolution. It is never wired to the event bus.

So:

- subagent's `@role` emit → orphan emitter
- dashboard's `flow:resolve-model` → orphan listener
- flows' `getModelRole` → in-process only

This change connects the orphans behind one consistent event name (`model:resolve`) and adds an in-process degraded-mode fallback so the subagent extension keeps working when no handler is registered.

## Goals / Non-Goals

**Goals:**

- One event name (`model:resolve`) that resolves any of three input forms (`@role`, `provider/model`, bare `model`) into a Model object.
- Subagent extension never fails the spawn just because no resolver extension is loaded — degrade gracefully via `pi.modelRegistry`.
- Frontmatter `model:` field accepts all three forms; existing files keep working unchanged.
- Clear, actionable error messages when resolution fails (distinguishes "role unknown" vs "model unknown" vs "no resolver available").

**Non-Goals:**

- Implementing the companion handlers in `pi-agent-dashboard` and `pi-flows`. Those are separate proposals in their own repos. This change does the **subagent-side** wiring (emitter + fallback) and documents the contract.
- Renaming or removing the dashboard's `flow:get-available-models` event — different problem space (UI model picker).
- Changing how pi-flows resolves its own model references in-process. pi-flows stays standalone.
- A second event for role-only resolution (`role:resolve`). One event handles everything; the handler internally does role lookup before model lookup.

## Decisions

### Decision 1: Single event `model:resolve` (vs split `role:resolve` + `model:resolve`)

Earlier exploration considered splitting into two events: `role:resolve` for `@role` → literal, then `model:resolve` for literal → Model. Rejected because:

- Every caller would emit two events for the common `@role` case — twice the bus traffic.
- Two handlers means two ordering rules, two failure modes, two probe shapes to keep in sync.
- The dashboard already owns `providers.json` access (RolesSettingsSection); adding role lookup to its model handler keeps the knowledge centralized.

The handler is responsible for the whole chain. Emitters give it a `ref` string and trust it.

### Decision 2: In-process fallback handles literal + bare-id only

When `pi.events.emit("model:resolve", probe)` returns with `probe.model` undefined AND no `probe.error` set, the subagent assumes no handler is registered (silent emit). It then attempts in-process resolution against `pi.modelRegistry`:

- `provider/model[:thinking]` → `registry.find(provider, id)`
- bare `model` → `registry.getAll().find(m => m.id === ref)` — first match wins

`@role` cannot be resolved without `providers.json` access, which we deliberately don't reach for in this extension (per spec: keep extension dependency-free). `@role` + no handler fails with a clear "install pi-agent-dashboard or pi-flows" message.

Alternative considered: also read `providers.json` directly from the subagent extension as a fallback. Rejected — spec for `subagent-role-aliasing` explicitly says "no dependency on providers.json from this extension." Keeps role storage policy owned by the dashboard/flows.

### Decision 3: Probe is filled but never replaced

Handlers MUST follow the early-return idiom:

```ts
pi.events.on("model:resolve", (probe) => {
  if (probe.model) return;        // someone else handled it
  // … attempt resolution …
  if (success) {
    probe.resolved = "provider/id";
    probe.model = m;
    probe.thinkingLevel = thk;
    probe.auth = a;
  } else {
    probe.error ??= reason;       // first error sticks
    probe.available ??= hint;
  }
});
```

This makes handlers cooperative: pi-flows can register one (for `@role` when dashboard is absent), the dashboard can register one (for everything), and order-of-load doesn't matter. First handler to set `probe.model` wins.

### Decision 4: Resolution order within the handler — @role → provider/model → like

Inside `model:resolve` the handler tries, in order:

1. If `ref.startsWith("@")`, look up `providers.json#roles[role]`. Hit → recurse with the literal. Miss → set `probe.error` + `probe.available.roles`, return.
2. Parse `:thinking` suffix off the end.
3. If contains `/`, split and call `registry.find(provider, id)`.
4. Otherwise (bare), call `registry.getAll().find(m => m.id === literal)`.
5. On miss, set `probe.error` + `probe.available.models` (top-N nearest by string distance).

The in-process fallback in the subagent extension uses the same order minus step 1.

### Decision 5: BREAKING rename is acceptable

The old event `role:resolve-model` has zero handlers anywhere in the workspace. Removing it can't break any production wiring because nothing was wired. The spec change is BREAKING formally (it renames a documented event), but operationally it's a no-op.

We do NOT keep a deprecated alias. The old name was wrong from day one and there's no benefit to perpetuating it.

### Decision 6: Probe shape is additive

Old: `{ ref, resolved, available }`. New: `{ ref, resolved, model, thinkingLevel, auth, error, available }`. Every new field is optional. Old handlers (none exist, but hypothetically) that only read `probe.resolved` keep working — they just don't get the Model object directly, which means callers fall through to in-process resolution. Acceptable.

### Decision 7: `auth` field is optional and ignored by subagents

The dashboard's existing handler fills `probe.auth = await registry.getApiKeyAndHeaders(model)`. Subagents don't need it — they reuse the parent session's auth via the Model object. We keep `auth` in the probe shape for the dashboard's own consumers (flow engine) and other future emitters (e.g., a CLI helper that wants the API key). The subagent extension ignores it.

## Risks / Trade-offs

- **[Risk]** A user updates pi-dashboard-subagents to this version but doesn't update pi-agent-dashboard. Their `@role` frontmatter still doesn't work. → Error message names the missing handler explicitly and tells them what to install. Same observable behavior as today (the old emit silently failed); strictly better diagnostics.

- **[Risk]** Two handlers register `model:resolve` (e.g., user has both pi-flows and pi-agent-dashboard). → Decision 3 mitigates: each handler's first line is `if (probe.model) return`. First-loaded wins. Documented in spec scenario.

- **[Risk]** Bare-id `model` collisions (same id under two providers, e.g., `claude-haiku-4-5` on both `anthropic` and `bedrock`). → "First registry hit wins" is documented. Users who care write `provider/model` explicitly. Bare form is for convenience, not for ambiguous setups.

- **[Trade-off]** In-process fallback duplicates two of the handler's three resolution branches (literal + bare). → Acceptable; ~15 lines of code, no role logic, keeps the extension usable without external dependencies. The duplication is the whole point — degraded mode.

- **[Risk]** Spec `subagent-role-aliasing` currently documents three scenarios assuming the old event. Modifying them risks losing test intent during the rewrite. → MODIFIED requirements in the delta spec copy the full block and update field-by-field; scenarios for new topologies (fallback, bare-id) are added as new sub-scenarios under their respective requirements.

## Migration Plan

No data migration. No runtime config migration. Users:

1. Upgrade `pi-dashboard-subagents` to a version containing this change.
2. Their existing `@role` frontmatter keeps failing **until** they also upgrade `pi-agent-dashboard` (or have `pi-flows` loaded with the optional `model:resolve` handler). Error message points at this.
3. Their existing `provider/model` frontmatter keeps working unchanged.
4. They CAN now write bare `model-id` in frontmatter, with caveat about provider ambiguity.

Rollback: revert the subagents-extension change; old code emits the orphan `role:resolve-model` event again. No on-disk state to roll back.

## Open Questions

1. **Top-N nearest models in `probe.available.models`** — what N? 10? 20? Whole list? Lean: 20, sorted by edit distance to `ref`. Defer to implementation; not spec-level.
2. **Should `parseAgentMd` validate the model string syntactically?** E.g., reject `model: "//bad"` at parse time vs at resolve time. Lean: no — resolver gives better error message because it has registry context. Frontmatter parser stays permissive.
3. **Cache `providers.json` reads in the dashboard handler?** Out of scope here; that's the dashboard's companion change to decide.
