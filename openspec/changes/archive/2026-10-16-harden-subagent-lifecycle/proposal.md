## Why

A downstream fork hardened the `Agent` tool's lifecycle. Checked against v0.4.1 and pi 1.0.4, four of its fixes address real defects in this repo:

- **A subagent whose final reply errored still reports success.** In the existing faux test `provider error mid-run`, the last reply fails with an upstream 500, yet the run ends `status=completed` with an earlier turn's text as its result. The test never asserts the status. The current spec already says such a run SHALL fail.
- **Stop pressed during setup does not stop the run.** Parent abort is wired only after `createAgentSession`. pi's `session.abort()` does nothing when no run is active, so the following `prompt()` runs to the end, spending tokens and running tools, before its result is discarded as `aborted`.
- **The parent's settlement hooks run inside every child.** `createChildLoader` loads every extension unfiltered, and pi awaits `turn_end`, `agent_end`, `agent_before_settle` and `agent_settled` handlers before `prompt()` returns. A parent-scoped hook (e.g. a memory summary) delays the subagent or keeps it running.
- **The tool result has no size limit.** The final text and the full `details.entries` go to the parent's session JSONL and `tool_execution_update`. pi truncates only its built-in tools' output.

Two fork changes are deliberately left out:
- **Inactivity watchdog.** pi already fails a stalled provider stream through `httpIdleTimeoutMs` (default 5 min, applied to child requests).
- **Session-depth marker.** Nothing in this repo reads it, and children cannot nest because `Agent` is stripped from them.

## What Changes

- The run's outcome comes from the **final assistant message**. A final reply with `stopReason: "error"` makes the call fail, with `subagents:failed` and `isError: true`. A final reply that is empty also fails. Earlier turns' text never becomes the result.
- Parent abort is checked **before the loader is built, after `reload()`, and after `createAgentSession`**. An abort at any of these points returns the existing `aborted` result without calling `prompt()`, and disposes any half-built session.
- Child loaders drop the handlers for the settlement events `turn_end`, `agent_end`, `agent_before_settle` and `agent_settled`, using pi's `extensionsOverride`. Tool, message and provider hooks are untouched.
- The **tool result returned to pi** (and the terminal `onUpdate`) is size-bounded. Defaults: `content` text ≤ 16 000 chars, each entry's long string fields ≤ 2 000 chars, serialized `details.entries` ≤ 20 000 chars. Entries are kept head and tail, with one marker entry where steps were dropped. Limits are configurable in `config.json`, and `0` disables a limit.
- `subagents:*` bus events keep their current full payloads, so the live dashboard timeline is unchanged.

**BREAKING (behavioral):** callers that relied on an errored or empty final turn returning `completed` now get a failed tool result. This is a bug fix, released as a minor version.

## Capabilities

### New Capabilities
- `subagent-result-bounds`: size limits on the persisted tool result and terminal `onUpdate` (caps, head/tail entry retention, marker, config keys).

### Modified Capabilities
- `subagent-emission`: the completion/failure rule is decided by the final assistant message, and the "full `details.entries`" guarantee is narrowed to bus events.
- `subagent-spawn-cost`: the child loader also drops settlement-event handlers, and parent abort is honored across loader and session construction.

## Impact

- **Code:**
  - `extensions/agent.ts`: `runAgentTool` outcome logic, abort checkpoints, `createChildLoader` override, result bounding.
  - `extensions/settings.ts`: new limit keys.
  - `extensions/events.ts`: a marker-entry shape, if a new kind is needed.
- **Tests:**
  - Tighten `entry-stream-faux.test.ts` (provider error → `error`).
  - New tests: abort-during-setup, hook stripping, bounds.
- **Docs:** README (settings, failure semantics), CHANGELOG, `extensions/AGENTS.md`.
- **Consumers:** dashboard inspectors replaying a session from JSONL see a bounded timeline with a marker. The live view is unaffected.

## Discipline Skills

- `doubt-driven-review`: changed failure semantics and a bounded persisted payload are cross-boundary contracts with the dashboard.
- `performance-optimization`: payload byte budget on the parent JSONL.
- `systematic-debugging`: if the abort or hook paths misbehave under the faux provider.
