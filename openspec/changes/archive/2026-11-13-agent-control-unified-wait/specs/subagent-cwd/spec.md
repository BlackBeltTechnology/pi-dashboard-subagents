## MODIFIED Requirements

### Requirement: A subagent's cwd SHALL be reported

The subagent's resolved cwd SHALL appear in progress lines (`wait` output and updates, `steer`/`reply`/`cancel` returns), in `list` output, in outcome lines, and in every `subagents:*` lifecycle event payload.

#### Scenario: Cwd in status

- **GIVEN** a background subagent running in `/repo/.worktrees/feat`
- **WHEN** `AgentControl({ action: "wait", ids: [its id], until: "none" })` is called
- **THEN** the output SHALL include that cwd
