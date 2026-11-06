## Why

pi's own auto-retry already runs inside every subagent: the child `AgentSession` reads `settings.retry` and retries transient provider errors within `session.prompt()`. A faux-provider spike against pi 1.4.0 confirmed it (`503` / `Connection error.` → `auto_retry_start` → recovered → `completed`). This package hides all of it, so users conclude "subagents don't retry":

- **Backoff looks like a hang.** The child's `auto_retry_start` / `auto_retry_end` events are ignored. During a backoff (up to `maxAgentDelayMs`, which can be minutes) the run reports `running` with a stale activity line and nothing streams.
- **A failed attempt leaves no trace.** pi-agent-core reports a provider error only as `message_end` with `stopReason: "error"`, never as a `message_update` error event, so the existing `error` entry mapping never fires for it. The timeline jumps from the last good step straight to the retried attempt's output, and the error that cost the backoff is not shown anywhere.
- **There is no record.** A finished run's `details` and the parent JSONL do not say whether, or how often, a retry happened. So a run that failed after retries cannot be told apart from one that failed at once (e.g. a non-retryable `GoUsageLimitError`, or a `stream_disconnected` that pi's classifier does not match).

## What Changes

- The child's `auto_retry_start` / `auto_retry_end` events are observed. No retry logic is added; pi stays the only retry engine.
- **New timeline entry kind `retry`**: `{ kind: "retry", attempt, maxAttempts, delayMs, text, ts }`, where `text` holds the provider error that triggered the retry. It is appended once per `auto_retry_start` and streams on `subagents:entry` like every other step. It is the only timeline record of the failed attempt; no separate `error` entry is added for retried attempts.
- **Live activity while backing off**: `details.activity` becomes `retrying (attempt N/M) in <delay>…` when a backoff is scheduled, and returns to normal activity once the retried attempt starts streaming.
- **New `AgentDetails.retries?: number`**: total retry attempts so far in this run. Present only after the first retry. Carried on progress frames, terminal events and the bounded tool result, so it survives in the parent JSONL.
- **New event `subagents:retry`** on `pi.events`, for listeners that want retries without parsing the timeline: `phase: "scheduled"` when a backoff starts (`attempt`, `maxAttempts`, `delayMs`, `error`, running `retries`), and `phase: "ended"` when the sequence finishes (`attempt`, `success`, `finalError` on failure, `retries`).
- A run that fails after retrying reports that in `details.error` and the tool result, e.g. `… (after 3 retries)`.
- Outcome semantics are unchanged: the final assistant message still decides success or failure.
- **BREAKING (wire contract)**: `SubagentTimelineEntry` gains a fifth `kind`. Consumers that switch exhaustively on `kind` must add a case.

## Capabilities

### New Capabilities
- `subagent-retry-visibility`: how pi's child-session auto-retry shows up to consumers. Covers the `retry` timeline entry, the `subagents:retry` event, activity during backoff, the `retries` counter, and the failed-after-retries error text.

### Modified Capabilities
- `subagent-emission`: the `AgentDetails` timeline requirement's allowed entry kinds grow from `{tool, text, thinking, error}` to include `retry`.

## Impact

- **Code:**
  - `extensions/events.ts`: `SubagentTimelineEntry` union, `AgentDetails.retries`, mapping `auto_retry_start` to an entry, and the `subagents:retry` payload + emitter.
  - `extensions/agent.ts`: the subscribe handler, activity, snapshot fields, and failure text.
  - The result-bounds code cuts the new kind's `text` like any other non-tool entry; no change is expected.
- **Tests:** a faux-provider e2e (error → retry → recover; error → retries exhausted), plus unit tests for mapping and activity.
- **Docs:** README (entry kinds, `AgentDetails` field reference, outcome section), CHANGELOG, `extensions/AGENTS.md`.
- **Consumers:** the `add-background-subagents` change (`AgentMessages` `kinds` filter) must accept `retry`.
- **Out of scope:** adding retry patterns (e.g. `stream_disconnected`) belongs upstream in pi-ai's `isRetryableAssistantError`. Re-running a subagent after a final failure is also out of scope.
