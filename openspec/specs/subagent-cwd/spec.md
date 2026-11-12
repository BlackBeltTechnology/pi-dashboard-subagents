# subagent-cwd Specification

## Purpose
Defines how a subagent can run in a working directory other than the parent's, typically a git worktree: how the directory is validated and scoped, what follows it, and how it is reported.

## Requirements

### Requirement: `Agent` SHALL accept an optional `cwd`

The `Agent` schema SHALL accept an optional `cwd` string. When absent, the subagent SHALL use the parent's cwd. A relative path SHALL resolve against the parent's cwd. The resolved cwd SHALL be fixed for the subagent's lifetime, including later runs started by `steer`.

#### Scenario: Default cwd

- **WHEN** `Agent` is called without `cwd`
- **THEN** the subagent SHALL run in the parent's cwd

#### Scenario: Relative cwd

- **GIVEN** the parent cwd is `/repo`
- **WHEN** `Agent` is called with `cwd: ".worktrees/feat"`
- **THEN** the subagent SHALL run in `/repo/.worktrees/feat`

### Requirement: `cwd` SHALL be validated before any spawn work

The resolved `cwd`, after following symlinks, SHALL exist and be a directory and SHALL satisfy `cwdScope`. A rejected `cwd` SHALL produce an error result naming the reason, and SHALL create no record, event, queue entry or slot.

#### Scenario: Missing directory

- **WHEN** `Agent` is called with a `cwd` that does not exist
- **THEN** it SHALL return an error result with reason `cwd_not_found`
- **AND** no `subagents:created` SHALL be emitted

#### Scenario: Symlink escape

- **GIVEN** `cwdScope: "repo"` and `/repo/link` is a symlink to `/etc`
- **WHEN** `Agent` is called with `cwd: "link"`
- **THEN** it SHALL return an error result with reason `cwd_out_of_scope`

### Requirement: `cwdScope` SHALL limit where subagents may run

The settings SHALL gain `cwdScope`, which is `"repo"` (default) or `"any"`. With `"repo"`, a cwd SHALL be allowed only if it is one of:
- the parent cwd or below it;
- inside the parent's git top-level;
- a worktree sharing the parent's git common directory.

With `"any"`, any existing directory SHALL be allowed.

#### Scenario: Sibling worktree outside the repo

- **GIVEN** `cwdScope: "repo"` and `/work/wt-x` is a worktree of the parent's repository
- **WHEN** `Agent` is called with `cwd: "/work/wt-x"`
- **THEN** the call SHALL be accepted

#### Scenario: Foreign repository rejected

- **GIVEN** `cwdScope: "repo"`
- **WHEN** `Agent` is called with the path of an unrelated repository
- **THEN** it SHALL return an error result with reason `cwd_out_of_scope`

#### Scenario: Any scope

- **GIVEN** `cwdScope: "any"`
- **WHEN** `Agent` is called with the path of an unrelated existing directory
- **THEN** the call SHALL be accepted

### Requirement: A subagent's project resources SHALL follow its cwd

A subagent's file tools, context files, project settings, project agent definitions and project extensions SHALL be resolved from its own cwd. The parent process's working directory and environment SHALL NOT be changed. Project extensions SHALL load only if pi trusts that cwd, and the subagent SHALL never trigger an interactive trust prompt.

#### Scenario: Tools resolve in the child cwd

- **GIVEN** a subagent with `cwd: "/repo/.worktrees/feat"`
- **WHEN** it reads `README.md`
- **THEN** it SHALL read `/repo/.worktrees/feat/README.md`

#### Scenario: Agent definition from child cwd

- **GIVEN** `.pi/agents/reviewer.md` exists only in the child cwd
- **WHEN** `Agent` is called with `subagent_type: "reviewer"` and that `cwd`
- **THEN** the definition from the child cwd SHALL be used

#### Scenario: Parent process cwd unchanged

- **WHEN** a subagent runs in another cwd
- **THEN** `process.cwd()` SHALL be unchanged during and after the run

#### Scenario: Untrusted cwd

- **GIVEN** pi does not trust the subagent's cwd
- **WHEN** the subagent is created
- **THEN** that cwd's project extensions SHALL NOT be loaded and no trust prompt SHALL be shown

### Requirement: A subagent's cwd SHALL be reported

The subagent's resolved cwd SHALL appear in `status` and `list` output, in mailbox outcome entries, and in every `subagents:*` lifecycle event payload.

#### Scenario: Cwd in status

- **GIVEN** a background subagent running in `/repo/.worktrees/feat`
- **WHEN** `status` is called for it
- **THEN** the output SHALL include that cwd
