# Changelog

All notable changes to this package are documented here. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versioning follows
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed

- **Second and subsequent `Agent` calls in a session failed** with "This
  extension ctx is stale after session replacement or reload". The `pi` handle
  was held in module-level state, so a nested subagent session re-activating the
  same module instance clobbered the parent's handle — which its own
  `session.dispose()` then invalidated. The handle is now bound per-activation
  via lexical closure (`makeAgentTool(pi, exposeIsolated)`).

## [0.2.3] - 2026-07-13

### Fixed

- **Subagent cross-provider spawn now inherits the parent model registry.**
  `createAgentSession` receives the parent session's live `ModelRegistry`
  (and its `authStorage`), so a subagent spawned on a **custom-provider**
  model (an `openai/`, `google/`, `deepseek/`, … id registered via
  `~/.pi/agent/providers.json`) no longer builds a fresh disk registry that
  lacks the provider. Previously such spawns failed at request time with
  `No API key found for <provider>` and surfaced as **empty output** — which
  callers (e.g. the doubt-driven-review cross-model probe) misread as "model
  unavailable" and escalated away from internal models. Matches the flows
  spawn path. Change: inherit-parent-model-registry.

### Added

- **Package agent-discovery tier.** The `Agent` tool now resolves agent `.md`
  files across **four** tiers: project → user → bundled → **package**. Any
  installed pi package that ships `agents/<name>.md` (and includes `agents/` in
  its `files[]`) contributes `<name>` as a spawnable agent — no manual copying
  into `.pi/agents/` required. The package tier ranks last, so nothing that
  resolves today can be shadowed. Discovery is **user-scope only** (packages
  installed into `~/.pi/agent`); project-scoped packages are never indexed, so
  an untrusted checkout cannot register spawnable agents. Cross-package name
  collisions resolve deterministically (smaller `source` string wins) with a
  stderr warning naming both. Discovery is lazy + cached, rebuilding on
  `/reload` or a working-directory change. Package-sourced agents carry
  `source: "package"` plus the originating package string (`agentMdPkg`) into
  `AgentDetails` so the dashboard card can render "reviewer (package:
  @acme/pi-reviewers)".

### Changed

- **Release workflow hardening** (`.github/workflows/release.yml`). The
  `publish` job no longer re-stamps the version with
  `npm version --allow-same-version`; it now verifies that `package.json`
  matches the resolved tag and fails loud on drift. `prepare` is the single
  source of truth for versioning. Prevents silently publishing a tarball
  whose version was never bumped.

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
