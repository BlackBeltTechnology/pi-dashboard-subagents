# Proposal

## Why

`AgentControl` has two blocking paths, `status` (waits on registry state) and `wait` (drains a separate mailbox), and they don't agree. `wait` blocks for the whole `timeout_s` when no child is alive (a parent sat 46 min in a `timeout_s: 3000` wait with zero subagents running). It streams no progress and returns outcomes without turns or tokens. A result read through `status` is still pushed or returned again by `wait`, because the mailbox and the registry's read state are tracked separately.

## What Changes

- **BREAKING** Merge `status` into `wait`: one action `AgentControl({ action: "wait", ids?, until?: "none" | "any" | "all", timeout_s? })`. The `status` action is removed; `wait until:"none"` is the snapshot.
- **BREAKING** Replace the separate mailbox with an "unread" view over the registry: pending = unread run results + undelivered open questions. `wait` and the push consume through one mark-read path, so nothing is delivered twice. Mailbox overflow (and `subagents:mail_dropped`) goes away.
- `wait` returns at once when nothing it could wait for is alive (no matching child queued or running and nothing unread), and when `ids` resolve to no record.
- While blocking, `wait` streams a progress line per matching child (status, run, turn, activity, asking, tokens, last assistant text), throttled to about 1 per second.
- `wait` returns one block per child: progress line, then the result or the question with a copy-ready `reply` call.
- `steer`, `reply` and `cancel` append the progress line of every child they touched.
- Push messages and outcome lines carry turns and tokens.
- `timeout_s` defaults to 300 and is capped at 600; a larger value is clamped and the return says so.
- `subagents:result_read` gains `via: "wait"` and `via: "push"`; `via: "status"` is no longer emitted.

## Capabilities

### New Capabilities

_None._

### Modified Capabilities

- `subagent-orchestration`: the mailbox becomes an unread view over the registry; `wait` gains `until`, early return, progress streaming and a timeout cap; push shares the mark-read path; `steer`/`reply` returns carry progress lines.
- `background-subagents`: the `status` action is removed (folded into `wait`); `AgentControl` action list changes; stored results are read through `wait`; `cancel` returns carry progress lines.
- `subagent-plugin-hooks`: `subagents:result_read` `via` values change; `subagents:mail_dropped` is no longer emitted.

## Impact

- Code: `extensions/orchestration.ts` (mailbox → registry view, wait, push, render), `extensions/agent-control.ts` (actions, schema, description), `extensions/background-tools.ts` (status handler folded into wait, shared progress line), `extensions/background.ts` (per-run read state for questions), `extensions/hooks.ts` (event payloads).
- Tests: `extensions/__tests__/orchestration.test.ts`, `background.test.ts`, `orchestration-spawn.test.ts`, `plugin-hooks.test.ts`; new `agent-control.test.ts`.
- Docs: `README.md` (AgentControl tables, migration, events), `CHANGELOG.md`, `extensions/AGENTS.md` and `agent.ts.AGENTS.md` rows.
- API: any caller (prompt, flow, agent `.md`) using `action: "status"` must switch to `action: "wait"` with `until: "none"` or `"any"/"all"`.

## Discipline Skills

`doubt-driven-review` (breaking public tool API change and mailbox removal), `systematic-debugging` (if a timing bug surfaces), `code-simplification` (after the merge).
