# subagent-thinking-level Specification

## Purpose
Defines how a spawned subagent's thinking level is chosen, so an explicit request (including `off`) or the parent's live level is honored instead of the global settings default.

## Requirements

### Requirement: Explicit thinking suffix is honored

When the effective model reference (tool-call `model` argument, agent `.md` `model:` field, or resolved `@role`) carries a valid thinking-level suffix, the subagent session SHALL start at exactly that level, including `off`. Valid levels are pi's `ThinkingLevel` set: `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`. pi clamps a level the child's model does not support.

#### Scenario: Suffix off disables thinking
- **WHEN** a subagent is spawned with model ref `anthropic/claude-haiku-4-5:off` and `settings.json` has `defaultThinkingLevel: "medium"`
- **THEN** the subagent session starts with thinking level `off`

#### Scenario: Role bound to a ref with suffix
- **WHEN** a subagent is spawned with `@fast` and the role resolves to a ref ending in `:off`
- **THEN** the subagent session starts with thinking level `off`

#### Scenario: pi 1.x max suffix
- **WHEN** a subagent is spawned with literal ref `anthropic/claude-opus-4:max` and no `model:resolve` handler is registered
- **THEN** the fallback resolves model `anthropic/claude-opus-4` and the subagent session is requested with thinking level `max`

#### Scenario: Non-off suffix
- **WHEN** a subagent is spawned with a ref ending in `:high`
- **THEN** the subagent session starts with thinking level `high` (clamped by pi to the model's capabilities)

### Requirement: Parent live thinking level is inherited

When the effective model reference has no thinking-level suffix (or there is no model reference at all), the subagent session SHALL start at the parent session's current thinking level. The parent's level counts even if the user never saved it to settings. Only when the parent level is unavailable SHALL pi's own defaults (per-model setting, then `defaultThinkingLevel`) apply.

#### Scenario: Session-scoped parent level
- **WHEN** the parent session's level is `low` (set via `/thinking`, not saved), `settings.json` says `medium`, and a subagent is spawned with a ref that has no suffix
- **THEN** the subagent session starts with thinking level `low`

#### Scenario: Parent level unavailable
- **WHEN** the parent thinking level cannot be determined and the ref has no suffix
- **THEN** the subagent session starts at pi's default (per-model setting, else `defaultThinkingLevel`)
