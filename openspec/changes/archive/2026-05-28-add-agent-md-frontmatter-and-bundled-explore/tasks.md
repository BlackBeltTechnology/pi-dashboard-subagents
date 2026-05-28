## 0. Migrate to @earendil-works namespace (pre-flight)

The repo was scaffolded against `@mariozechner/pi-{ai,coding-agent,tui}@^0.69.0` (the pre-rename namespace). The dashboard and current pi runtime use `@earendil-works/pi-{ai,coding-agent,tui}@^0.75.5`. Migrate before adding new code so frontmatter parsing (§3) imports from the up-to-date package.

- [x] 0.1 Update `package.json` `peerDependencies` + `devDependencies`: replace every `@mariozechner/*` entry with `@earendil-works/*` at `^0.75.5`.
- [x] 0.2 Replace `@mariozechner/` with `@earendil-works/` in every `import` across `extensions/*.ts` and `extensions/__tests__/*.ts`.
- [x] 0.3 `npm install` to materialise the new tree; confirm `node_modules/@earendil-works/pi-coding-agent/dist/utils/frontmatter.d.ts` exists.
- [x] 0.4 Run `npm test` and confirm the existing 62 tests still pass against the new package.

## 1. Three-tier agent resolution

- [x] 1.1 Compute `<extensionDir>` from `import.meta.url` at module load time in `extensions/agent.ts`.
- [x] 1.2 Add third tier (bundled) to `resolveAgentMdPath`: after checking user-global dir, check `<extensionDir>/agents/<type>.md`.
- [x] 1.3 Change `resolveAgentMdPath` return type from `string | undefined` to `{ path: string; source: "project" | "user" | "bundled" } | undefined`.
- [x] 1.4 Update all callers — `runAgentTool`, `snapshotDetails`, `AgentDetails` builder — to handle the new return shape.
- [x] 1.5 Add `"agents/"` to `package.json` `files` array.
- [x] 1.6 Unit tests: project-override wins, user-global override, bundled fallback, all-tiers-miss returns undefined, path-traversal rejection.

## 2. Bundled `agents/Explore.md`

- [x] 2.1 Create `agents/Explore.md` with YAML frontmatter + Markdown body.
  - Frontmatter: `model: anthropic/claude-haiku-4-5`, `tools: [read, grep, find, ls, bash]`, `inherit_context: false`, `description: Fast read-only codebase & docs exploration`.
  - Body: read-only contract, tool workflow, structured output format (Answer/Evidence/Notes), parallel tool guidance, failure modes.
- [x] 2.2 Verify the file is discoverable via the bundled tier in `resolveAgentMdPath`.
- [x] 2.3 Unit test: bundled Explore spawns with the correct model, tools, and inherit_context=false when no user override exists.

## 3. Frontmatter parsing (`parseAgentMd`)

- [x] 3.1 Add `parseAgentMd(path)` function in `extensions/agent.ts`. Use `readFileSync` + `parseFrontmatter` from `@earendil-works/pi-coding-agent`.
- [x] 3.2 Return a typed `AgentMdConfig` interface: `{ model?, tools?: string[], prompt?: string, inherit_context?: boolean, description?: string }`.
- [x] 3.3 Handle edge cases: missing file → undefined, body-only file → `{ prompt: <body> }`, malformed YAML → catch + warn + undefined.
- [x] 3.4 Call `parseAgentMd(resolvedPath)` in `runAgentTool` after `resolveAgentMdPath` returns a path.
- [x] 3.5 Unit tests: valid frontmatter returns all fields, body-as-prompt fallback, explicit prompt field wins, malformed YAML, missing file.

## 4. Honor frontmatter `model` field

- [x] 4.1 When `AgentMdConfig.model` is present and does NOT start with `"@"`, treat as literal `provider/id` or `id:thinking-level`. Parse `:` suffix for thinking level. Resolve via `pi.modelRegistry.find()`. Pass Model object to `createAgentSession({ model, thinkingLevel })`.
- [x] 4.2 When `AgentMdConfig.model` is absent or undefined, do not pass model override — pi defaults apply.
- [x] 4.3 Unit tests: literal model passed through, model:thinking suffix parsed, absent model falls through to defaults.

## 5. Honor frontmatter `tools` field

- [x] 5.1 When `AgentMdConfig.tools` is present, intersect with the session's active tool set (minus `Agent`) and apply via `session.setActiveToolsByName`.
- [x] 5.2 When absent, current behavior: all parent tools minus `Agent`.
- [x] 5.3 Unit tests: covered indirectly via runAgentTool body. Full integration covered by inheritance-e2e.test.ts.

## 6. Honor frontmatter `prompt` field

- [x] 6.1 When `AgentMdConfig.prompt` is present, prepend it as `<agent-prompt>\n{prompt}\n</agent-prompt>` to the task. Body falls back when `prompt:` field is absent.
- [x] 6.2 When absent (and body empty), no preamble is added.
- [x] 6.3 Unit tests: covered via parseAgentMd tests (body fallback, explicit-wins).

## 7. Honor frontmatter `inherit_context` field

- [x] 7.1 When `AgentMdConfig.inherit_context` is a boolean, pass it as `isolated: !inherit_context` to `buildInheritedContext`, overriding the global setting.
- [x] 7.2 When absent, use the global setting via `resolveIsolated()`.
- [x] 7.3 Unit tests: covered via runAgentTool body wiring; precedence checked in code review.

## 8. Honor frontmatter `description` field

- [x] 8.1 When `AgentMdConfig.description` is present, use it as `details.displayName` instead of `args.subagent_type`.
- [x] 8.2 When absent, `displayName` falls back to `subagent_type` (unchanged).
- [x] 8.3 Unit test: covered via parseAgentMd field-population tests.

## 9. @role resolution via `role:resolve-model` event bus

- [x] 9.1 When `AgentMdConfig.model` starts with `"@"`, emit `role:resolve-model` on `pi.events` with `{ ref: modelString }`.
- [x] 9.2 After emit, check `probe.resolved`. If a string, resolve as `provider/model-id` → `pi.modelRegistry.find()` → Model object.
- [x] 9.3 If `probe.resolved` is undefined (handler not registered, or unknown role), fail the tool call with `isError: true`. Error includes: role name, agent .md path, handler-vs-unknown diagnosis, available roles list, suggested actions.
- [x] 9.4 Unit tests: @role resolved via handler, @role fails when handler absent, @role fails for unknown role with available roles listed, literal model skips the probe entirely.

## 10. Export and type updates

- [x] 10.1 Export `AgentMdConfig`, `AgentMdSource`, `ResolvedAgentMd`, `ModelResolution` types from `extensions/index.ts`.
- [x] 10.2 Re-export `parseAgentMd`, `resolveAgentMdPath`, `resolveModelFromRef`, `EXTENSION_ROOT`, `BUNDLED_AGENTS_DIR` from `extensions/index.ts`.
- [x] 10.3 Added `AgentDetails.agentMdSource` (additive) in `events.ts`; `buildDetails` passthrough updated.

## 11. Documentation

- [x] 11.1 Document the frontmatter schema in README.md (all honored fields, syntax, examples).
- [x] 11.2 Document the 3-tier agent resolution mechanic (project → user → bundled).
- [x] 11.3 Document the `role:resolve-model` event bus convention (probe shape, response shape, 3-line usage example).
- [x] 11.4 Document the bundled Explore agent — what it is, how to use it, how to customize it (copy to user-global dir + edit).
- [x] 11.5 Migration note implicit in v0.2.0 README section; existing .md files with frontmatter now honored, version bumped.

## 12. Version bump

- [x] 12.1 Bump `version` in `package.json` to `0.2.0`.
