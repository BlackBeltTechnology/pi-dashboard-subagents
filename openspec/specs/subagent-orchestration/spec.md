# subagent-orchestration Specification

## Purpose
Defines two-way coordination between a parent session and its background subagents. Children ask questions and report outcomes through a per-parent mailbox. The parent answers and steers them directly, without reading child transcripts.

## Requirements

### Requirement: Each parent activation SHALL own an in-process mailbox

The extension SHALL keep one mailbox per parent activation. The mailbox SHALL be a view over that activation's background registry, not a separate store: its pending entries SHALL be every run result not yet read (one per finished run) and every open `ask_parent` question not yet delivered. Entries SHALL carry the child id, kind (`question` or `outcome`), run number, timestamp and, for questions, a `question_id`; outcomes SHALL carry `done`, `failed` or `stopped`. Pending entries SHALL be ordered by the time they became pending. Reading a result or delivering a question through any path SHALL remove it from the pending set for every other path. The mailbox SHALL live in memory only and SHALL NOT drop entries.

#### Scenario: Isolation between activations

- **GIVEN** activations A and B in one process, each with a background subagent
- **WHEN** B's subagent posts a question
- **THEN** A's mailbox SHALL NOT contain it

#### Scenario: Outcome posted on run end

- **WHEN** a background subagent run ends `completed`, `error` or `stopped`
- **THEN** one `outcome` entry SHALL become pending with kind `done`, `failed` or `stopped`

#### Scenario: One read point

- **GIVEN** `bg-a` finished and its outcome is pending
- **WHEN** `AgentControl({ action: "wait", ids: ["bg-a"], until: "none" })` returns its result
- **THEN** no later push or `wait` SHALL deliver that outcome again

#### Scenario: Next run is pending again

- **GIVEN** `bg-a`'s run 1 result was read and `bg-a` was continued with `steer`
- **WHEN** run 2 ends
- **THEN** run 2's outcome SHALL be pending

### Requirement: Background subagents SHALL be given an `ask_parent` tool

Every background subagent's tool set SHALL include `ask_parent({ question })`. Foreground subagents SHALL NOT receive it. A call SHALL post a `question` entry with a fresh `question_id` and block until the parent replies or the subagent is stopped. There SHALL be no ask timeout.

#### Scenario: Foreground child has no ask tool

- **WHEN** a foreground `Agent` call spawns a subagent
- **THEN** the subagent's active tools SHALL NOT include `ask_parent`

#### Scenario: Answer returned as tool result

- **GIVEN** a background subagent blocked in `ask_parent` with `question_id: q1`
- **WHEN** the parent calls `AgentControl({ action: "reply", id, question_id: "q1", answer: "JWT" })`
- **THEN** the subagent's `ask_parent` call SHALL return a result containing `JWT`

#### Scenario: Late reply still delivered

- **GIVEN** a background subagent has been blocked in `ask_parent` for an hour
- **WHEN** the parent calls `reply` for that `question_id`
- **THEN** `ask_parent` SHALL return the answer and the subagent SHALL continue

#### Scenario: Manual kill while asking

- **GIVEN** a subagent has been blocked in `ask_parent` with no reply
- **WHEN** it is stopped by `cancel` from the parent, or by a `subagents:stop` event from any emitter
- **THEN** the pending ask SHALL settle with `via: "cancel"`, the subagent SHALL end `stopped`, and no slot or pending re-acquire SHALL remain

#### Scenario: Other stops while asking

- **WHEN** a subagent blocked in `ask_parent` hits its run time limit, or the session shuts down
- **THEN** the pending ask SHALL settle and SHALL NOT keep the subagent alive

### Requirement: Questions shown to the parent SHALL carry reply instructions

Every pending question in a `wait` result or pushed message SHALL state that the subagent is blocked until answered, and give its age, cwd, full question text and the exact `reply` call with id and `question_id`. When more than one question is pending, the batch `replies` form SHALL also be shown. Progress lines (in `wait` updates, snapshots of already-delivered questions, `list`, and `steer`/`reply`/`cancel` returns) SHALL show a one-line short form instead.

#### Scenario: Full form in a wait result

- **WHEN** `wait` returns pending question `q1` from `bg-a`
- **THEN** the block SHALL contain `BLOCKED`, the question text and `AgentControl({ action: "reply", id: "bg-a", question_id: "q1"`

#### Scenario: Short form in status

- **GIVEN** `bg-a` is asking `q1` with a 300-character question that was already delivered
- **WHEN** `AgentControl({ action: "wait", ids: ["bg-a"], until: "none" })` is called
- **THEN** its line SHALL show `asking q1`, the question cut to 120 characters, and `AgentControl(reply bg-a q1)`

### Requirement: An asking subagent SHALL release its concurrency slot

While blocked in `ask_parent`, a subagent SHALL NOT hold a concurrency slot and its status SHALL stay `running` with an `asking` flag. On reply it SHALL re-acquire a slot before `ask_parent` returns. It goes ahead of every ordinary background waiter, and behind foreground waiters. A stop during re-acquire SHALL cancel it without leaking a slot.

#### Scenario: Parallel askers do not starve the queue

- **GIVEN** `maxConcurrent: 2`, subagents `bg-a` and `bg-b` running, and `bg-c` queued
- **WHEN** both `bg-a` and `bg-b` call `ask_parent`
- **THEN** `bg-c` SHALL start running

#### Scenario: Answered asker goes first

- **GIVEN** all slots are busy, `bg-d` is queued, and `bg-a` is asking
- **WHEN** the parent replies to `bg-a`
- **THEN** `bg-a` SHALL get the next free background slot before `bg-d`

### Requirement: The `reply` action SHALL answer pending questions, singly or in batch

`reply` SHALL accept `{ id, question_id, answer }` or `{ replies: [{ id, question_id, answer }, ...] }`. Each reply SHALL settle its matching pending `ask_parent` call independently and immediately, with no turn boundary, and SHALL get its own result: `answered`, `not_pending` (unknown or already answered), `not_found` or `not_alive`.

#### Scenario: Batch reply to parallel questions

- **GIVEN** `wait` returned questions `q1` from `bg-a` and `q2` from `bg-b`
- **WHEN** `AgentControl({ action: "reply", replies: [{ id: "bg-a", question_id: "q1", answer: "JWT" }, { id: "bg-b", question_id: "q2", answer: "yes" }] })` is called
- **THEN** both subagents' `ask_parent` calls SHALL return their own answers
- **AND** the result SHALL list `answered` for both

#### Scenario: One bad entry does not fail the batch

- **WHEN** a batch contains one valid reply and one unknown `question_id`
- **THEN** the valid reply SHALL be `answered` and the other `not_pending`

#### Scenario: Double reply

- **GIVEN** question `q1` was already answered
- **WHEN** `reply` is called again for `q1`
- **THEN** it SHALL return `not_pending` and SHALL NOT affect the subagent

### Requirement: The `wait` action SHALL block until mailbox entries arrive and return them all

`AgentControl({ action: "wait", ids?, until?, timeout_s? })` SHALL be the only action that reports or waits on background subagents. `ids` (short id, full `agentId` or unique prefix) SHALL be optional; when absent the call SHALL cover every child that is queued, running, asking or has a pending entry. `until` SHALL be `none`, `any` (default) or `all`:

- `none` SHALL return the current state at once.
- `any` SHALL return when at least one covered child has a pending entry or is blocked in `ask_parent`.
- `all` SHALL return when every covered child has finished its current run (terminal or `idle`), or earlier when any covered child is blocked in `ask_parent`.

A child blocked in `ask_parent` cannot progress until the parent replies, so `any` and `all` SHALL return at once while a covered child is asking, even when its question was already delivered. The call SHALL return at once when no covered child is queued or running and none has a pending entry, and when `ids` are given and none resolves to a record. While blocking it SHALL also return as soon as that condition becomes true. `timeout_s` SHALL default to 300 and SHALL be capped at 600; a larger value SHALL be clamped and the return SHALL say so. On timeout it SHALL return the current state without cancelling anything. Aborting the call SHALL end only the wait. One `wait` at a time SHALL be allowed per activation.

The return SHALL hold one block per covered child: its progress line, then its result (for a finished run) or its question with reply instructions (when asking). Every pending entry returned SHALL be consumed. An explicit `ids` snapshot SHALL show a finished run's stored result even when it was already read. Output SHALL be bounded by `resultMaxChars`.

#### Scenario: Batch drain

- **GIVEN** two pending entries, a question from `bg-a` and an outcome from `bg-b`
- **WHEN** `AgentControl({ action: "wait" })` is called
- **THEN** it SHALL return both immediately
- **AND** a second `AgentControl({ action: "wait", timeout_s: 1 })` SHALL NOT return them again

#### Scenario: Wakes on question

- **GIVEN** `AgentControl({ action: "wait" })` is blocking on a running child
- **WHEN** the child calls `ask_parent`
- **THEN** the wait SHALL return the question with its `question_id`

#### Scenario: Unanswered question returns at once

- **GIVEN** `bg-a`'s question `q1` was already pushed and is still unanswered, and `bg-b` is running
- **WHEN** `AgentControl({ action: "wait", until: "all" })` is called
- **THEN** it SHALL return at once showing `bg-a` asking `q1` and `bg-b`'s progress line

#### Scenario: Nothing to wait for

- **GIVEN** no background subagent is queued, running or asking and nothing is pending
- **WHEN** `AgentControl({ action: "wait", timeout_s: 3000 })` is called
- **THEN** it SHALL return at once saying there is nothing to wait for

#### Scenario: Unknown ids

- **WHEN** `AgentControl({ action: "wait", ids: ["bg-nope"] })` is called
- **THEN** it SHALL return at once with `bg-nope` reported `not_found`

#### Scenario: Last child stops without a pending entry

- **GIVEN** a wait is blocking on `bg-a` only
- **WHEN** `bg-a` stops and its outcome has already been consumed elsewhere
- **THEN** the wait SHALL return without waiting for the timeout

#### Scenario: Snapshot

- **GIVEN** a running background subagent `bg-a`
- **WHEN** `AgentControl({ action: "wait", ids: ["bg-a"], until: "none" })` is called
- **THEN** it SHALL return immediately with `bg-a`'s progress line showing `running`

#### Scenario: Wait for all

- **GIVEN** `bg-a` and `bg-b` running
- **WHEN** `AgentControl({ action: "wait", ids: ["bg-a","bg-b"], until: "all" })` is called
- **THEN** it SHALL return only after both finished their current run, with both results

#### Scenario: Idle counts as finished

- **GIVEN** `bg-a` finished run 1 and is `idle`
- **WHEN** `AgentControl({ action: "wait", ids: ["bg-a"], until: "all" })` is called
- **THEN** it SHALL return immediately with run 1's result and `status: idle`

#### Scenario: Default timeout

- **GIVEN** a running child and no pending entries
- **WHEN** `AgentControl({ action: "wait" })` is called without `timeout_s` and nothing arrives
- **THEN** it SHALL return after 300 s with the current state, and every subagent SHALL keep running

#### Scenario: Timeout capped

- **WHEN** `AgentControl({ action: "wait", timeout_s: 3000 })` is called with a running child
- **THEN** it SHALL wait at most 600 s and the return SHALL note the clamp

#### Scenario: One wait at a time

- **GIVEN** a `wait` call is in progress
- **WHEN** a second `wait` is called in the same activation
- **THEN** the second SHALL return an error `wait_in_progress`

### Requirement: The `steer` action SHALL steer running and continue idle background subagents

`AgentControl({ action: "steer", id | ids, message, mode })` with `mode` `steer` or `followUp` SHALL route each id independently, with its own result:
- running subagent: queue the message with the matching pi delivery and return `queued`;
- idle subagent: start a new run on the same session with the message, returning `started`, or `queued` if no slot is free;
- otherwise return `not_started`, `foreground`, `not_alive` or `not_found`.

#### Scenario: Steer a running child

- **GIVEN** a running background subagent `bg-a`
- **WHEN** `AgentControl({ action: "steer", id: "bg-a", message: "skip e2e", mode: "steer" })` is called
- **THEN** it SHALL return `queued`
- **AND** the message SHALL be delivered to `bg-a` after its current turn's tool calls

#### Scenario: Continue an idle child

- **GIVEN** an idle background subagent `bg-a` after run 1
- **WHEN** `AgentControl({ action: "steer", id: "bg-a", message: "now add tests", mode: "followUp" })` is called
- **THEN** run 2 SHALL start on the same conversation history
- **AND** its end SHALL post a new outcome entry with `run: 2`

#### Scenario: Broadcast a decision

- **GIVEN** `bg-a` running, `bg-b` idle and `bg-c` disposed
- **WHEN** `AgentControl({ action: "steer", ids: ["bg-a","bg-b","bg-c"], message: "use JWT", mode: "steer" })` is called
- **THEN** the results SHALL be `queued`, `started` and `not_alive` respectively

#### Scenario: Foreground rejected

- **WHEN** `steer` names a foreground subagent
- **THEN** it SHALL return `foreground` and the tool description SHALL state that only background subagents can be steered

### Requirement: Finished background subagents SHALL stay idle until evicted

After a background run ends, the subagent's session SHALL stay alive with status `idle` and SHALL release its concurrency slot. It SHALL be disposed when idle longer than `backgroundIdleTtlSec` (default 600; `0` disposes at once), when idle subagents exceed `maxIdleBackground` (default 4, oldest first), on `cancel`, or on `session_shutdown`.

#### Scenario: Idle releases the slot

- **GIVEN** `maxConcurrent: 1` and background subagent `bg-a` finishing run 1
- **WHEN** another background `Agent` call is queued
- **THEN** it SHALL start once `bg-a` becomes idle

#### Scenario: Idle cap evicts oldest

- **GIVEN** `maxIdleBackground: 2` and idle subagents `bg-a` (oldest) and `bg-b`
- **WHEN** `bg-c` becomes idle
- **THEN** `bg-a` SHALL be disposed and SHALL answer `steer` with `not_alive`

#### Scenario: TTL zero keeps old behaviour

- **GIVEN** `backgroundIdleTtlSec: 0`
- **WHEN** a background run ends
- **THEN** the session SHALL be disposed immediately and the stored result SHALL stay readable

### Requirement: Mailbox entries SHALL be pushed to the parent when it is not waiting

With `notifyParent: true` (default) and no `wait` active, pending entries SHALL be batched (about 1 s) into one custom message and consumed through the same read path as `wait`. Each outcome line SHALL carry the child's turns and tokens. The message is sent as a follow-up while the parent streams, or as a follow-up that triggers a turn when the parent is idle. A push SHALL NOT interrupt a parent turn. With `notifyParent: false` nothing SHALL be pushed.

#### Scenario: Idle parent woken

- **GIVEN** the parent is idle and no `wait` is active
- **WHEN** two subagents finish within 1 s
- **THEN** exactly one custom message listing both outcomes SHALL be sent with `triggerTurn: true`

#### Scenario: Busy parent not interrupted

- **GIVEN** the parent is mid-run
- **WHEN** a subagent posts a question
- **THEN** the message SHALL be sent with `deliverAs: "followUp"` and SHALL arrive after the parent's current run has no more tool calls

#### Scenario: No double delivery

- **GIVEN** an entry was pushed
- **WHEN** `wait` is called afterwards
- **THEN** it SHALL NOT return that entry as pending

#### Scenario: Outcome line carries usage

- **GIVEN** `bg-a` finished after 3 turns using 1.2k tokens
- **WHEN** its outcome is pushed
- **THEN** its line SHALL show `3 turns` and `1.2k tokens`

#### Scenario: Pull-only mode

- **GIVEN** `notifyParent: false`
- **WHEN** any entry becomes pending
- **THEN** no `sendMessage` or `sendUserMessage` call SHALL be made on the parent

### Requirement: Orchestration state SHALL be in-memory and persisted only through the parent JSONL

Subagent sessions and the mailbox SHALL NOT be written to their own files or survive a reload. Each finished background run SHALL be persisted as a `subagents:run` custom entry in the parent session, excluded from model context. After a reload, `steer` and `reply` on a persisted id SHALL return `not_alive`.

#### Scenario: After resume

- **GIVEN** a session with a finished background subagent `bg-a` is reloaded
- **WHEN** `AgentControl({ action: "steer", id: "bg-a", ... })` is called
- **THEN** it SHALL return `not_alive`
- **AND** the parent JSONL SHALL contain a `subagents:run` entry for `bg-a`

### Requirement: Blocking `wait` SHALL stream per-child progress

While `wait` blocks it SHALL send progress updates through the tool's update callback: one immediately, then on registry changes, at most about once per second. Each update SHALL hold one progress line per covered child: id, status, run, turn, activity, the short ask form when asking, tokens, and the last ~200 characters of the child's latest assistant text.

#### Scenario: Live progress

- **GIVEN** `bg-a` is running at turn 3 with 1.2k tokens
- **WHEN** `AgentControl({ action: "wait" })` blocks
- **THEN** an update SHALL arrive at once showing `bg-a`, `running`, `turn 3` and `1.2k tokens`
- **AND** when `bg-a` reaches turn 4 a later update SHALL show `turn 4`

#### Scenario: Throttled

- **WHEN** `bg-a` changes 20 times within one second
- **THEN** at most about two updates SHALL be sent in that second

### Requirement: `steer` and `reply` returns SHALL carry progress lines

Each of `steer` and `reply` SHALL append, after its per-id outcome, the progress line of every child it touched that still has a record.

#### Scenario: Steer shows progress

- **GIVEN** `bg-a` is running with 1.2k tokens
- **WHEN** `AgentControl({ action: "steer", id: "bg-a", message: "focus" })` returns
- **THEN** the return SHALL include `bg-a`'s progress line with `1.2k tokens`

#### Scenario: Reply shows progress

- **GIVEN** `bg-a` is asking `q1` with 1.2k tokens
- **WHEN** `AgentControl({ action: "reply", id: "bg-a", question_id: "q1", answer: "yes" })` returns
- **THEN** the return SHALL include `bg-a`'s progress line with `1.2k tokens`
