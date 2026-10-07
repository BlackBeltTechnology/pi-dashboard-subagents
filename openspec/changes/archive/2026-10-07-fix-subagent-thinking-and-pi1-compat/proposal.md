## Why

On pi 1.0.x, subagents ignore the requested thinking level. A `:off` suffix on a model ref or role is dropped, and since pi 0.84.3 made `/thinking` session-scoped, the parent's live level never reaches the child. Every subagent therefore runs at `defaultThinkingLevel` from `settings.json`. Separately, pi 0.80.8 removed the `modelRegistry`/`authStorage` options of `createAgentSession`. The extension still passes them, pi silently ignores them, and the child builds a fresh disk-only model runtime, which undoes the custom-provider inheritance fix. The peer range `^0.75.5` also excludes pi 1.x.

## What Changes

- Pass every parsed thinking-level suffix to the subagent session, including `off`.
- When the model ref has no suffix, use the parent session's current thinking level instead of the settings default.
- Inherit the parent's live model runtime through the current SDK option (`modelRuntime`) instead of the removed `modelRegistry`/`authStorage` options, so providers registered at runtime resolve in subagents again.
- Widen the peer dependency range (`pi-ai`, `pi-coding-agent`, `pi-tui`) to include pi 1.x.
- Add a CHANGELOG entry and release as 0.2.6.

## Capabilities

### New Capabilities
- `subagent-thinking-level`: how the thinking level of a spawned subagent is chosen (explicit suffix, then parent live level, then pi defaults).

### Modified Capabilities
- `subagent-model-registry-inheritance`: inheritance moves from the removed `modelRegistry`/`authStorage` options to the parent's live model runtime. The custom-provider guarantee stays the same.

## Impact

- `extensions/agent.ts`: `runAgentTool`, the `createAgentSession` call (~L1225-1236).
- `extensions/__tests__/`: new and updated tests for thinking-level and runtime inheritance.
- `package.json`: peer and dev dependency ranges, version 0.2.6.
- `CHANGELOG.md`, `extensions/AGENTS.md` row for `agent.ts`.
- Downstream: pi-agent-dashboard picks the fix up by bumping its dependency. No wire-contract change.

## Discipline Skills

- `systematic-debugging`: root-cause evidence already collected (sdk.js thinking fallback chain, removed options in 0.80.8).
- `review-code`: before commit.
- None of security/perf/observability apply.
