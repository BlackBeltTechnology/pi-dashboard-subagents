# Design

## Context

See proposal.md, Why. Current state:

- `background.ts`: the registry holds per-record `status`, `run`, `result` (per run, `finishedRun`), `readAt` (reset on each `finish`), `latest` (tokens, turnCount, activity), `entries` (timeline incl. `text`), `asking`. `subscribe()` fires on every change.
- `orchestration.ts`: a separate `mailbox: MailEntry[]` filled by `runEnded` (outcome) and `ask` (question), with overflow (`maxMailbox`), `take()`, `wait()` (single waiter, 250 ms coalesce, timer), `schedulePush()` (~1 s batch), `render()`.
- `background-tools.ts`: `makeAgentStatusTool` (registry wait via `waitFor`, `onUpdate` snapshots, `statusBlock`, `markRead` and `result_read via:"status"`).
- `agent-control.ts`: routes the 7 actions; `wait` → `orch.wait`, `status` → `makeAgentStatusTool().execute`.

## Goals / Non-Goals

**Goals:** one blocking and reporting path; one pending set; no double delivery; no hang when nothing is alive; the same progress line everywhere.

**Non-Goals:** changing `list` or `messages` output; changing ask/slot/steer mechanics; persisting pending state across `/reload`; dashboard UI changes (events keep their channels).

## Decisions

### D1. One action `wait` with `until`; `status` removed

`wait {ids?, until?: none|any|all, timeout_s?}`. `status` is removed outright (no alias), as requested. Calling it returns the unknown-action error plus a one-line migration hint (`use wait {ids, until:"none"}`).
*Alternative:* keep `status` as an alias. Rejected: two names for one behavior is exactly the confusion being removed.

### D2. Pending set derived from the registry (mailbox removed)

- Outcome pending ⇔ `record.result && record.readAt === undefined` (entry run = `finishedRun`). `finish` already resets `readAt` per run, so steered runs re-pend naturally; an unread run-1 result stays pending while run 2 runs.
- Question pending ⇔ `record.asking && !record.asking.deliveredAt` (new field, set on delivery).
- Order: `result.finishedAt` / `asking.askedAt`.
- `orchestration.pending()` becomes a computed list with the same `MailEntry` shape (seq from a counter assigned when the entry becomes pending, so the `subagents:mail` event keeps `seq`).
- Overflow, `maxMailbox` and `mail_dropped` emission go away. Records already live for the session, so nothing new is retained.

*Alternative:* keep the mailbox and sync it with `markRead` (option A). Rejected: two structures that must agree is the bug class being fixed.

### D3. One consume function

`consume(entries, via: "wait" | "push")` marks outcomes read (`registry.markRead`, emits `result_read` with `via`) and stamps `asking.deliveredAt`. `wait` and the push both call it. `messages` keeps its own `result_read via:"messages"` and does not consume.

### D4. Wait loop

Evaluate on entry and on every `registry.subscribe` change:

1. `covered` = resolved `ids`, else every record that is queued, running, asking or pending.
2. `ids` given and none resolve → return now (`not_found` / `not_alive` rows).
3. `until:"none"` → return now.
4. Any covered child is asking → return now.
5. `any`: some covered child pending → return after the 250 ms coalesce (batches simultaneous finishes).
   `all`: every covered child terminal or idle → return after the coalesce.
6. No covered child queued or running and none pending → return now (`nothingToWait`).
7. Otherwise keep blocking until the timer (min(`timeout_s` ?? 300, 600)) or abort.

On return, render the blocks and consume what was pending among the covered children. The single-waiter rule and `subagents:wait` start/end events stay. While a wait is active the push is suppressed; leftovers are scheduled for push when it ends (as today).

### D5. One progress line

`progressLine(record)` in `background-tools.ts`, built from today's `statusBlock` header: `id: status (type — desc) run N turn T cwd … ⏸asking … ▸ activity · tokens` plus `“…last text”`. The last text is the tail (≤200 chars, whitespace-collapsed) of the latest `text` timeline entry, shown only while running or asking. Used by `wait` updates and blocks, `steer`, `reply` and `cancel` returns. Push outcome lines and `render` outcome lines append only `· N turns · T tokens` to stay compact.

### D6. Progress streaming

`wait` sends `onUpdate` with the covered children's progress lines immediately and on registry changes. A leading+trailing throttle caps it at 1 per second. Updates stop when the wait resolves.

### D7. Timeout

Default 300 s, cap 600 s (`MAX_WAIT_S`). A clamped value adds `(timeout_s clamped to 600)` to the return.

### D8. Explicit snapshot shows read results

`wait {ids, until:"none"}` shows each id's stored result even if read (so a pushed 500-char summary can still be read in full). Without `ids`, only live and pending children are covered, so already-consumed results are not repeated.

## Risks / Trade-offs

- [Breaking `status` for prompts, flows and agent `.md` files] → Error result carries the migration line; task greps `.pi/`, `agents/`, README and flows for `action: "status"` and updates them; CHANGELOG under **BREAKING**.
- [Rule D4.4 returns at once on every call while a question stays unanswered, and a parent may loop] → The block says `BLOCKED until you answer` plus the reply call; a parent can pass `ids` that exclude the asking child.
- [The registry change listener fires per token update, so the wait loop evaluates often] → Evaluation is O(covered) and cheap; `onUpdate` is throttled (D6).
- [Pending outcomes accumulate with `notifyParent:false` and no wait] → Same as today's registry retention; no new growth beyond one flag per run.
- [Pull-only parent (`notifyParent:false`) steers an idle child without reading run 1, then run 2 finishes] → run 2's result overwrites run 1's (the registry stores one result per record). Accepted: with push on (default) run 1 is delivered within ~1 s of finishing; a snapshot before steering also reads it.
- [Plugins depending on `mail_dropped` or `via:"status"`] → Type stays exported; documented in CHANGELOG and README events table.

## Migration Plan

Single release, no data migration (state is in memory). Rollback = revert the commit. `subagents:run` JSONL entries are untouched.

`wait`'s `details.agents` keeps the former `status` shape (`BackgroundAgentStatus[]`, in `ids` order, misses as `{ id, status }`) so dashboard tool cards and plugins reading it keep working.
