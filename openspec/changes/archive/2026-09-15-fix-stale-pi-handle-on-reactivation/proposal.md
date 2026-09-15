## Why

The **second and every subsequent `Agent` call in a session fails** with:

> This extension ctx is stale after session replacement or reload. Do not use a
> captured pi or command ctx after ctx.newSession(), ctx.fork(),
> ctx.switchSession(), or ctx.reload(). …

Reproduced deterministically: `Agent` call #1 returns normally, `Agent` call #2
throws before the subagent is ever spawned. The parent session is otherwise
healthy — only the `Agent` tool is dead.

Root cause is a **module-level singleton clobbered by re-activation**:

1. `extensions/agent.ts` stores the activation handle in a module-scoped
   `let capturedPi: ExtensionAPI | undefined` (line 913), assigned in
   `activate()` (line 1317). `execute()` reads it via `getPi()` because the tool
   callback receives `ctx` but not `pi`.
2. `runAgentTool` calls `createAgentSession({ cwd, sessionManager, … })` **without
   a `resourceLoader`**. pi therefore builds a fresh `DefaultResourceLoader` for
   the subagent session and loads the user's full extension set again.
3. pi's extension loader caches **factories**, not module instances — the *same*
   module instance is re-activated. `activate(pi_subagent)` runs and overwrites
   `capturedPi` with the **subagent's** handle.
4. The `finally` block calls `session.dispose()`. pi's
   `AgentSession.dispose()` (`core/agent-session.js:567`) invalidates that
   session's extension runtime, setting its `staleMessage`.
5. `capturedPi` now points at a dead runtime. The next `Agent` call reaches
   `getPi()` → `runtime.assertActive()` → throw.

Every activation after the first wins the singleton, and every subagent run kills
the runtime it just installed — so the tool is single-use per session.

```
parent activate()      capturedPi = pi_parent          Agent #1 ✅
  └─ createAgentSession → child activate()  capturedPi = pi_child
  └─ finally session.dispose() → runtime_child INVALIDATED
                                                        Agent #2 ❌ stale
```

## What Changes

- Remove the module-level `capturedPi` / `getPi()` singleton from
  `extensions/agent.ts`.
- Thread the activation handle **lexically**: `makeAgentTool(pi, exposeIsolated)`
  closes over the `pi` from its own `activate()` call and passes it into
  `runAgentTool`. Each activation's registered tool keeps its own live handle;
  re-activation in a child session can no longer reach the parent's tool.
- No wire-contract, schema, or emission change. `runAgentTool`'s signature
  already takes `pi: ExtensionAPI` explicitly and is unchanged.

Out of scope (follow-up): stopping the subagent session from re-activating the
whole extension set at all (pass a `resourceLoader` / suppress extensions in the
child). That is the systemic fix — **any** extension holding module-level `pi`
has this same latent bug today — but it is a larger blast radius and is not
required to unblock the `Agent` tool.

## Capabilities

### Added Capabilities

- `activation-handle-isolation`: the `Agent` tool's `pi` handle SHALL be bound
  per-activation via lexical closure, never via mutable module-level state, so a
  nested subagent session that re-activates the same module instance cannot
  replace or invalidate the parent session's handle.

## Discipline Skills

- `systematic-debugging` — the failure is a live bug; the fix must be grounded in
  the reproduced two-call sequence, not in a plausible-sounding theory.
- `review-code` — non-trivial lifetime/ownership change to the activation path.
