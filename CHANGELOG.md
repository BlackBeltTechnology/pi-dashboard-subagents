# Changelog

All notable changes to this package are documented here. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versioning follows
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed

- **Release workflow publishes GitHub releases** instead of leaving drafts
  (`draft: false`, `make_latest: legacy`), so GitHub's "Latest" tracks npm.
- **CHANGELOG backfilled and re-attributed.** Added 0.2.0 to 0.2.2 sections;
  entries that shipped in 0.2.1 / 0.2.2 but were filed under 0.2.3 moved to
  their real versions.

## [0.5.0] - 2026-10-16

### Fixed

- **An errored or empty final reply fails the call.** The outcome now comes
  from the subagent's final assistant message. A final reply with
  `stopReason: "error"` (after pi's retries) or `"aborted"`, or with no text,
  returns `isError: true` and emits `subagents:failed`. Before, the run ended
  `completed` with an earlier turn's text or `"(no output)"` as its result.
  **Behavior change:** callers relying on that false success now get a failure.
- **Stop during setup stops the run.** Parent abort is checked after the spawn
  slot is granted, after the child loader reloads, and after the session is
  created. Before, a Stop pressed during construction was missed and the
  subagent ran to completion (spending tokens and running tools) before its
  result was discarded.
- **Parent settlement hooks no longer run in children.** Child loaders drop
  every extension's `turn_end`, `agent_end`, `agent_before_settle` and
  `agent_settled` handlers (`extensionsOverride`), so parent-scoped hooks can
  no longer delay or extend a subagent. Tools and other hooks are unchanged.

### Added

- **Size-bounded tool result.** The tool result pi saves to the parent session
  (and the terminal `onUpdate`) is capped: settings `resultMaxChars` (16000),
  `detailsMaxChars` (20000), `entryFieldMaxChars` (2000); `0` = unlimited.
  Head and tail are kept around a marker; `details.entriesOmitted` is additive.
  `subagents:*` bus events still carry the full payloads.

## [0.4.1] - 2026-10-14

### Fixed

- **Subagents inherit the parent's live model.** An `Agent` call with no
  `model` argument and no agent-`.md` `model:` now runs on the parent's
  current model (`ctx.model`) instead of the settings `defaultModel`.
  Precedence: tool-call `model` > frontmatter `model:` > parent live model >
  SDK default.

## [0.4.0] - 2026-10-09

### Added

- **Block delta stream.** New `subagents:delta` channel streams the thinking /
  text block in progress as exact, append-only pieces:
  `{ v: 1, agentId, toolCallId, blockId, kind, offset, text, final }`
  (`SubagentDeltaEvent`, `emitSubagentDelta`). `blockId` counts blocks per run
  from 0; `offset` is block-relative (UTF-16 code units). Batched to ≤ 4
  pieces/s/subagent, never coalesced away; flushed at block end, next block
  start, message end and every terminal path. Each block gets exactly one
  `final: true` piece, emitted before its `subagents:entry`.
- **`blockId` on `subagents:entry`.** Steps that finish a streamed block carry
  the block's id (optional, additive); tool, error and `message_end` backfill
  steps omit it. Progress ticks and `details.liveTail` are unchanged.

## [0.3.0] - 2026-10-07

### Added

- **Live reasoning tail.** `details.liveTail = { kind: "thinking" | "text", text }`
  carries the last ≤ 280 chars of the block currently streaming, fed by
  `thinking_delta` / `text_delta`. Present on every snapshot (terminal too);
  `{ kind: "none", text: "" }` when nothing streams. Rides the existing
  250 ms tick throttle. Older dashboards ignore it.
- **Thinking level on details.** `details.thinkingLevel` reports the child
  session's effective level (`session.thinkingLevel`, falling back to the
  requested level) so the dashboard can show it next to the model.
- **Per-step entry stream.** Each timeline step is emitted ONCE on the new
  `subagents:entry` channel, the moment it is appended:
  `{ v: 1, agentId, toolCallId, index, entry }` (`SubagentEntryEvent`).
  `index` is the stable 0-based position; `toolCallId` is the parent `Agent`
  tool call id (`""` when unknown). Never throttled.
- **`details.entryCount`** = `entries.length` on every snapshot.

### Changed

- **BREAKING (wire): progress ticks no longer carry the timeline.** Progress
  frames on `subagents:started` omit the `entries` key (absent, not `[]`);
  listeners rebuild the live timeline from `subagents:entry`. Before, every
  tick resent the whole growing list, so a long run cost O(steps²) in
  transport and storage. `subagents:created`, the initial `subagents:started`,
  `subagents:completed`, `subagents:failed`, the tool's `onUpdate` and the
  final tool result still carry the full `entries[]`.

### Fixed

- **Activity no longer flickers between steps.** `tool_execution_end` keeps
  the last activity instead of clearing it.

## [0.2.6] - 2026-10-07

### Fixed

- **Subagents honor the requested thinking level.** A `:off` suffix on a
  model ref or role is now passed to the subagent instead of being dropped
  (it previously fell back to `defaultThinkingLevel`, usually `medium`).
- **Subagents inherit the parent's live thinking level.** When the model ref
  has no suffix, the child uses the parent session's current level (e.g. an
  unsaved `/thinking low`) instead of the settings default. Precedence:
  suffix > parent live level > pi per-model setting > `defaultThinkingLevel`.
  pi 1.x's `max` level is accepted as a suffix (`provider/model:max`).
  Note: the parent level now wins over a per-model thinking setting, and
  subagent cost/latency follows the parent's level.
- **Custom-provider auth works in subagents again on pi >=0.80.8.** The child
  session now inherits the parent's live `modelRuntime`; the removed
  `modelRegistry`/`authStorage` options were silently ignored, so children
  built a disk-only runtime and failed with "No API key found".

### Changed

- **pi 1.x support.** Peer range for `@earendil-works/pi-ai`,
  `pi-coding-agent`, `pi-tui` is now `>=0.80.8 <2`; developed and tested
  against pi 1.0.4. **BREAKING:** pi <0.80.8 is no longer supported (stay on
  0.2.5).
- **Docs.** README documents thinking-level precedence, custom-provider
  runtime inheritance and the supported pi range; removed the frontmatter
  `thinking:` example, which was never implemented (use a `:level` suffix).

## [0.2.5] - 2026-09-16

### Fixed

- **Parent session no longer stalls on a wide `Agent` fan-out.** Two runtime
  costs were unbounded: every child session built a full
  `DefaultResourceLoader` (all extensions *and* skills/prompt templates/themes)
  inside the parent's event loop, and the tool's `onUpdate` callback fired on
  **every** child session event (text deltas included), each time building a
  full details snapshot. Children now get a lean per-spawn loader
  (`noSkills`/`noPromptTemplates`/`noThemes`; tool surface unchanged, ~350 MB
  less RSS at 7-way fan-out), and `onUpdate` is coalesced through the same
  250 ms window as the dashboard progress leg (≤ 4/s per child). Terminal
  states (`completed`, `error`, `aborted`) always flush synchronously.

### Added

- **`maxConcurrent` setting** (default `4`, `0` = unlimited) in
  `~/.pi/agent/extensions/pi-dashboard-subagents/config.json`. A process-wide
  FIFO semaphore bounds how many subagents run at once; excess spawns show a
  `queued` card until a slot frees, and a parent abort while queued resolves as
  `aborted` without ever spawning a session. The value is re-read per spawn, so
  retuning it needs no `/reload`.
- **Real-runtime fan-out regression test** (`npm run test:fanout-memory`, also
  run by CI on push). Spawns 20 child sessions in two capped batches against
  pi-ai's faux provider — real per-child `DefaultResourceLoader`, real
  `createAgentSession`, real streamed events, only the model boundary faked.
  Asserts the tool allowlist the provider actually receives matches the agent
  `.md` frontmatter (seeded-random non-empty subsets), that every child reaches
  `completed` with the response queue drained, and that retained heap stays
  bounded across batches under forced GC (measured: ~104 KB second-batch
  growth over 20 sessions). Self-skips under plain `npm test`, which cannot
  expose a GC handle to the Vitest worker.

## [0.2.4] - 2026-08-10

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

## [0.2.2] - 2026-06-05

### Changed

- **Release workflow hardening** (`.github/workflows/release.yml`). The
  `publish` job no longer re-stamps the version with
  `npm version --allow-same-version`; it now verifies that `package.json`
  matches the resolved tag and fails loud on drift. `prepare` is the single
  source of truth for versioning. Prevents silently publishing a tarball
  whose version was never bumped.

## [0.2.1] - 2026-06-05

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

- **`CHANGELOG.md`** (this file).

### Removed

- **Bundled `agents/Explore.md`.** Moved out of this package; the dashboard
  now ships its Explore agent as a project-level agent.
- `role:resolve-model` event name — see Changed above.

## [0.2.0] - 2026-05-28

### Added

- **`Agent` tool** spawning foreground subagents in memory
  (`SessionManager.inMemory(cwd)`): no session file, no child process. The
  `Agent` tool is removed from the child, so subagents cannot nest.
- **Live timeline on the event bus.** `subagents:created` / `started` /
  `completed` / `failed` carry `AgentDetails` with a `tool` / `text` /
  `thinking` / `error` timeline for the dashboard inspector. Progress is
  throttled to about 4 emissions per second and flushed before terminal
  events. The tool result embeds the full timeline, so `/resume` re-hydrates
  the inspector without re-running.
- **Context inheritance** by verbatim compaction of the parent branch (no
  extra LLM call). Settings in
  `~/.pi/agent/extensions/pi-dashboard-subagents/config.json`
  (`inheritContext`, `exposeInheritanceInTool`, `inheritance.*`).
- **Agent `.md` frontmatter** (`model`, `tools`, `prompt`, `inherit_context`,
  `description`; body as prompt) with project → user → bundled resolution,
  and a bundled read-only `Explore` agent on the `@fast` role.
- Published as `@blackbelt-technology/pi-dashboard-subagents`.

### Fixed

- **Assistant text backfilled from `message_end`** for providers that never
  emit streaming `text_end` / `thinking_end` events, which previously produced
  `"(no output)"`.
