## Context

`extensions/agent.ts` registers one tool, `Agent`. pi's tool `execute` callback
signature is `(toolCallId, params, signal, onUpdate, ctx)` — it delivers an
`ExtensionContext`, **not** the `ExtensionAPI` handle. The emission helpers
(`emitSubagentStarted/Progress/Completed/Failed`, `createProgressEmitter`) all
need `ExtensionAPI`. The current code bridges that gap with a module-level
`capturedPi` set in `activate()`.

That bridge is safe only under the assumption "activate() runs once per module
instance". `createAgentSession` breaks the assumption: the child session builds
its own `DefaultResourceLoader`, which re-loads the same extension paths, and
pi's loader caches the **factory** (`extensionCache`, `loader.js:353/374`) so the
module instance — and therefore its module scope — is shared with the parent.

## Goals / Non-Goals

**Goals**
- Second and Nth `Agent` calls in one session succeed.
- The parent's registered tool never observes a handle belonging to a child
  session, regardless of how many nested activations occur.
- Zero change to the emitted wire contract or to `runAgentTool`'s behaviour.

**Non-Goals**
- Preventing the child session from loading extensions at all (follow-up).
- Fixing module-level-`pi` hazards in other extensions.
- Any change to pi core. pi's `dispose()` → `invalidate()` is correct; it is
  invalidating the *child's* runtime, which is exactly right.

## Decisions

### Decision 1: lexical closure, not a stale-guard

Rejected alternative: keep `capturedPi` and guard it (`try getPi(); catch → refetch`).
That leaves the parent's emit path pointed at a dead runtime and only degrades
the symptom — progress frames would silently stop, or the guard would have to
resurrect state it does not own. A closure removes the shared mutable cell
entirely, so the class of bug cannot recur.

Rejected alternative: a stack/Map of handles keyed by session. More machinery,
same guarantee, and still shared mutable module state.

**Chosen:** `makeAgentTool(pi, exposeIsolated)`. `activate(pi)` passes its own
`pi` in; `execute` closes over it. Each activation produces an independent tool
object bound to an independent handle — the natural lifetime already provided by
the language.

### Decision 2: `runAgentTool` signature stays

`runAgentTool(cwd, args, signal, onUpdate, ctx, pi)` already accepts `pi`
explicitly (added for testability). Only the *call site* changes: `getPi()` →
the closed-over `pi`. Existing tests that call `runAgentTool` with an injected
fake `pi` keep working unchanged.

### Decision 3: delete the singleton rather than leave it unused

`capturedPi`, `getPi()`, and the "invoked before activate() captured pi handle"
error are removed. Leaving a dead cell invites a future call site to reach for it
and reintroduce the bug. Its one purpose — reaching `pi` from `execute` — is
fully served by the closure.

## Risks / Trade-offs

- **Risk:** a future code path needs `pi` from somewhere with no closure access
  (e.g. a module-level helper called outside a tool run). Mitigation: pass `pi`
  as a parameter, the pattern `runAgentTool` already uses.
- **Trade-off:** the child session still re-activates every extension on every
  spawn (wasted work, and other extensions keep their own module-state hazard).
  Accepted here; tracked as the follow-up change.

## Verification shape

The regression must fail on revert. A test that merely calls `runAgentTool`
twice with an injected `pi` will **not** reproduce the bug — the singleton is
bypassed. The teeth are in asserting the *binding*: two `activate()` calls with
two distinct `pi` handles must yield two tools that each emit through their own
handle, and invalidating the second handle must not affect the first tool.
