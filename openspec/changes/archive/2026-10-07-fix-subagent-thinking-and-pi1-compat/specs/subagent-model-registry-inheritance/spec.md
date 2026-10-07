## MODIFIED Requirements

### Requirement: Subagent inherits parent model registry

When spawning a subagent session, the extension SHALL hand the parent session's live model runtime to `createAgentSession` through the option the installed pi SDK supports, so the subagent resolves the same set of providers as the parent rather than a fresh disk-built runtime. Passing only options the SDK no longer reads (e.g. the removed `modelRegistry`) does NOT satisfy this requirement.

#### Scenario: Custom-provider model resolves in subagent

- **WHEN** the parent session has a custom provider registered at runtime (models and auth) and a subagent is spawned targeting a model from that provider
- **THEN** the subagent resolves the model and its API key from the inherited runtime without a "No API key found for <provider>" error

#### Scenario: Built-in provider still resolves

- **WHEN** a subagent is spawned targeting a built-in provider whose auth lives in `auth.json`
- **THEN** the subagent resolves the model and auth exactly as before, with no behavior change

#### Scenario: Parent runtime unavailable

- **WHEN** the parent's live runtime cannot be obtained
- **THEN** the subagent falls back to pi's default runtime and a one-line warning is written to stderr

### Requirement: Subagent inherits parent auth storage

When spawning a subagent session, the subagent SHALL resolve auth through the same credential source as the parent. On pi versions where auth is owned by the model runtime, inheriting the runtime satisfies this requirement.

#### Scenario: Auth storage passed alongside registry

- **WHEN** a subagent is spawned on pi 1.x
- **THEN** its auth resolution uses the parent's runtime credentials, identical to the parent session
