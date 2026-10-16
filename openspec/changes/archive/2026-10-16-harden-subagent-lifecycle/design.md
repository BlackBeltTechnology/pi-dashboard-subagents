## Context

`runAgentTool` (`extensions/agent.ts`) creates an in-memory child session, subscribes to its events, awaits `session.prompt()`, and maps the outcome to a tool result. These fixes come from a downstream fork, re-derived against v0.4.1 and pi 1.0.4. The fork's commit itself is not available, so they are re-implemented rather than cherry-picked.

Facts from pi 1.0.4 that this design relies on:
- `AgentSession.abort()` sets abort state only while a run is active; otherwise `agent.abort()` is a no-op. A later `prompt()` starts a fresh run.
- `prompt()` resolves normally when the last assistant message has `stopReason: "error"` (after pi's own auto-retries are exhausted).
- `agent_end`, `agent_before_settle` and `agent_settled` extension handlers are awaited inside `prompt()`. `turn_end` is a boundary that may continue the run.
- `DefaultResourceLoader` accepts `extensionsOverride(base) => LoadExtensionsResult`. Each `Extension` exposes `handlers: Map<string, HandlerFn[]>`. Each child has its own loader, so its `Extension` objects are not shared with the parent.
- pi persists custom tool results (`content` + `details`) to the session JSONL unmodified.
- `httpIdleTimeoutMs` (default 300 000) bounds stalled provider HTTP streams, so no inactivity watchdog is needed.

## Goals / Non-Goals

**Goals:** a correct success/failure outcome, Stop that takes effect at any point, children isolated from parent settlement hooks, and a bounded persisted result.

**Non-Goals:**
- An inactivity watchdog.
- A session-depth marker.
- Changing `subagents:*` bus payloads.
- Changing `liveTail` or delta streaming.

## Decisions

### 1. The final assistant message decides the outcome
Track `lastAssistant` (role, `stopReason`, `errorMessage`, text) in the existing `message_end` branch of the subscription, overwriting it on each assistant message. After `prompt()` resolves:

- If the signal aborted, keep the existing aborted path.
- If `lastAssistant.stopReason === "error"`, fail with `errorMessage ?? "subagent's final reply errored"`.
- If `lastAssistant.stopReason === "aborted"` (aborted without a parent Stop), fail with `errorMessage ?? "subagent run was aborted"`.
- If the final assistant message has no non-empty text, fail with `"subagent produced no final output"`.
- Otherwise, the result is that message's text: all its text blocks, joined.

`lastAssistantText(entries)` stops being the source of the result.

Because pi retries before `prompt()` returns, only the final message counts. A retried transient error that later succeeds stays a success.

*Alternative rejected:* scanning `entries` for `kind: "error"`. Error entries can come from intermediate turns that recovered.

### 2. Abort checkpoints around construction
Add one `throwIfAborted()` helper, called at three points:
- after `acquireSpawnSlot`,
- after `createChildLoader` (which includes `reload()`),
- after `createAgentSession` returns.

Each throws the existing `SpawnAbortedError`. The outer `catch` maps `SpawnAbortedError` to the same `aborted` details and `errorResult` as the queued-abort path, so there is one code path for aborts. `finally` already disposes `session` when it is set, so a session created just before the abort is cleaned up.

*Alternative rejected:* racing `createAgentSession` against the signal. That leaks a session that resolves after the race.

### 3. Strip settlement handlers in the child loader
```ts
const CHILD_STRIPPED_EVENTS = ["turn_end", "agent_end", "agent_before_settle", "agent_settled"];
extensionsOverride: (base) => {
  for (const ext of base.extensions) for (const ev of CHILD_STRIPPED_EVENTS) ext.handlers.delete(ev);
  return base;
}
```
`message_end` is **kept**. Unlike the fork, we don't strip it: handlers there may rewrite or redact a message (pi enforces that the role is unchanged), and stripping them would change the child's content. Tool, provider, input and session-start hooks are untouched, so extension-provided tools still work.

*Risk:* an extension that relies on `agent_end` inside children (e.g. per-run telemetry) loses it. This is accepted: children are internal runs of the parent tool call, and the parent's own `agent_end` still fires.

### 4. Bound only what pi persists
Add a pure function `boundToolResult(text, details, limits) → { text, details }`, applied to:
- the returned `AgentToolResult` (success and every `errorResult` after spawn),
- the terminal `pushTerminalUpdate`.

`subagents:completed` / `subagents:failed` / `subagents:entry` keep full payloads. They go to live listeners, not the JSONL. The `completed` event's `result` string stays full as well.

Algorithm:
1. If `text` exceeds `resultMaxChars`, keep the head and tail, and insert `\n[… N chars truncated …]\n` between them.
2. Each entry string field (`text`, `output`, stringified `input`) over `entryFieldMaxChars` is cut the same way.
3. If the serialized `entries` exceeds `detailsMaxChars`, keep entries from the head and the tail alternately until the budget is reached, and insert one marker entry `{ kind: "error", text: "[N timeline entries omitted]", ts }` at the gap. Set `details.entriesOmitted = N`, and keep `entryCount` as the original count.
4. Metadata fields (status, tokens, ids) are never truncated.

The marker reuses kind `error`, so the dashboard renders it without code changes. `entriesOmitted` is additive.

Settings (`config.json`, re-read per spawn, `0` = unlimited):
| key | default |
|---|---|
| `resultMaxChars` | 16000 |
| `detailsMaxChars` | 20000 |
| `entryFieldMaxChars` | 2000 |

## Risks / Trade-offs

- **[A replayed session shows a shortened timeline.]** → Head and tail are kept, plus an explicit marker. The live view is still full. Users who need everything set `0`.
- **[An empty final reply now fails.]** → An agent that intentionally ends with only a tool action was already shown as "(no output)". The change is documented in the CHANGELOG as a behavior fix.
- **[Mutating `ext.handlers` in the child loader.]** → Safe because each child has its own loader (spawn-cost Decision 1). A test asserts the parent's handlers are unaffected.
- **[The entry-stream tests assert terminal `entries` equal the rebuilt stream.]** → They hold under the defaults for the small faux runs. A dedicated test covers a run that exceeds the limits.
