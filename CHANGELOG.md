# Changelog

All notable changes to this package are documented here. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versioning follows
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed — **BREAKING**

- **Renamed event** `role:resolve-model` → `model:resolve` for frontmatter
  model resolution. The old event had no in-workspace handler and was
  effectively dead, so the breakage is theoretical; nonetheless, any
  third-party extension that emitted or listened on the old name MUST
  update to the new name.
- **Widened probe shape.** The probe accepted by `model:resolve` is now
  `{ ref, resolved?, model?, thinkingLevel?, auth?, error?, available? }`
  (old: `{ ref, resolved?, available? }`). Old fields are preserved.
- The `model:` frontmatter field is now resolved in two phases: primary via
  the `model:resolve` event bus, and a fallback via `pi.modelRegistry` when
  no handler is registered. Resolution policy is documented in detail in
  `README.md#model-resolution-model`.

### Added

- **Per-call `model` parameter on the `Agent` tool.** The tool's parameter
  schema now accepts an optional `model` field that overrides any
  `.md` frontmatter `model:` value. Accepts the SAME three forms as
  frontmatter (`@role`, `provider/model-id[:thinking]`, bare `model-id`)
  and resolves through the SAME `resolveModelFromRef` mechanism
  (`model:resolve` event-bus primary path, `pi.modelRegistry` fallback).
  Precedence: `args.model > agentConfig.model > pi default`. Enables
  general-purpose subagent spawns to pick a specific model without
  authoring an `.md` file.
- **`selectEffectiveModelRef(argsModel, configModel)` helper** exported
  from `extensions/agent.ts` — implements the precedence rule for testability.
- **`Agent` tool description rewritten** to teach BOTH spawn modes:
  curated (when `subagent_type` matches an `.md`) and inline (any label
  works; pass `model` directly).
- **Bare `model-id` form** in frontmatter (no provider prefix, no `@`).
  Resolved via "like" query: first registry entry whose `m.id === ref`
  wins. Operators wanting deterministic resolution should use the explicit
  `provider/model-id` form.
- **In-process registry fallback.** When no `model:resolve` handler is
  registered, the extension resolves `provider/model-id` and bare `model-id`
  against `pi.modelRegistry` directly. `@role` still requires a handler.
- **Structured failure messages.** Resolution errors now distinguish "role
  unknown" vs "model unknown" vs "no resolver available", each with the
  agent `.md` path and an actionable next step.
- **`ModelResolveProbe` interface** exported from `extensions/agent.ts` for
  handler authors.
- **`CHANGELOG.md`** (this file) — was missing previously.

### Removed

- `role:resolve-model` event name — see Changed above.
