## Context

See proposal.md (Why). Current producer state:

- `nextLiveTail(prev, event)` (`extensions/agent.ts`) already walks the `thinking_*`/`text_*` events in `message_update.assistantMessageEvent`. It is a pure fold into a 280-character suffix: `_start` resets it, `_delta` appends, and `_end`/`message_end` clear it.
- `runAgentTool`'s `session.subscribe` callback is the single event loop. It calls `nextLiveTail`, then appends entries:
  - On `message_update`, `mapSessionEventToEntry` turns `thinking_end`/`text_end` into a step.
  - On `tool_execution_end` it appends a tool step.
  - On `message_end` it backfills any text or thinking blocks that providers never closed with `_end`.
- `appendEntry` is the only push site. It emits `subagents:entry` synchronously.
- `createProgressEmitter(sink, 250)` drives ticks with "latest wins" semantics. It is the wrong primitive for deltas, because `schedule()` replaces the pending value.
- Terminal paths (abort, completed, failed, and the two early-failure paths) call `progress.flush()` or `progress.dispose()` before they emit `subagents:completed`/`failed`.

## Goals / Non-Goals

**Goals:** emit the exact block content incrementally, keep per-agent event rate bounded, keep ticks and `liveTail` byte-identical, and make block ↔ entry linkage unambiguous.

**Non-Goals:**
- How listeners transport, buffer, replay or render pieces.
- Per-token emission.
- Replaying deltas to late subscribers. The extension keeps no replay buffer; pieces are fire-and-forget on the bus.
- Emitting tool-call argument deltas (`toolcall_delta`).

## Decisions

1. **Block identity is a producer counter (`blockId`), not the future entry `index`.**
   Alternative: tag pieces with `entries.length` at block start, the index the entry will probably take. This breaks for blocks that produce no entry (empty or redacted thinking, which `message_end` backfill skips). It also breaks when backfill appends several entries at once after no `_end` events. A counter is unambiguous. The finished entry carries the same `blockId` (additive field), so the listener correlates exactly instead of guessing.

2. **Offsets are block-relative, in UTF-16 code units.**
   JS `string.length` is what both sides measure natively. Block-relative offsets let a listener detect gaps (`offset > have`) and duplicates (`offset < have`) without any global sequence number. A piece never splits a surrogate pair, because deltas are appended whole.

3. **A dedicated accumulator: `createBlockDeltaEmitter(sink, windowMs)`, not a reuse of `createProgressEmitter`.**
   The progress emitter replaces the pending value, which is fine for snapshots and fatal for appends. The new helper:
   - holds `{ blockId, kind, offset, pending }` for the one open block;
   - `push(kind, delta)` appends to `pending` and arms a single trailing timer, the same leading-edge/trailing-edge shape as the progress emitter;
   - `open(kind)` closes any open block (final flush), then assigns `blockId = next++`;
   - `close()` emits `{ text: pending, final: true }` synchronously and clears the timer;
   - `dispose()` closes any open block, then clears the timer.

   It is pure apart from its timer, so it can be unit-tested with fake timers, as the progress emitter is.

4. **Close points are wired explicitly in the subscribe loop, before `appendEntry`.**
   - On `thinking_end`/`text_end`, call `blockDeltas.close()` *before* `mapSessionEventToEntry` → `appendEntry`. Pass the closed `blockId` into the `appendEntry` call (`appendEntry(entry, blockId)`), so the entry event carries it.
   - On `message_end`, call `close()` before the backfill loop. Backfilled entries get no `blockId` (Decision 6).
   - On terminal paths, call `blockDeltas.dispose()` next to the existing `progress.flush()`/`dispose()`, before `subagents:completed`/`failed`.

   Ordering is then guaranteed by synchronous emission on one bus. This is the producer half of the "the last delta of a block arrives before its entry" invariant.

5. **`_start` opens the block; a stray `_delta` with no open block, or with a different kind, opens one implicitly.**
   Some providers may skip `_start`. Implicit open keeps the "every character emitted once" guarantee without relying on provider event hygiene.

6. **Backfilled entries omit `blockId`.**
   When a provider never sends `_end`, the streamed block and the backfilled entry cannot be paired by event, and positional pairing is unsafe (Decision 1). The final piece still closes the block. The extension guarantees only that the close comes before the backfilled entries; pairing a closed-but-unlinked block with them is left to the listener.

7. **Wire shape mirrors `subagents:entry`: `{ v: 1, agentId, toolCallId, blockId, kind, offset, text, final }`.**
   Here `v` gates future evolution, and `toolCallId` lets a listener route the piece without a lookup, the same reason the entry carries it.

## Risks / Trade-offs

- [Event rate increase: up to 4 delta events/s/agent on top of 4 ticks/s] → Pieces carry only new characters. Across a run the bytes on the bus are O(total streamed text), not O(n²). A test asserts the throttle bound.
- [Existing listeners do not know the new channel] → No effect: `pi.events.emit` with no listener does nothing.
- [A listener relies on deltas being complete] → The spec makes the finished entry authoritative. Deltas are a preview; a listener that drops pieces can repair the block from the entry.
- [Interleaved blocks within one message] → pi streams content blocks sequentially. Decision 5's implicit open/close also handles a kind switch without `_end`.
- [Wire-contract drift for external listeners] → The `SubagentDeltaEvent` type is exported from `extensions/index.ts`, and README documents the channel.

## Migration Plan

Additive minor release `0.4.0`. No config and no migration. Rollback means republishing `0.3.x`. Listeners fall back to `liveTail` plus entries when no delta pieces arrive.
