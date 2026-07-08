# subagent-model-registry-inheritance Specification

## Purpose
TBD - created by archiving change inherit-parent-model-registry. Update Purpose after archive.
## Requirements
### Requirement: Subagent inherits parent model registry

When spawning a subagent session, the extension SHALL pass the parent session's live model registry to `createAgentSession` so the subagent resolves the same set of providers as the parent, rather than a fresh disk-built registry.

#### Scenario: Custom-provider model resolves in subagent

- **WHEN** the parent session has a custom provider registered at runtime (models and auth) and a subagent is spawned targeting a model from that provider
- **THEN** the subagent resolves the model and its API key from the inherited registry without a "No API key found for <provider>" error

#### Scenario: Built-in provider still resolves

- **WHEN** a subagent is spawned targeting a built-in provider whose auth lives in `auth.json`
- **THEN** the subagent resolves the model and auth exactly as before, with no behavior change

### Requirement: Subagent inherits parent auth storage

When spawning a subagent session, the extension SHALL pass the parent registry's `authStorage` to `createAgentSession`, matching the flows spawn path.

#### Scenario: Auth storage passed alongside registry

- **WHEN** a subagent is spawned
- **THEN** `createAgentSession` is called with both the parent `modelRegistry` and its `authStorage`, so auth resolution is identical to the flows spawn path

