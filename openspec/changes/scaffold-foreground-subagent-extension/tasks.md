## 1. Settings layer — already shipped, lock the contract

- [x] 1.1 `extensions/settings.ts` defines `DashboardAgentSettings` with `inheritContext`, `exposeInheritanceInTool`, `inheritance.{recentTurns,toolOutputWindow,maxChars}`.
- [x] 1.2 Defaults baked into `DEFAULT_SETTINGS` (frozen).
- [x] 1.3 Persistence at `~/.pi/agent/extensions/pi-dashboard-subagents/config.json` via atomic tmp+rename.
- [x] 1.4 In-memory cache with `invalidateSettingsCache()` for tests + reload.
- [x] 1.5 `resolveIsolated(perCall)` honors `exposeInheritanceInTool` semantics — per-call ignored when expose is off.
- [x] 1.6 Unit test `extensions/__tests__/settings.test.ts`:
   - Defaults loaded when file absent
   - Partial merge with defaults
   - Atomic write + readback
   - Cache invalidation
   - `resolveIsolated` four-mode truth table

## 2. Event emission layer — already shipped, lock the contract

- [x] 2.1 `extensions/events.ts` defines `SubagentTimelineEntry` discriminated union (`tool | text | thinking | error`).
- [x] 2.2 `AgentDetails` shape matches dashboard's `add-subagent-inspector` reducer contract.
- [x] 2.3 `mapSessionEventToEntry` for `tool_execution_end` + `message_update` (`text_end`, `thinking_end`, `error`).
- [x] 2.4 `createToolCallTracker` pairs `tool_execution_start` ↔ `_end` for input args.
- [x] 2.5 Emission helpers: `emitSubagentCreated`, `emitSubagentStarted`, `emitSubagentProgress`, `emitSubagentCompleted`, `emitSubagentFailed`. All emit via `pi.events?.emit(channel, data)` — soft on missing event bus.
- [x] 2.6 `buildDetails(snapshot)` is the single source of truth for the streamed payload shape.
- [x] 2.7 `compressParentContext` + `buildInheritedContext` for context inheritance with verbatim compaction.
- [x] 2.8 Unit test `extensions/__tests__/events.test.ts`:
   - `mapSessionEventToEntry` returns null for uninteresting events
   - `mapSessionEventToEntry` maps each interesting kind correctly
   - `createToolCallTracker` pairs across nested concurrent calls
   - `compressParentContext` produces expected output for representative inputs (truncation, masking, hard-cap)
   - Emission helpers call `pi.events.emit` with the right channel + payload

## 3. Tool registration — `extensions/agent.ts` (the main NEW code)

- [x] 3.1 Export `default function activate(pi: ExtensionAPI): void` matching pi's `ExtensionFactory` signature.
- [x] 3.2 Inside `activate`, register the `Agent` tool via `pi.registerTool(defineTool({...}))`. Build the TypeBox `parameters` schema conditionally on `shouldExposeInheritanceInTool()`:
   - Always include `subagent_type: Type.String()`, `description: Type.String()`, `prompt: Type.String()`.
   - Optionally include `isolated: Type.Optional(Type.Boolean())` when setting is true.
- [x] 3.3 Implement the `execute(toolCallId, args, signal, onUpdate, ctx)` callback:
   - Generate `agentId = randomUUID()`.
   - Resolve `agentMdPath` via project-then-global `.md` lookup.
   - Build initial `AgentDetails` via `buildDetails(...)` and emit `subagents:created`.
   - Resolve `isolated` via `resolveIsolated(args.isolated)`.
   - Build inherited-context prefix via `buildInheritedContext(ctx, {isolated, ...inheritance})`.
   - Compose effective prompt.
   - Construct `AgentSession` via `createAgentSession` + `SessionManager.inMemory(ctx.cwd)`.
   - Filter active tools to exclude `Agent` (prevent nesting).
   - Subscribe to `session.subscribe(event)`:
     - Pair tool starts/ends via `createToolCallTracker()`.
     - Map to `SubagentTimelineEntry`s via `mapSessionEventToEntry`.
     - Append to in-memory `entries[]`.
     - Track activity, token usage, turn count.
     - Throttle progress emissions to ≤ 4/sec to avoid bus flood.
   - Wire `signal: AbortSignal` to `session.abort()` for parent-initiated cancellation.
   - Emit `subagents:started` with initial details.
   - Call `await session.prompt(effectivePrompt)`.
   - On resolve: emit `subagents:completed` with final entries + result + tokens.
   - On error: emit `subagents:failed` with entries-so-far + error.
   - Return `AgentToolResult<AgentDetails>` to the parent — pi renders the result via the dashboard's `AgentToolRenderer`.
- [x] 3.4 Helper `resolveAgentMdPath(agentType: string, cwd: string): string | undefined`:
   - Check `<cwd>/.pi/agents/<type>.md`
   - Check `<agentDir>/agents/<type>.md` (via `getAgentDir()`)
   - Return first hit, undefined otherwise.
- [x] 3.5 Helper `progressEmitter`: lightweight throttling wrapper around `emitSubagentProgress` to coalesce updates within a 250ms window. Final state always flushes regardless of throttle.
- [x] 3.6 Helper `accumulateUsage` reading `message_end.message.usage` for `tokensInput`/`tokensOutput` totals.
- [x] 3.7 Defensive: wrap the entire `execute` body in try/finally so subscriptions clean up and the `subagents:failed` emission fires on any throw.
- [x] 3.8 Unit test `extensions/__tests__/agent.test.ts`:
   - Schema with `exposeInheritanceInTool: false` has no `isolated` field
   - Schema with `exposeInheritanceInTool: true` has optional `isolated`
   - `resolveAgentMdPath` finds project-level file, falls back to global, returns undefined for missing
   - Throttling: rapid progress events coalesce to ≤ 4/sec

## 4. Entry point — `extensions/index.ts`

- [x] 4.1 Re-export public symbols from `events.ts` and `settings.ts` (already done).
- [x] 4.2 Export the `agent.ts` activate function as the default export, matching pi's expected `ExtensionFactory` shape.
- [x] 4.3 Verify `package.json#main` and `package.json#exports` point at `./extensions/index.ts` (already does).
- [x] 4.4 Verify `package.json#pi.extensions` points at `./extensions` (already does).

## 5. README — operator-facing docs

- [x] 5.1 Scope section: foreground only, no background spawn, no get-result, no steer.
- [x] 5.2 Settings section: file location, schema, four-mode truth table, compression-is-operator-only note.
- [x] 5.3 Per-call override section showing the `isolated` parameter.
- [x] 5.4 Future-work section: cache-fork pattern, links to research.
- [x] 5.5 Wire-protocol contract section listing emission channels + `AgentDetails` field table (move from internal events.ts JSDoc to README so downstream consumers don't have to read source).

## 6. Validate the openspec change

- [x] 6.1 `openspec validate scaffold-foreground-subagent-extension --strict` — clean.
- [x] 6.2 Run any v0.1.x test suite once it exists. — `vitest run` reports **59/59 tests pass** across `settings.test.ts`, `events.test.ts`, and `agent.test.ts`.

## 7. Out-of-scope captures (no work, just clarity)

- [x] 7.1 Document in design.md: no background spawning in v0.1.x. Future work item.
- [x] 7.2 Document in design.md: no upstream prompt-cache fork in v0.1.x. Future work item.
- [x] 7.3 Document in design.md: no LLM-based summarization. Verbatim only.
- [x] 7.4 Document in design.md: tool schema is fixed at registration. `/reload` required to apply `exposeInheritanceInTool` changes.

## 9. Fix dead-on-arrival context inheritance (§2.7 shipped against the wrong API)

The currently shipped `buildInheritedContext` at `extensions/events.ts:393–394` reads parent
messages via `ctx.sessionManager.getMessages?.()`. That method does NOT exist on pi-coding-agent's
`ReadonlySessionManager` (verified against `pi-coding-agent/dist/core/session-manager.d.ts:136`),
so the optional-chained call always returns `undefined`, the array check fails, and the function
returns `""`. Inheritance is dead-on-arrival until this is fixed. See design.md Decision 9.

- [x] 9.1 In `extensions/events.ts`, replace the `getMessages?.()` access pattern with a
  `getBranch()`-based read:
  ```ts
  const sm = ctx.sessionManager;
  const branchEntries = sm?.getBranch?.() ?? [];
  // getBranch returns leaf→root; chronological order is root→leaf for compressParentContext
  const chronological = [...branchEntries].reverse();
  const messages = chronological
    .filter((e: SessionEntry) => e.type === "message")
    .map((e: SessionMessageEntry) => e.message)
    .filter(m => m.role === "user" || m.role === "assistant");
  if (messages.length === 0) return "";
  // ... feed `messages` into compressParentContext as today
  ```
- [x] 9.2 Import `SessionEntry` / `SessionMessageEntry` types from `@mariozechner/pi-coding-agent`
  (already partially imported in `extensions/index.ts`; re-use or import directly in `events.ts`).
- [x] 9.3 The defensive `?.()` optional chaining MAY stay on `sm?.getBranch?.()` so future SDK
  refactors fail soft, but the method name MUST be the real one.
- [x] 9.4 Update the function's JSDoc to remove the outdated "The exact API may differ across
  pi-coding-agent versions" disclaimer; replace with a reference to `ReadonlySessionManager` and
  the SessionEntry union.
- [x] 9.5 Verify the change against a real parent session: with `inheritContext: true` and a
  parent that has 3+ turn pairs, the subagent's effective prompt SHALL contain a
  `<parent-context>` block whose content is non-empty. Without the fix, the block is absent.
  — Smoke-tested in `extensions/__tests__/inheritance-e2e.test.ts` (3 scenarios: inherit=on,
  inherit=off, per-call isolated). A real AgentSession round-trip is deferred to live pi
  testing once the package is symlinked into `~/.pi/agent/extensions/`.
- [x] 9.6 Add unit tests in `extensions/__tests__/events.test.ts` (or wherever §2.8 lands) that
  exercise `buildInheritedContext` against a fake `ReadonlySessionManager` providing
  `getBranch()`:
  - Empty branch → returns `""`.
  - Branch with mixed `message` / `model_change` / `compaction` entries → only `message` entries
    of role user/assistant feed into compression.
  - Branch in leaf→root order is reversed before feeding into `compressParentContext` (assert
    the first user message in the output corresponds to the chronologically-earliest user turn).
  - `isolated: true` → still returns `""` without touching the session manager.
  - Missing `sessionManager` → returns `""` without throwing.
- [x] 9.7 Update README's "Context inheritance" section if it claims inheritance works today.
  Either correct the claim or add a footnote that the v0.1.1 shipped code has this bug and the
  fix lands with `extensions/agent.ts` (§3).

## 8. Follow-up changes (NOT in this scaffold)

- [ ] 8.1 (FUTURE v0.2.x) `support-upstream-prompt-cache-fork` — once pi-coding-agent exposes `createAgentSessionFromServices` or an initial-messages parameter, add Anthropic `cache_control` markers + OpenAI prefix-matching paths.
- [ ] 8.2 (FUTURE v0.2.x) `add-mtime-based-settings-invalidation` — let `inheritContext` and `inheritance.*` settings take effect without `/reload`.
- [ ] 8.3 (FUTURE) `dashboard-settings-panel-for-pi-dashboard-subagents` — UI plugin in pi-agent-dashboard that writes to this extension's config.json.
- [ ] 8.4 (FUTURE) `parallel-and-chain-spawn-modes` — if/when use cases demand it.
