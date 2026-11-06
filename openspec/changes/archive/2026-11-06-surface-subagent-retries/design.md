## Context

`runAgentTool` (`extensions/agent.ts`) builds the child with `createAgentSession`. The child loads its own `SettingsManager`, so it reads the user's `settings.retry`. pi's retry loop runs inside `session.prompt()`. A faux-provider spike against pi 1.4.0 recorded this child event order for one retryable error:

```
message_end{assistant, stopReason:"error"} → turn_end → agent_end{willRetry:true}
  → auto_retry_start{attempt:1, maxAttempts, delayMs, errorMessage}
  → [sleep delayMs, abortable]
  → message_start … message_end{stopReason:"stop"} → auto_retry_end{success:true, attempt:1}
  → turn_end → agent_end{willRetry:false}
```

For an exhausted budget, the sequence ends with `auto_retry_end{success:false, attempt:N, finalError}` after the last errored `message_end`. A provider error reaches the child only as `message_end` with `stopReason:"error"`. pi-agent-core emits no `message_update{error}`, so `mapSessionEventToEntry`'s `error` branch does not fire for it.

The subscribe closure currently ignores `auto_retry_*`. `session.abort()` already cancels a pending backoff (`abortRetry()`), so stop and abort need no new wiring.

## Goals / Non-Goals

**Goals:** observe and report pi's retries. This is purely additive on the producer side.

**Non-Goals:**
- Any retry policy of our own: classification, extra patterns, re-spawning.
- Overriding the child's `settings.retry`.
- Changing outcome semantics.
- How any consumer renders retries.

## Decisions

### D1. Map `auto_retry_start` → one `retry` entry; ignore `auto_retry_end` for the timeline
`auto_retry_start` carries everything the entry needs (attempt, budget, delay, error) at the moment the user starts waiting. `auto_retry_end{success:true}` adds nothing visible, because the next entries are the recovered output. `auto_retry_end{success:false}` is used only for the failure-text suffix (D4).
*Alternative:* an entry on both start and end. Rejected: it doubles entries and the end entry is redundant.

### D2. No separate `error` entry for retried attempts
The failed attempt's `message_end{error}` currently yields no entry (Context). The `retry` entry's `text` is the record of that error. Adding an `error` entry for every errored `message_end` is a separate, broader behavior change, and it would show retried attempts in red, which is the confusion this change removes.
*Consequence:* a final non-retried error still has no `error` entry, as today. The failure appears via `status` and `details.error`.

### D3. Activity during backoff, set from the event, cleared by normal activity
On `auto_retry_start`, set `activity = "retrying (attempt N/M) in <fmt(delayMs)>…"` and call `pushUpdate("running")`. This is the existing throttled progress path, and the flush on the next event is enough. No countdown timer; the text shows the scheduled delay, not the time remaining.
When the retried attempt begins, `activityFromEvent` already returns `thinking`, `writing` or `running <tool>`. A retried reply that emits none of those (non-streaming providers) keeps the retry text until the next activity or terminal snapshot. This is acceptable, and the terminal snapshot replaces it.
*Alternative:* a ticking countdown via `setInterval`. Rejected: it means timer lifecycle and dispose work across stop, abort and finally for a cosmetic gain.

### D4. `retries` = running sum of `auto_retry_start`; suffix decided by the last sequence
The closure keeps `retries` (incremented per `auto_retry_start`) and `lastRetrySequence: { attempts, success } | undefined`. On `auto_retry_start` it becomes `{attempts: attempt, success: undefined}`; on `auto_retry_end` it records `success`.
At outcome time, `finalReplyFailure` text gets ` (after 1 retry)` / ` (after N retries)` only when `lastRetrySequence.success === false`. That is the sequence that produced the final error, either because its budget ran out or because a retried attempt hit a non-retryable error; pi emits `auto_retry_end{success:false}` in both cases, and the producer cannot tell them apart without re-implementing pi's classifier, which is a non-goal. A recovered earlier sequence (`success:true`) never decorates a later unrelated failure. `retries` goes into `snapshotDetails` only when greater than 0, so the key is absent otherwise.
The aborted path (`endedByAbort`) is untouched; pi emits `auto_retry_end{finalError:"Retry cancelled"}` there, which we ignore.

### D5. Entry shape: `{ kind:"retry", attempt, maxAttempts, delayMs, text, ts }`
It uses `text` (not `error`) so `cutEntry`'s generic non-tool branch (`{...e, text: cutMiddle(e.text)}`) bounds it unchanged, and the numeric fields pass through. TypeScript narrowing in `cutEntry` and in the `message_end` backfill counter (`kind === "text" || "thinking"`) already treats `retry` as a "not text/thinking" boundary. That is correct: a retry entry ends a trailing run of text blocks, just as `tool` and `error` do.
*Alternative:* `error` as the field name. Rejected: it needs a special case in the bounds code.

### D6. A dedicated `subagents:retry` event alongside the entry
Listeners get retries on their own channel instead of filtering `subagents:entry` by kind: one `phase: "scheduled"` event per `auto_retry_start` (attempt, budget, delay, error, running total) and one `phase: "ended"` event per `auto_retry_end` (attempt, success, `finalError` on failure, running total). Both carry `v: 1`, `agentId` and the parent `toolCallId` like `subagents:entry`, and are never throttled. The `ended` phase is the only place a sequence's outcome is published; the timeline gets no entry for it (D1).
*Alternative:* the timeline entry only. Rejected: a listener would have to track every run's entries to notice a retry, and could not see a sequence end.
The CHANGELOG flags the new entry kind as a wire addition.

### D7. Retry tests live in their own faux file with fast per-test retry settings
The child reads `$PI_CODING_AGENT_DIR/settings.json`; with no `retry` block, pi's defaults apply (enabled, `baseDelayMs: 2000`). The existing "provider error mid-run" case in `entry-stream-faux.test.ts` already triggers one real 2 s retry (`"faux upstream 500"` is retryable; the retried call then hits the faux "No more faux responses queued" error). After this change it gains a `retry` entry and the ` (after 1 retry)` suffix, and its assertions are updated accordingly.
New retry cases go in `retry-faux.test.ts` with their own agent dir, writing `settings.json` per test: `{ retry: { enabled: true, maxRetries: 2, baseDelayMs: 10 } }` normally, and a long `baseDelayMs` for the stop-during-backoff case.

## Risks / Trade-offs

- **Consumers that switch exhaustively on `kind`** need a new case → documented as BREAKING (wire contract) in the CHANGELOG; `subagents:retry` lets listeners ignore the entry kind entirely.
- **pi renames or reshapes `auto_retry_*`** → the mapping reads fields defensively (missing numbers become `0`, a missing message becomes `"Unknown error"`). The faux e2e test pins the contract against the installed pi.
- **Background `AgentMessages` `kinds` filter** (`add-background-subagents`, in flight) enumerates kinds → note in that change that `retry` is a valid kind. There is no conflict, since that change is not implemented yet.
- **Very long backoffs** (`maxAgentDelayMs` can be minutes) still show a static "in 50m…" with no countdown → accepted (D3); the `retry` entry's `ts` plus `delayMs` lets a listener compute a countdown if it wants one.

## Migration Plan

This change is additive; there is no config migration. To roll it back, revert. Consumers ignoring `retries` and `retry` entries see the previous behavior.
