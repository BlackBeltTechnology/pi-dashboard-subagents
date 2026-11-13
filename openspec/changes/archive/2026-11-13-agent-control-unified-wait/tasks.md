# Tasks

## 1. Registry: per-run read state for questions

- [x] 1.1 Add `asking.deliveredAt` to `BackgroundRecord.asking` in `extensions/background.ts`; verify with a `background.test.ts` case that a new ask starts undelivered and `finish` still resets `readAt` per run.

## 2. Shared progress line

- [x] 2.1 Write failing tests in new `extensions/__tests__/agent-control.test.ts` (progress line contains id, status, run, turn, activity, asking short form, tokens, cwd, last text ≤200 chars; last text omitted when finished).
- [x] 2.2 Extract `progressLine(record)` in `extensions/background-tools.ts` from the `statusBlock` header plus the last `text` timeline tail; make 2.1 pass.

## 3. Pending set from the registry (mailbox removed)

- [x] 3.1 Rewrite mailbox tests in `orchestration.test.ts`: outcome pending per run, question pending until delivered, ordering, no overflow/drop, `subagents:mail` still emitted with `seq`, `mail_dropped` never emitted; verify they fail.
- [x] 3.2 Replace `mailbox`/`take`/overflow in `extensions/orchestration.ts` with a computed `pending()` and a single `consume(entries, via)` (marks read, stamps `deliveredAt`, emits `result_read` with `via: "wait" | "push"`); make 3.1 pass.
- [x] 3.3 Point push at `pending()` + `consume(…, "push")`; add `· N turns · T tokens` to outcome lines in `render`; verify with push tests (idle parent woken, busy parent follow-up, no double delivery, outcome line usage, pull-only).

## 4. Unified `wait`

- [x] 4.1 Write failing `orchestration.test.ts` / `agent-control.test.ts` cases for every spec scenario: batch drain, wakes on question, unanswered question returns at once, nothing to wait for, unknown ids, last child stops without pending entry, snapshot, explicit-ids snapshot shows a read result, `all`, idle counts as finished, default 300 s, clamp to 600 s with note, one wait at a time, abort ends only the wait.
- [x] 4.2 Implement the D4 evaluation loop in `orch.wait` (`until`, coverage, early returns, registry subscription, coalesce, `MAX_WAIT_S`); make 4.1 pass.
- [x] 4.3 Render per-child blocks (progress line + result, or full question form) in the `wait` action, bounded by `resultMaxChars`; verify with 4.1 output assertions.
- [x] 4.4 Stream throttled `onUpdate` progress (immediate, then ≤1/s, leading+trailing) from the `wait` action; verify the "Live progress" and "Throttled" scenarios with fake timers.

## 5. AgentControl surface

- [x] 5.1 Remove the `status` action and `makeAgentStatusTool` wiring from `extensions/agent-control.ts`; add `until` to the schema and update the description; unknown `status` returns the migration hint. Verify with "Unknown action" and "Former status action" tests.
- [x] 5.2 Append progress lines to `steer`, `reply` and `cancel` returns; verify with the three return tests in `agent-control.test.ts`.
- [x] 5.3 Update the `maxBackgroundPending` hint in `extensions/agent.ts` (~l.1608) to `wait {ids, until:"any"}`; verify with `rg 'action: "status"' extensions` returning only tests for the error path.

## 6. Existing tests and hooks

- [x] 6.1 Migrate `entry-stream-faux.test.ts` (~l.521, 527) and `orchestration-spawn.test.ts` (~l.495) from `status` to `wait`; update `plugin-hooks.test.ts` for `via: "wait"/"push"`; `npm test` green.
- [x] 6.2 Keep `MailDroppedEvent` exported in `extensions/hooks.ts`, marked deprecated (never emitted); verify `npx tsc --noEmit` passes.

## 7. Docs

- [x] 7.1 README: AgentControl action table, migration block (`status` → `wait`), `wait` semantics, events table (`result_read` via, `mail_dropped` no longer emitted); verify with `rg 'action: "status"' README.md` only in the migration block.
- [x] 7.2 CHANGELOG entry under **BREAKING**; `extensions/AGENTS.md` and `extensions/agent.ts.AGENTS.md` rows updated with `See change: agent-control-unified-wait`; `.pi/skills/manage-flows/SKILL.md` checked for `status` usage.

## 8. Verification

- [x] 8.1 `npm test` and `npx tsc --noEmit` pass (the package has no `build` script); `openspec validate agent-control-unified-wait` passes.
- [x] 8.2 Manual check in a live session: `wait {timeout_s: 3000}` with no subagents returns at once; with one running child the tool card shows live progress (turn, activity, tokens) and the final block shows turns and tokens.

## Workflow follow-up

- Run `code-review` / `code-quality` gates before commit.
- Archive with `openspec archive agent-control-unified-wait` after merge.
