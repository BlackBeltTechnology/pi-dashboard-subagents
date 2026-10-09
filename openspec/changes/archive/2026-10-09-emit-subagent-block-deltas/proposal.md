## Why

While a subagent runs, listeners see its streaming reasoning and text only through `details.liveTail` on progress ticks. That field holds just the last 280 characters of the block, so a listener cannot show a whole block growing; the full block only arrives as a `subagents:entry` once it ends. The 280-character cap is right for a one-line preview, because it keeps each progress tick O(1). But ticks are snapshots with "latest wins" semantics, and any listener may drop intermediate ones. Nothing can rebuild a whole block from successive tails. Only the extension sees every character, so only the extension can emit the in-progress block exactly.

## What Changes

- New channel `subagents:delta`. It carries each streaming thinking or text block as append-only pieces: `{ v: 1, agentId, toolCallId, blockId, kind, offset, text, final }`. `offset` is the block-relative start of `text`. Each character is sent once, so the total is O(block), with no sliding window.
- Pieces are batched per block in the existing 250 ms throttle window and are never coalesced away. Pending text accumulates until it is flushed. A flush also happens synchronously when a block ends, when the next block starts, and on terminal status.
- Every block that opens gets exactly one `final: true` piece. That piece is emitted **before** the block's `subagents:entry`, so a listener never re-opens a finished block.
- `subagents:entry` events for blocks that were streamed gain an optional `blockId` field (additive). It lets a listener replace its delta buffer with the finished entry, which is the source of truth. Entries that are not streamed blocks (tools, errors, `message_end` backfill) omit it.
- `details.liveTail` and progress ticks stay unchanged. Ticks keep their O(1) tail.
- If no one listens, `pi.events.emit` does nothing, so existing listeners are unaffected. Release as `0.4.0` (minor, additive).

`liveTail` remains the bounded preview. `subagents:delta` is the exact, full-block stream.

## Capabilities

### New Capabilities
- `subagent-block-delta-stream`: the `subagents:delta` wire contract (identity, offsets, batching, flush points, final marker, ordering against `subagents:entry`) and the optional `blockId` on streamed-block entries.

### Modified Capabilities
<!-- none: subagent-emission requirements (ticks, liveTail-free progress, entry contiguity) are unchanged; blockId is additive and specified in the new capability -->

## Impact

- **Code:** `extensions/agent.ts` (a block-delta accumulator next to `nextLiveTail`, flushes wired into the session subscription and the terminal paths); `extensions/events.ts` (the `SubagentDeltaEvent` type, `emitSubagentDelta`, and an optional `blockId` on `SubagentEntryEvent`); `extensions/index.ts` (re-export the new types); README "Emission channels"; CHANGELOG; `extensions/AGENTS.md`.
- **Wire:** one new channel. No removals and no changed fields. Listeners detect support from whether delta pieces arrive on the channel, not from a version number.
- **Performance:** each streamed character crosses the bus once. Per-agent cost is at most 4 delta events per second plus one per block boundary. Tick size is unchanged.

## Discipline Skills

`doubt-driven-review` (new cross-boundary public wire contract consumed by another repo), `performance-optimization` (event-rate and byte budget on the bus).
