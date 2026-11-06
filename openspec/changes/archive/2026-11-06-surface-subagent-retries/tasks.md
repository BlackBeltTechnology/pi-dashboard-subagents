## 1. Wire types

- [x] 1.1 Add `{ kind: "retry"; attempt: number; maxAttempts: number; delayMs: number; text: string; ts: number }` to `SubagentTimelineEntry` in `extensions/events.ts`
- [x] 1.2 Add optional `retries?: number` to `AgentDetails` (doc comment: sum of scheduled retry attempts; absent until the first), and pass it through `buildDetails` only when set
- [x] 1.3 Add `retryEntryFromEvent(event)` in `events.ts`: map `auto_retry_start` to a `retry` entry with defensive defaults (missing numbers become `0`, missing message becomes `"Unknown error"`); return `null` for any other event
- [x] 1.4 Add `formatRetryDelay(ms)` (`950→1s`, `4000→4s`, `150000→2m 30s`, `3900000→1h 5m`) and unit-test its boundaries
- [x] 1.5 Make the build pass: fix any exhaustive switches or narrowings over `kind` (`cutEntry`, the backfill counter, renderers in tests)

## 2. Producer wiring (`extensions/agent.ts`)

- [x] 2.1 In the subscribe closure, on `auto_retry_start`: append the `retry` entry (through `appendEntry`, so `subagents:entry` fires), increment `retries`, set `lastRetrySequence = { attempts: attempt }`, and set activity to `retrying (attempt N/M) in <delay>…`
- [x] 2.2 On `auto_retry_end`: record `lastRetrySequence.success`; no entry
- [x] 2.3 Include `retries` in `snapshotDetails` only when `> 0`
- [x] 2.4 Append ` (after 1 retry)` / ` (after N retries)` to the failure text when the final reply errored and `lastRetrySequence.success === false`; leave the aborted and stopped paths untouched

## 3. Tests

- [x] 3.1 Unit tests (`events.test.ts`): `retryEntryFromEvent` mapping, defaults, and `null` for other events
- [x] 3.2 Unit test (`agent.test.ts`, fake session): an `auto_retry_start` event updates activity and pushes a progress update
- [x] 3.2a Create `extensions/__tests__/retry-faux.test.ts` with its own agent dir and a helper that writes `settings.json` `retry` per test (`maxRetries: 2`, `baseDelayMs: 10`; long delay for 3.7)
- [x] 3.3 Faux e2e: retryable error, then success. Assert one `retry` entry in order, `subagents:entry` fired for it, `retries: 1`, `status: "completed"`
- [x] 3.4 Faux e2e: retries exhausted (`maxRetries: 2`). Assert two `retry` entries, `retries: 2`, `error` ends with `(after 2 retries)`, `subagents:failed`
- [x] 3.5 Faux e2e: an early recovered retry followed by a final non-retryable error. Assert no suffix and `retries: 1`
- [x] 3.5a Faux e2e: retryable `503`, then the retried attempt fails non-retryably with `400 bad request`. Assert error `"400 bad request (after 1 retry)"` and `retries: 1`
- [x] 3.6 Faux e2e: non-retryable error only. Assert no `retry` entry and no `retries` key
- [x] 3.7 Faux e2e: stop during backoff. Assert `stopped`, no further `retry` entry, and the run ends promptly (well before `delayMs`)
- [x] 3.8 Bounds test: a long `retry.text` is cut to `entryFieldMaxChars`, and the numeric fields are kept
- [x] 3.8a Update `entry-stream-faux.test.ts` "provider error mid-run": it already does one real retry (pi defaults). Expect kinds `text,tool,retry,…`, `retries: 1`, and error ending ` (after 1 retry)`
- [x] 3.9 Run `npm test`, typecheck and lint

## 4. Docs

- [x] 4.1 README: add `retry` to the `SubagentTimelineEntry` kinds block, `retries?` to the `AgentDetails` field reference, and a sentence in "Outcome and Stop" saying pi's `settings.retry` applies to subagents and how retries are surfaced
- [x] 4.2 CHANGELOG: an "Added" entry, plus a **BREAKING (wire contract)** note about the new entry kind
- [x] 4.3 `extensions/AGENTS.md`: record the new mapping and fields

## 5. Cross-change follow-ups

- [x] 5.1 Note in `add-background-subagents` (design or spec) that `AgentMessages` `kinds` accepts `retry`
- [x] 5.2 Emit `subagents:retry` (`phase: "scheduled" | "ended"`) from the subscribe closure; export `SubagentRetryEvent` and `emitSubagentRetry`, add it to `SUBAGENT_CHANNELS` / `SubagentEventMap`; assert both phases in `agent.test.ts` and `retry-faux.test.ts`
