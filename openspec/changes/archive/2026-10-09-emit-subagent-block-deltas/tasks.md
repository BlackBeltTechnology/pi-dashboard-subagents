## 1. Wire types and emission helper (`extensions/events.ts`)

- [x] 1.1 Write failing tests in `extensions/__tests__/events.test.ts`, using the existing `emitSubagentEntry` channel tests as the pattern. Cover four cases: `emitSubagentDelta` emits on `subagents:delta` with `{ v:1, agentId, toolCallId, blockId, kind, offset, text, final }`; it is a no-op without throwing when `pi.events` is undefined; `emitSubagentEntry` passes an optional `blockId` through when given; and the `blockId` key is absent when not given. Verify the tests fail.
- [x] 1.2 Add the `SubagentDeltaEvent` type, `emitSubagentDelta`, and optional `blockId?: number` on `SubagentEntryEvent`. Re-export the new type and helper from `extensions/index.ts`. Verify the 1.1 tests pass and `npm run typecheck` is clean.

## 2. Block-delta accumulator (`extensions/agent.ts`)

- [x] 2.1 Write failing unit tests for `createBlockDeltaEmitter(sink, windowMs)` with fake timers, using the `createProgressEmitter` throttling suite as the pattern. Cover:
  - (a) Contiguity: deltas `"Let "`, `"me "`, `"check"` across windows; the concatenated pieces equal `"Let me check"`, offsets equal the prefix lengths, and the first offset is 0.
  - (b) 200 deltas in 1 s with no boundary produce ≤ 4 non-final pieces.
  - (c) 1,500 characters inside one window produce one piece with no characters lost.
  - (d) `open()` on a new block closes the previous one with exactly one `final:true` piece, and `blockId` increments 0, 1, 2.
  - (e) `close()` with empty pending still emits `{ text:"", final:true }`.
  - (f) `dispose()` closes an open block and clears the timer, so nothing is emitted after dispose.
  - (g) A delta with a different kind and no open block opens a block implicitly.

  Verify the tests fail.
- [x] 2.2 Implement `createBlockDeltaEmitter` per design Decisions 3 and 5. Verify the 2.1 tests pass.

## 3. Wire into the spawn loop

- [x] 3.1 Write failing tests in the `runAgentTool` spawn-path suite of `extensions/__tests__/agent.test.ts`, using the existing `per-step entry stream` suite as the pattern. Cover:
  - (a) For a streamed thinking block followed by a text block, the recorded bus order is: the pieces of block 0, the `final` piece of block 0, `subagents:entry{blockId:0}`, then the pieces of block 1 with offset restarting at 0.
  - (b) `entry.text` equals the concatenated pieces of its block.
  - (c) Tool entries carry no `blockId` key.
  - (d) The no-`_end` provider path: the `final` piece arrives before the backfilled entry, and the backfilled entry has no `blockId`.
  - (e) On abort with pending text, the `final` piece arrives before `subagents:failed`.
  - (f) Progress ticks still omit `entries`, and `liveTail.text.length` ≤ 280, unchanged.

  Verify the tests fail.
- [x] 3.2 Instantiate one block-delta emitter per run in `runAgentTool`. Then:
  - call `open`/`push` from the subscribe loop;
  - call `close()` before `appendEntry` on `thinking_end`/`text_end`, and before the `message_end` backfill;
  - change `appendEntry(entry, blockId?)` to forward `blockId`;
  - call `dispose()` on every terminal path before `subagents:completed`/`failed`.

  Verify the 3.1 tests pass.
- [x] 3.3 Extend `extensions/__tests__/entry-stream-faux.test.ts`, which runs a real `AgentSession` against the faux provider. Rebuild every streamed block from `subagents:delta` alone and assert it `toEqual`s the matching `subagents:entry` text (linked by `blockId`). Check that every opened `blockId` has exactly one `final` piece. Check that each delta event is ≤ 4 per second per agent, and that the maximum progress-frame size is unchanged from the current bound (< 1.5 KB). Verify the test passes.

## 4. Docs and release

- [x] 4.1 Add a `subagents:delta` row to the README "Emission channels" table, and note `blockId` on `subagents:entry`. Verify by reading the README table.
- [x] 4.2 Add a CHANGELOG `[0.4.0]` "Added" entry, and bump `package.json` to `0.4.0`. Add `See change: emit-subagent-block-deltas` to the `agent.ts`, `events.ts`, `index.ts` and test rows of `extensions/AGENTS.md`. Verify by running `npm test` and `npm run typecheck`, both green.
- [x] 4.3 Run `openspec validate emit-subagent-block-deltas --strict`. Verify it passes.
