## 1. Final assistant message decides the outcome

- [x] 1.1 Tighten `extensions/__tests__/entry-stream-faux.test.ts` "provider error mid-run" so it asserts `result.details.status === "error"`, `result.isError === true`, a `subagents:failed` event, and result text not equal to `"first"`. Verify it fails on current code.
- [x] 1.2 Add faux tests: an empty final reply fails with `"subagent produced no final output"`; a normal run still completes with only the final message's text.
- [x] 1.3 In `runAgentTool`, track `lastAssistant` (stopReason, errorMessage, joined text blocks) in the `message_end` branch. Replace `lastAssistantText(entries) ?? "(no output)"` with the Decision 1 outcome rules, and route failures through `emitSubagentFailed` + `errorResult`.
- [x] 1.4 Remove `lastAssistantText` if it is no longer used. Run the full suite.

## 2. Abort honored during construction

- [x] 2.1 Add tests (mocked loader/session, or faux provider): abort during `reload()` means `createAgentSession` is not called; abort during `createAgentSession` means `prompt` is not called and `dispose` is; the faux provider gets zero requests; `subagents:failed` fires once. Verify they fail.
- [x] 2.2 Add a `throwIfAborted(signal)` that throws `SpawnAbortedError`, called after `createChildLoader` and after `createAgentSession`. Map `SpawnAbortedError` in the outer `catch` to the existing aborted details/result.
- [x] 2.3 Confirm the existing queued-abort tests still pass.

## 3. Settlement hooks stripped from children

- [x] 3.1 Add a test with an inline extension registering `turn_end`/`agent_end`/`agent_before_settle`/`agent_settled`/`message_end`/`tool_call` handlers: the child run invokes only `message_end` and `tool_call`; the parent's handler maps are unchanged; the tool surface is unchanged. Verify it fails.
- [x] 3.2 Add `extensionsOverride` in `createChildLoader`, deleting `CHILD_STRIPPED_EVENTS` from each `ext.handlers`.
- [x] 3.3 Update the loader-options assertions in existing spawn-cost tests.

## 4. Result bounds

- [x] 4.1 Add `resultMaxChars`, `detailsMaxChars`, `entryFieldMaxChars` to `DashboardAgentSettings` (defaults 16000/20000/2000, `0` = unlimited, coerced like `maxConcurrent`), with getters. Add settings tests.
- [x] 4.2 Unit-test a pure `boundToolResult(text, details, limits)` for: head/tail text with marker, per-field cuts, head/tail entries with a single marker + `entriesOmitted`, unchanged metadata, and `0` disables.
- [x] 4.3 Implement `boundToolResult`. Apply it to the returned tool result on every post-spawn path and to `pushTerminalUpdate`; leave `subagents:*` emissions unbounded. Add optional `entriesOmitted?: number` to `AgentDetails` in `events.ts`.
- [x] 4.4 Add an e2e faux test where the run exceeds the limits: the tool result is bounded, and `subagents:completed` and the rebuilt `subagents:entry` stream stay full.

## 5. Docs & release

- [x] 5.1 README: new settings rows; failure semantics (an errored or empty final reply fails; Stop during setup); the child hook isolation note.
- [x] 5.2 CHANGELOG entry (minor; note the behavioral fix for errored/empty final replies).
- [x] 5.3 Update `extensions/AGENTS.md` rows for `agent.ts`, `settings.ts`, `events.ts` (`See change: harden-subagent-lifecycle`).
- [x] 5.4 `npm test`, `npm run typecheck` (no build script), `openspec validate harden-subagent-lifecycle --strict`.
