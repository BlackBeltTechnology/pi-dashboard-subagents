# subagent-result-bounds Specification

## Purpose
Bound the size of the `Agent` tool result that pi persists to the parent session JSONL (result text, per-entry fields, and the timeline), while `subagents:*` bus events keep full payloads for live listeners.

## Requirements

### Requirement: The persisted Agent tool result SHALL be size-bounded

The `AgentToolResult` that `runAgentTool` returns, and the terminal `onUpdate` snapshot, SHALL be bounded. The limits come from settings `resultMaxChars` (default 16000), `detailsMaxChars` (default 20000) and `entryFieldMaxChars` (default 2000), re-read per spawn. A value of `0` SHALL disable that limit. `subagents:*` bus events SHALL NOT be bounded by these limits.

#### Scenario: long result text keeps head and tail
- **GIVEN** `resultMaxChars: 16000` and a final reply of 50 000 chars
- **WHEN** the tool result is returned
- **THEN** `content[0].text` SHALL be at most 16000 chars plus the marker
- **AND** it SHALL start with the reply's first chars and end with its last chars
- **AND** it SHALL contain a `[… N chars truncated …]` marker where N is the number of removed chars

#### Scenario: long entry fields are cut
- **GIVEN** a tool entry whose `output` is 10 000 chars
- **WHEN** the tool result is returned
- **THEN** that entry's `output` SHALL be at most `entryFieldMaxChars` chars plus the marker

#### Scenario: oversized timeline keeps head and tail entries
- **GIVEN** serialized `details.entries` exceeds `detailsMaxChars`
- **WHEN** the tool result is returned
- **THEN** `details.entries` SHALL keep a prefix and a suffix of the original entries in order
- **AND** exactly one marker entry `{ kind: "error", text: "[N timeline entries omitted]" }` SHALL sit between them
- **AND** `details.entriesOmitted` SHALL equal N
- **AND** `details.entryCount` SHALL equal the original entry count

#### Scenario: metadata is never truncated
- **WHEN** any bound is applied
- **THEN** `agentId`, `status`, `error`, `tokens`, `tokensUsage`, `toolUses` and `durationMs` SHALL be unchanged

#### Scenario: bus events stay full
- **GIVEN** a run whose result exceeds every limit
- **WHEN** `subagents:completed` fires
- **THEN** its `result` and `details.entries` SHALL be the full, unbounded values

#### Scenario: zero disables a limit
- **GIVEN** `detailsMaxChars: 0`
- **WHEN** the tool result is returned
- **THEN** `details.entries` SHALL be the full timeline with no marker and no `entriesOmitted`
