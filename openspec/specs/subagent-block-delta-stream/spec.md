# subagent-block-delta-stream Specification

## Purpose
Streams each running subagent's in-progress thinking and text blocks as exact, append-only pieces on `subagents:delta`. A listener can then show a whole block growing while it runs. The finished `subagents:entry` stays the source of truth.

## Requirements

### Requirement: The extension SHALL emit streaming block content as append-only pieces on `subagents:delta`

While a subagent streams a thinking or text block, the extension SHALL emit `pi.events.emit("subagents:delta", { v: 1, agentId, toolCallId, blockId, kind, offset, text, final })`.
- `blockId` SHALL be an integer, unique per block within one subagent run, starting at `0` and increasing by 1 each time a block opens.
- `kind` SHALL be `"thinking"` or `"text"`.
- `offset` SHALL be the position of `text`'s first character within the block, counted in JavaScript string length (UTF-16 code units).
- `toolCallId` SHALL be the parent `Agent` tool call id, or `""` when unknown.
- Pieces of one block SHALL be contiguous: the first piece has `offset` 0, and each later piece's `offset` equals the previous piece's `offset + text.length`.
- No character of a block SHALL be emitted more than once or omitted.
- Joining the `text` of a block's pieces in order SHALL equal the concatenation of that block's streamed deltas.

#### Scenario: Pieces reconstruct the streamed block exactly

- **GIVEN** a thinking block streams deltas `"Let "`, `"me "`, `"check"` across several throttle windows
- **WHEN** a listener concatenates the `text` of every `subagents:delta` piece with that `blockId` in arrival order
- **THEN** the result SHALL equal `"Let me check"`
- **AND** each piece's `offset` SHALL equal the total length of the pieces before it

#### Scenario: Consecutive blocks get distinct, increasing ids

- **GIVEN** one assistant message streams a thinking block, then a text block, and a later message streams another thinking block
- **WHEN** pieces are emitted
- **THEN** the blocks SHALL carry `blockId` 0, 1 and 2 respectively
- **AND** the first piece of each block SHALL have `offset` 0

#### Scenario: A large burst within one window is not lost

- **GIVEN** more than 1,000 characters of deltas arrive for one block within a single 250 ms window
- **WHEN** the window flushes
- **THEN** one piece SHALL carry all of those characters, contiguous with the previous piece
- **AND** no characters SHALL be dropped

### Requirement: Delta pieces SHALL be batched within the progress throttle window and never coalesced away

The extension SHALL accumulate pending block text and emit it at most once per 250 ms throttle window per subagent. Pending text SHALL be appended to, never replaced, so a coalesced window loses no characters. Pending text SHALL also be flushed synchronously at these points:
- when the block ends,
- when a different block starts,
- when the assistant message ends,
- before any terminal emission (`subagents:completed`, `subagents:failed`, or abort).

A delta emission SHALL NOT change the cadence or the content of `subagents:started` progress ticks or `details.liveTail`.

#### Scenario: Throttled delta rate

- **GIVEN** 200 `thinking_delta` events arrive for one block within 1 second
- **WHEN** no block boundary occurs in that second
- **THEN** at most 4 non-final `subagents:delta` events SHALL be emitted for that subagent in that second

#### Scenario: Ticks and liveTail are unchanged

- **WHEN** a block streams with delta emission active
- **THEN** each progress tick SHALL still omit `entries`
- **AND** `details.liveTail` SHALL still hold at most the last 280 characters of the block

#### Scenario: Abort flushes pending text

- **GIVEN** a block has unflushed pending text
- **WHEN** the run is aborted or fails
- **THEN** the pending text SHALL be emitted as a `final: true` piece before the terminal emission

### Requirement: Every opened block SHALL receive exactly one final piece, emitted before its entry

For each block that opens, the extension SHALL emit exactly one piece with `final: true`. That piece carries any remaining pending text, possibly `""`. It SHALL be the last piece emitted for that `blockId`. When the block produces a timeline entry, its final piece SHALL be emitted before that block's `subagents:entry`. No piece for a `blockId` SHALL follow its `final: true` piece. A block SHALL get its final piece when it ends, when the message ends without an end event, or when the run terminates, whichever comes first.

#### Scenario: Final piece precedes the block's entry

- **WHEN** a thinking block ends normally
- **THEN** the listener SHALL observe `subagents:delta` with that `blockId` and `final: true`
- **AND** only afterwards `subagents:entry` for the finished thinking step

#### Scenario: Block that never gets an end event is still closed

- **GIVEN** a provider streams text deltas but emits no `text_end`, and the text is later backfilled at `message_end`
- **WHEN** the message ends
- **THEN** the open block SHALL receive its `final: true` piece
- **AND** the piece SHALL be emitted before the backfilled `subagents:entry`

#### Scenario: Block with no resulting entry is still closed

- **GIVEN** a block streams deltas but produces no timeline entry (for example, empty or redacted content)
- **WHEN** the block ends
- **THEN** it SHALL still receive exactly one `final: true` piece

### Requirement: Entries for streamed blocks SHALL carry the block's id

When a `subagents:entry` event announces a thinking or text step that was produced by a streamed block's end event, the event SHALL include `blockId` equal to that block's id. `blockId` is additive and optional: all existing `subagents:entry` fields and their `index` contiguity SHALL be unchanged. Entries for tool steps, error steps, and `message_end` backfill SHALL omit `blockId`.

#### Scenario: Entry links to its delta block

- **WHEN** a streamed text block with `blockId` 3 ends and becomes a timeline step
- **THEN** the `subagents:entry` for that step SHALL carry `blockId: 3`
- **AND** its `entry.text` SHALL equal the concatenation of the block's delta pieces

#### Scenario: Tool entries omit blockId

- **WHEN** a tool step is appended
- **THEN** its `subagents:entry` event SHALL NOT contain a `blockId` key

### Requirement: Delta emission SHALL degrade silently

The extension SHALL send delta pieces only through the same no-throw emission path as the other `subagents:*` channels. When `pi.events` is unavailable, delta emission SHALL be a no-op, and the run SHALL continue normally. Delta emission SHALL NOT depend on any listener being registered.

#### Scenario: No event bus

- **GIVEN** `pi.events` is undefined
- **WHEN** a block streams
- **THEN** no error SHALL be thrown, and the subagent run SHALL complete normally
