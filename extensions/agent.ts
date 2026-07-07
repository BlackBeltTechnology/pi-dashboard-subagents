/**
 * pi-dashboard-subagents — Agent tool registration + spawn loop.
 *
 * Foreground subagent runs spawned via `createAgentSession` +
 * `SessionManager.inMemory(cwd)`. Per-event timeline is streamed to the
 * dashboard bridge via `pi.events.emit("subagents:*")`. The final
 * `AgentToolResult<AgentDetails>` we return is recorded inside the parent's
 * session JSONL by pi — that's how the timeline survives `/resume`.
 *
 * Scope (v0.1.x): foreground only. See proposal.md.
 *   - No background spawn
 *   - No get_subagent_result tool
 *   - No steer_subagent tool
 *   - No prompt-cache fork
 */

import { randomUUID } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { Type } from "@sinclair/typebox";

import {
  type AgentSessionEvent,
  type AgentToolResult,
  type AgentToolUpdateCallback,
  createAgentSession,
  DefaultPackageManager,
  defineTool,
  type ExtensionAPI,
  type ExtensionContext,
  getAgentDir,
  parseFrontmatter,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";

import {
  type AgentDetails,
  type AgentStatus,
  type SubagentTimelineEntry,
  type TokenUsage,
  buildDetails,
  buildInheritedContext,
  createToolCallTracker,
  emitSubagentCompleted,
  emitSubagentCreated,
  emitSubagentFailed,
  emitSubagentProgress,
  emitSubagentStarted,
  mapSessionEventToEntry,
} from "./events.js";

import {
  getInheritanceCompression,
  resolveIsolated,
  shouldExposeInheritanceInTool,
} from "./settings.js";

// ─── Tool name (also used to exclude self from subagent tool set) ────────

const AGENT_TOOL_NAME = "Agent";

// ─── Extension directory (for the bundled-agents tier) ─────────────────
//
// Computed once at module load from `import.meta.url`. Points to the
// extension's package root (the parent of `extensions/`). The bundled
// agents directory is `<EXTENSION_ROOT>/agents/`. ESM-only; the package's
// `"type": "module"` guarantees `import.meta.url` is defined.
//
// Tests may override the bundled dir via the third arg to
// `resolveAgentMdPath`; production callers omit it.

export const EXTENSION_ROOT: string = dirname(dirname(fileURLToPath(import.meta.url)));
export const BUNDLED_AGENTS_DIR: string = join(EXTENSION_ROOT, "agents");

// ─── Throttling window for progress emissions ────────────────────────────

const PROGRESS_THROTTLE_MS = 250; // → max 4 emissions/sec/subagent (§3.5)

// ─── Helpers ─────────────────────────────────────────────────────────────

/**
 * Source tier discriminator returned by `resolveAgentMdPath`. The dashboard
 * card can render this as a small badge so the operator knows which tier
 * supplied the agent definition (e.g. "Explore (bundled)" vs "Explore (user)").
 *
 * `"package"` (tier 4, added in the package-agent-discovery change) means the
 * definition came from another installed pi package's `agents/` directory; the
 * originating package `source` string is carried alongside in `ResolvedAgentMd.pkg`.
 */
export type AgentMdSource = "project" | "user" | "bundled" | "package";

/** Resolved agent .md file: the absolute path plus the tier that supplied it. */
export interface ResolvedAgentMd {
  path: string;
  source: AgentMdSource;
  /**
   * Originating package `source` string (e.g. `@acme/pi-reviewers`). Set ONLY
   * when `source === "package"`; undefined for the project/user/bundled tiers.
   */
  pkg?: string;
}

/**
 * Tier-4 package-agent discovery index: agent type (file basename minus `.md`)
 * → the absolute path of its definition plus the `source` string of the package
 * that shipped it. Built by `buildPackageAgentIndex`, cached module-side, and
 * consulted by `resolveAgentMdPath` after the project/user/bundled tiers miss.
 */
export type PackageAgentIndex = Map<string, { path: string; pkg: string }>;

/**
 * Resolve the absolute path to an agent's `.md` definition file.
 *
 * Lookup order (most-specific first; first match wins):
 *   1. `<cwd>/.pi/agents/<type>.md`        → `source: "project"`
 *   2. `<getAgentDir()>/agents/<type>.md`  → `source: "user"`
 *   3. `<EXTENSION_ROOT>/agents/<type>.md` → `source: "bundled"`
 *   4. `<installedPath>/agents/<type>.md`  → `source: "package"` (via `packageIndex`)
 *
 * The package tier (4) is consulted ONLY when tiers 1–3 all miss — no name that
 * resolves via a higher tier can be shadowed by a package agent.
 *
 * Returns `undefined` for built-in / anonymous agents that have no
 * matching `.md` at any tier.
 *
 * @param agentType    The `subagent_type` argument from the LLM.
 * @param cwd          The session's working directory (drives the project tier).
 * @param bundledDir   Optional override for the bundled tier (test seam).
 *                     Defaults to `BUNDLED_AGENTS_DIR`.
 * @param packageIndex Tier-4 discovery index. Defaults to an EMPTY Map (pure-
 *                     function test seam) so callers that omit it never consult
 *                     module state; production callers pass the cached index
 *                     from `ensurePackageAgentIndex`.
 */
export function resolveAgentMdPath(
  agentType: string,
  cwd: string,
  bundledDir: string = BUNDLED_AGENTS_DIR,
  packageIndex: PackageAgentIndex = new Map(),
): ResolvedAgentMd | undefined {
  // Defensive: reject path-traversal in the type name. The LLM controls
  // this string; we never want it to escape the agents directory. This MUST
  // short-circuit before any filesystem access or package-index lookup.
  if (!agentType || agentType.includes("/") || agentType.includes("\\") || agentType.includes("..")) {
    return undefined;
  }
  const projectPath = resolve(cwd, ".pi", "agents", `${agentType}.md`);
  if (existsSync(projectPath)) return { path: projectPath, source: "project" };
  try {
    const globalDir = getAgentDir();
    const globalPath = join(globalDir, "agents", `${agentType}.md`);
    if (existsSync(globalPath)) return { path: globalPath, source: "user" };
  } catch {
    // getAgentDir may throw in unusual contexts; treat as no global path.
  }
  const bundledPath = join(bundledDir, `${agentType}.md`);
  if (existsSync(bundledPath)) return { path: bundledPath, source: "bundled" };
  // Tier 4: package discovery index (only reached when 1–3 all missed).
  const pkgEntry = packageIndex.get(agentType);
  if (pkgEntry) return { path: pkgEntry.path, source: "package", pkg: pkgEntry.pkg };
  return undefined;
}

// ─── Package-agent discovery (tier 4) ─────────────────────────────
//
// USER-SCOPE ONLY. The installed SDK exposes no project-trust signal to
// extensions, so project-scoped packages are never indexed for agents (see
// design Decision 5). Only packages installed into `<agentDir>` (scope
// "user") — an explicit operator act — contribute spawnable agents.

/**
 * Minimal structural view of the SDK's `ConfiguredPackage` (the concrete type
 * is not re-exported from the package entry point). Only the fields discovery
 * reads are declared.
 */
interface ConfiguredPackageLike {
  source: string;
  scope: "user" | "project";
  filtered: boolean;
  installedPath?: string;
}

/**
 * Scan installed pi packages for `agents/*.md` and build the tier-4 discovery
 * index (see `PackageAgentIndex`).
 *
 * Behaviour (all defensive — this function NEVER throws):
 *   - Constructs `SettingsManager.create(cwd, agentDir)` +
 *     `new DefaultPackageManager(…)` and calls `listConfiguredPackages()` inside
 *     a try/catch; any failure (construction or listing) yields an EMPTY index.
 *   - Keeps ONLY `scope === "user"` packages (project scope is never indexed),
 *     that are not `filtered`, and that have a defined `installedPath`.
 *   - De-dupes by `source` (a source listed twice collapses to one logical
 *     package — no spurious self-collision warning).
 *   - Scans packages in a stable order (ascending by `source`); the first
 *     package to claim a given basename wins. A later duplicate from a
 *     DIFFERENT source is dropped and logged to stderr naming both sources.
 *   - A missing/unreadable `agents/` dir or a non-`.md` entry is skipped
 *     silently.
 *
 * @param cwd      The session working directory (drives project-settings load).
 * @param agentDir The user agent dir (`getAgentDir()` in production).
 */
export function buildPackageAgentIndex(cwd: string, agentDir: string): PackageAgentIndex {
  const index: PackageAgentIndex = new Map();

  let packages: ConfiguredPackageLike[];
  try {
    const settingsManager = SettingsManager.create(cwd, agentDir);
    const pm = new DefaultPackageManager({ cwd, agentDir, settingsManager });
    packages = pm.listConfiguredPackages() as ConfiguredPackageLike[];
  } catch (err) {
    console.warn(
      "[pi-dashboard-subagents] Package-agent discovery skipped (package manager unavailable):",
      err instanceof Error ? err.message : err,
    );
    return index;
  }

  // User-scope only + drop filtered + require an installed path on disk.
  const eligible = (packages ?? []).filter(
    (p): p is ConfiguredPackageLike & { installedPath: string } =>
      !!p && p.scope === "user" && !p.filtered && typeof p.installedPath === "string" && p.installedPath.length > 0,
  );

  // De-dupe by source (keep first); a source listed twice is one package.
  const bySource = new Map<string, ConfiguredPackageLike & { installedPath: string }>();
  for (const p of eligible) {
    if (!bySource.has(p.source)) bySource.set(p.source, p);
  }

  // Stable cross-package order for deterministic collision winners.
  const ordered = [...bySource.values()].sort((a, b) =>
    a.source < b.source ? -1 : a.source > b.source ? 1 : 0,
  );

  for (const pkg of ordered) {
    let entries: string[];
    try {
      entries = readdirSync(join(pkg.installedPath, "agents"));
    } catch {
      continue; // no agents/ dir, unreadable, or not a directory — skip
    }
    for (const entry of entries) {
      if (!entry.endsWith(".md")) continue;
      const type = entry.slice(0, -3);
      if (!type) continue;
      const path = join(pkg.installedPath, "agents", entry);
      const existing = index.get(type);
      if (existing) {
        if (existing.pkg !== pkg.source) {
          console.warn(
            `[pi-dashboard-subagents] Agent "${type}" is shipped by multiple packages; ` +
              `keeping "${existing.pkg}" (${existing.path}), dropping "${pkg.source}" (${path}).`,
          );
        }
        continue; // first match wins
      }
      index.set(type, { path, pkg: pkg.source });
    }
  }
  return index;
}

// Module-level cache, keyed by the cwd it was built for. Rebuilt on a cwd
// change (in-process session switch) or a `resources_discover` reload.
let packageAgentIndex: PackageAgentIndex | undefined;
let indexedCwd: string | undefined;

/**
 * Rebuild the cached package-agent index unconditionally for `cwd` and return
 * it. Called from the `resources_discover` handler (startup + reload).
 */
export function refreshPackageAgentIndex(cwd: string, agentDir: string): PackageAgentIndex {
  packageAgentIndex = buildPackageAgentIndex(cwd, agentDir);
  indexedCwd = cwd;
  return packageAgentIndex;
}

/**
 * Return the cached package-agent index, building it lazily when unbuilt or
 * when `cwd` has changed since the last build (so an in-process cwd switch
 * rebuilds rather than serving stale results). Used as the first-spawn
 * fallback for hosts that never fire `resources_discover`.
 */
export function ensurePackageAgentIndex(cwd: string, agentDir: string): PackageAgentIndex {
  if (!packageAgentIndex || cwd !== indexedCwd) {
    return refreshPackageAgentIndex(cwd, agentDir);
  }
  return packageAgentIndex;
}

// ─── Agent .md frontmatter parsing ─────────────────────────────────────
//
// Parses YAML frontmatter from the `.md` file at the resolved path. Backed
// by pi-coding-agent's `parseFrontmatter` (same parser pi uses for prompt
// templates and skills). Returns `undefined` on missing file, empty
// frontmatter, or malformed YAML — so the spawn loop can fall through to
// current defaults without crashing.

/**
 * Strongly-typed view of the YAML frontmatter we honour in agent `.md` files.
 * Each field is optional; an absent field MUST leave the corresponding
 * subagent behaviour at its pre-frontmatter default.
 */
export interface AgentMdConfig {
  /**
   * Model reference. Four accepted shapes (resolved in order by the handler):
   *   • `"@role"`                    role alias (handler-only; needs a
   *                                   `model:resolve` listener — typically
   *                                   pi-agent-dashboard or pi-flows).
   *   • `"provider/model-id"`        literal
   *   • `"provider/model-id:level"`  literal with thinking suffix
   *   • `"model-id"`                 bare; "like" query — first registry
   *                                   entry whose `m.id === ref` wins.
   * Absent / empty → inherit parent default.
   */
  model?: string;
  /** Allowlist of tool names. Absent → all parent tools minus `Agent`. */
  tools?: string[];
  /** System-prompt preamble prepended to pi's default. Absent → pi default. */
  prompt?: string;
  /** Per-agent override of the global `inheritContext` setting. */
  inherit_context?: boolean;
  /** Display-name override for the dashboard card. Absent → falls back to `subagent_type`. */
  description?: string;
}

/**
 * Read and parse the frontmatter of an agent `.md` file.
 *
 * Returns `undefined` when:
 *   • the file does not exist
 *   • the file has no `---\n...\n---` frontmatter block
 *   • the frontmatter contains no honoured field (every field is undefined)
 *   • reading or parsing throws (malformed YAML, permission errors, etc.)
 *
 * Errors are logged to stderr but never re-thrown — the spawn loop must keep
 * working with current defaults when an `.md` is broken.
 */
export function parseAgentMd(path: string): AgentMdConfig | undefined {
  let raw: string;
  try {
    raw = readFileSync(path, "utf-8");
  } catch {
    return undefined; // missing file or unreadable — treat as no config
  }
  let frontmatter: Record<string, unknown>;
  let body = "";
  try {
    const parsed = parseFrontmatter<Record<string, unknown>>(raw);
    frontmatter = parsed.frontmatter;
    body = parsed.body ?? "";
  } catch (err) {
    console.warn(
      `[pi-dashboard-subagents] Malformed YAML frontmatter in ${path}:`,
      err instanceof Error ? err.message : err,
    );
    return undefined;
  }
  if (!frontmatter || typeof frontmatter !== "object") frontmatter = {};

  const cfg: AgentMdConfig = {};
  if (typeof frontmatter.model === "string" && frontmatter.model.trim() !== "") {
    cfg.model = frontmatter.model.trim();
  }
  if (Array.isArray(frontmatter.tools)) {
    const tools = frontmatter.tools.filter((t): t is string => typeof t === "string" && t.trim() !== "");
    if (tools.length > 0) cfg.tools = tools;
  }
  // `prompt:` field takes precedence; otherwise fall back to the markdown
  // body. The body convention matches Claude Code's agent.md format and
  // pi-coding-agent's own prompt templates / skills (where the frontmatter
  // holds metadata and the body holds the actual content). The explicit
  // field is preserved so power users can ship a .md whose body is human
  // documentation distinct from the model-facing prompt.
  if (typeof frontmatter.prompt === "string" && frontmatter.prompt.trim() !== "") {
    cfg.prompt = frontmatter.prompt;
  } else if (body.trim() !== "") {
    cfg.prompt = body.trim();
  }
  if (typeof frontmatter.inherit_context === "boolean") {
    cfg.inherit_context = frontmatter.inherit_context;
  }
  if (typeof frontmatter.description === "string" && frontmatter.description.trim() !== "") {
    cfg.description = frontmatter.description.trim();
  }
  // An empty config (no recognised field, no body) is functionally
  // equivalent to no config — the caller will fall through to defaults
  // either way. Return `undefined` to keep call sites' nullish-coalescing
  // terse.
  return Object.keys(cfg).length > 0 ? cfg : undefined;
}

/**
 * Throttled wrapper around `emitSubagentProgress`. Coalesces updates within
 * a fixed window. `flush()` always sends the latest state regardless of
 * throttle window — call before `completed`/`failed` so the dashboard sees
 * the final snapshot.
 */
export function createProgressEmitter(
  pi: ExtensionAPI,
  agentId: string,
  windowMs: number = PROGRESS_THROTTLE_MS,
): {
  schedule(details: AgentDetails): void;
  flush(): void;
  dispose(): void;
} {
  let pending: AgentDetails | undefined;
  let lastEmitAt = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;

  function emitNow(details: AgentDetails): void {
    lastEmitAt = Date.now();
    pending = undefined;
    if (timer) {
      clearTimeout(timer);
      timer = undefined;
    }
    emitSubagentProgress(pi, { agentId, details });
  }

  return {
    schedule(details: AgentDetails) {
      pending = details;
      const elapsed = Date.now() - lastEmitAt;
      if (elapsed >= windowMs) {
        emitNow(details);
        return;
      }
      if (timer) return; // already scheduled
      timer = setTimeout(() => {
        timer = undefined;
        if (pending) emitNow(pending);
      }, windowMs - elapsed);
    },
    flush() {
      if (pending) emitNow(pending);
      else if (timer) {
        clearTimeout(timer);
        timer = undefined;
      }
    },
    dispose() {
      pending = undefined;
      if (timer) {
        clearTimeout(timer);
        timer = undefined;
      }
    },
  };
}

/**
 * Accumulate token usage across `message_end` events.
 * Reads `message.usage` per pi-ai's Usage shape.
 */
export function createUsageAccumulator(): {
  observe(event: AgentSessionEvent): void;
  totals(): TokenUsage;
} {
  let input = 0;
  let output = 0;
  let total = 0;
  return {
    observe(event: AgentSessionEvent) {
      if (event.type !== "message_end") return;
      const usage = (event.message as { usage?: { input?: number; output?: number; totalTokens?: number } }).usage;
      if (!usage) return;
      input += usage.input ?? 0;
      output += usage.output ?? 0;
      total = usage.totalTokens ?? input + output;
    },
    totals() {
      return { input, output, total };
    },
  };
}

/**
 * Derive a short human-readable activity string from a session event.
 * Returns null when the event doesn't change the activity line.
 */
function activityFromEvent(event: AgentSessionEvent): string | null | undefined {
  if (event.type === "tool_execution_start") {
    return `running ${event.toolName}`;
  }
  if (event.type === "tool_execution_end") {
    return null; // clear activity
  }
  if (event.type === "message_update") {
    const e = event.assistantMessageEvent;
    if (e.type === "thinking_start") return "thinking";
    if (e.type === "text_start") return "writing";
  }
  return undefined; // no change
}

// ─── Model reference resolution ───────────────────────────────────────────
//
// Maps a frontmatter `model:` string to a concrete `Model<any>` object
// the SDK can pass to `createAgentSession`. Three accepted input shapes:
//
// Resolution path: primary (event-bus) → fallback (in-process registry).
//
//   PRIMARY  pi.events.emit("model:resolve", probe)
//            Handler (typically in pi-agent-dashboard or pi-flows)
//            consumes any of three forms — `@role`, `provider/id`, bare
//            `id` — and fills `probe.model` + `probe.thinkingLevel` +
//            `probe.resolved` + `probe.auth`. On miss it fills
//            `probe.error` (and may fill `probe.available` as a hint).
//
//   FALLBACK Used only when the emit returns with BOTH `probe.model` and
//            `probe.error` unset (silent emit — no handler reacted).
//            Handles two forms via `pi.modelRegistry` directly:
//              • `"provider/id[:thk]"` → `registry.find(provider, id)`
//              • bare `id[:thk]`       → `registry.getAll().find(m=>m.id===id)`
//            Does NOT handle `@role` (no providers.json access here — that
//            policy is owned by the dashboard/flows handler).
//
// Errors are returned as `{ error, ... }` instead of thrown so the caller
// can decide whether to fail the tool call hard (the design says yes for
// any resolution failure) or to fall back to the parent default (no
// model field at all).

import type { Model } from "@earendil-works/pi-ai";

type ThinkingLevelString = "minimal" | "low" | "medium" | "high" | "xhigh" | "off";
const VALID_THINKING_LEVELS: readonly ThinkingLevelString[] = [
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "off",
];

export interface ModelResolution {
  /** Resolved Model object (when successful). */
  model?: Model<any>;
  /** Thinking-level suffix extracted from the reference (when present). */
  thinkingLevel?: ThinkingLevelString;
  /** Human-readable error message (when the reference could not be resolved). */
  error?: string;
}

/**
 * Shape of the cooperative probe payload emitted on the `model:resolve`
 * event. Handlers MUST follow the early-return idiom:
 *
 *   pi.events.on("model:resolve", (probe) => {
 *     if (probe.model) return;             // someone else handled it
 *     // … attempt resolution …
 *     if (success) {
 *       probe.resolved = "provider/id";    // canonical literal
 *       probe.model = m;                   // Model object
 *       probe.thinkingLevel = thk;         // optional
 *       probe.auth = a;                    // optional
 *     } else {
 *       probe.error ??= reason;            // first error sticks
 *       probe.available ??= hint;          // optional diagnostics
 *     }
 *   });
 *
 * The emitter checks `probe.model` first, then `probe.error`. When both
 * are unset the emit is treated as silent (no handler) and the in-process
 * fallback runs.
 */
export interface ModelResolveProbe {
  /** Input — the raw frontmatter string. */
  ref: string;
  /** Output — canonical literal "provider/model-id" (no thinking suffix). */
  resolved?: string;
  /** Output — the resolved Model object. */
  model?: Model<any>;
  /** Output — thinking-level parsed off the suffix, if any. */
  thinkingLevel?: ThinkingLevelString;
  /** Output — optional auth resolution (handler-defined shape). */
  auth?: { ok?: boolean; error?: string; [k: string]: unknown };
  /** Output — human-readable error when resolution fails. */
  error?: string;
  /** Output — diagnostics on failure: known roles / known model ids. */
  available?: {
    roles?: Record<string, string>;
    models?: string[];
  };
}

/**
 * Split a `"provider/id"` or `"provider/id:level"` reference into its parts.
 * The thinking level suffix is the substring AFTER the LAST `:` only when
 * it matches a known thinking level (case-insensitive). Anything else after
 * `:` is treated as part of the model id (so model ids containing `:` for
 * non-thinking reasons still resolve).
 */
function splitModelRef(ref: string): {
  provider: string | undefined;
  modelId: string;
  thinkingLevel: ThinkingLevelString | undefined;
} {
  let working = ref;
  let thinkingLevel: ThinkingLevelString | undefined;
  const lastColon = working.lastIndexOf(":");
  if (lastColon > 0) {
    const suffix = working.slice(lastColon + 1).toLowerCase() as ThinkingLevelString;
    if (VALID_THINKING_LEVELS.includes(suffix)) {
      thinkingLevel = suffix;
      working = working.slice(0, lastColon);
    }
  }
  const firstSlash = working.indexOf("/");
  if (firstSlash <= 0) {
    return { provider: undefined, modelId: working, thinkingLevel };
  }
  return {
    provider: working.slice(0, firstSlash),
    modelId: working.slice(firstSlash + 1),
    thinkingLevel,
  };
}

/** Internal: shape of `pi.modelRegistry` we actually use. Keeps the cast
 *  centralized; the SDK doesn't declare modelRegistry on ExtensionAPI yet. */
interface ModelRegistryShape {
  find?: (provider: string, id: string) => Model<any> | undefined;
  getAll?: () => Array<Model<any> & { id: string; provider?: string }>;
}

function getModelRegistry(pi: ExtensionAPI): ModelRegistryShape | undefined {
  const reg = (pi as unknown as { modelRegistry?: ModelRegistryShape }).modelRegistry;
  return reg && (typeof reg.find === "function" || typeof reg.getAll === "function")
    ? reg
    : undefined;
}

/** Cap on the size of the `available.models` hint baked into error
 *  messages. Twenty ids is plenty for a human to spot a typo without
 *  swamping the tool-result string. */
const AVAILABLE_MODELS_HINT_CAP = 20;

/**
 * Resolve a frontmatter `model:` reference to a concrete Model object.
 *
 * Primary path: emit `model:resolve` and let a handler answer.
 * Fallback path: in-process resolution via `pi.modelRegistry` for the two
 * literal forms (`provider/id`, bare `id`). `@role` requires a handler.
 *
 * @param pi          ExtensionAPI handle (events + modelRegistry).
 * @param ref         Raw frontmatter string (`@fast` | `anthropic/opus` | `opus` | `…:high`).
 * @param agentMdPath Resolved agent .md path — included in error messages so the operator
 *                    knows which file specified the unresolvable reference.
 */
export function resolveModelFromRef(
  pi: ExtensionAPI,
  ref: string,
  agentMdPath: string | undefined,
): ModelResolution {
  const trimmed = ref.trim();
  if (!trimmed) return { error: "Empty model reference." };

  // ============== PRIMARY: model:resolve event bus ==============
  if (pi.events) {
    const probe: ModelResolveProbe = { ref: trimmed };
    try {
      pi.events.emit("model:resolve", probe);
    } catch (err) {
      // Handler threw — treat as a hard failure (handler bug).
      return {
        error:
          `"model:resolve" handler threw while resolving "${ref}": ` +
          `${err instanceof Error ? err.message : String(err)}.` +
          mdPathLine(agentMdPath),
      };
    }
    if (probe.model) {
      return { model: probe.model, thinkingLevel: probe.thinkingLevel };
    }
    if (typeof probe.error === "string" && probe.error.length > 0) {
      // Handler ran but rejected the ref — surface its error verbatim and
      // append diagnostics + the agent md path so the operator can act.
      return {
        error:
          probe.error +
          formatAvailable(probe.available) +
          mdPathLine(agentMdPath),
      };
    }
    // Silent emit (no handler, or handler chose not to fill anything) —
    // fall through to in-process fallback.
  }

  // ============== FALLBACK: in-process registry =================
  // The fallback intentionally does NOT read `~/.pi/agent/providers.json`
  // — role storage policy belongs to the handler. `@role` fails here.
  if (trimmed.startsWith("@")) {
    return {
      error:
        `Cannot resolve role "${ref}": no "model:resolve" handler is registered.\n` +
        `Role aliasing requires pi-agent-dashboard (or pi-flows with the optional ` +
        `model:resolve handler) to be loaded.\n` +
        `Fix: install/enable pi-agent-dashboard or pi-flows, or replace the ` +
        `"@role" reference with a literal "provider/model-id" or bare model id.` +
        mdPathLine(agentMdPath),
    };
  }

  const registry = getModelRegistry(pi);
  if (!registry) {
    return {
      error:
        `Model registry unavailable on pi.modelRegistry — cannot resolve "${ref}".` +
        mdPathLine(agentMdPath),
    };
  }

  // Parse the thinking suffix before any lookup. `splitModelRef` is
  // tolerant: when there's no `/` it returns provider=undefined, modelId=
  // the bare literal. We use that to dispatch between find() and getAll().
  const { provider, modelId, thinkingLevel } = splitModelRef(trimmed);

  let model: Model<any> | undefined;
  if (provider) {
    // provider/model[:thk] form
    if (typeof registry.find === "function") {
      model = registry.find(provider, modelId);
    }
    if (!model) {
      return {
        error:
          `Model "${provider}/${modelId}" is not registered or not authenticated.\n` +
          `Resolved from "${ref}".\n` +
          `Run \`/provider\` or check ~/.pi/agent/auth.json.` +
          mdPathLine(agentMdPath),
      };
    }
  } else {
    // Bare-id "like" query. First match in registry.getAll() iteration
    // order wins. Operators wanting determinism should use the provider/
    // form.
    const all = typeof registry.getAll === "function" ? registry.getAll() : [];
    model = all.find((m) => m && m.id === modelId);
    if (!model) {
      const hint = all
        .map((m) => m && m.id)
        .filter((s): s is string => typeof s === "string" && s.length > 0)
        .slice(0, AVAILABLE_MODELS_HINT_CAP);
      return {
        error:
          `No model matched "${ref}" via bare-id lookup.\n` +
          `Try the explicit "provider/model-id" form, or pick from the registered models.` +
          (hint.length > 0 ? `\nAvailable model ids: ${hint.join(", ")}` : "") +
          mdPathLine(agentMdPath),
      };
    }
  }

  return { model, thinkingLevel };
}

/** Internal: format the standard "\nAgent definition: <path>" footer. */
function mdPathLine(p: string | undefined): string {
  return p ? `\nAgent definition: ${p}` : "";
}

/** Internal: render `probe.available` as a multi-line hint block. */
function formatAvailable(av: ModelResolveProbe["available"]): string {
  if (!av) return "";
  const parts: string[] = [];
  if (av.roles && typeof av.roles === "object") {
    const roleNames = Object.keys(av.roles).sort();
    if (roleNames.length > 0) {
      parts.push(`Available roles: ${roleNames.map((r) => `@${r}`).join(", ")}`);
    }
  }
  if (Array.isArray(av.models) && av.models.length > 0) {
    const ids = av.models.slice(0, AVAILABLE_MODELS_HINT_CAP);
    parts.push(`Available model ids: ${ids.join(", ")}`);
  }
  return parts.length > 0 ? `\n${parts.join("\n")}` : "";
}

// ─── Effective model-ref selection (precedence: args > config) ────────

export interface EffectiveModelRef {
  /** The chosen ref string, or undefined if neither source had a non-empty value. */
  ref: string | undefined;
  /** Which source the ref came from — informs error message attribution. */
  source: "args" | "config" | "none";
}

/**
 * Apply the precedence rule for model resolution: tool-call `args.model`
 * wins over `agentConfig.model` when both are non-empty (after trimming).
 * Empty / whitespace-only values are treated as absent so a buggy caller
 * sending `model: ""` doesn't shadow a real `.md` value.
 *
 * Spec: agent-md-frontmatter "Frontmatter `model` field SHALL drive subagent
 * model selection" (precedence rule).
 */
export function selectEffectiveModelRef(
  argsModel: string | undefined,
  configModel: string | undefined,
): EffectiveModelRef {
  const a = typeof argsModel === "string" ? argsModel.trim() : "";
  const c = typeof configModel === "string" ? configModel.trim() : "";
  if (a.length > 0) return { ref: a, source: "args" };
  if (c.length > 0) return { ref: c, source: "config" };
  return { ref: undefined, source: "none" };
}

// ─── Schema (conditional on exposeInheritanceInTool) ─────────────────────

/**
 * Build the TypeBox parameters schema for the Agent tool. The `isolated`
 * field is included only when `exposeInheritanceInTool` is true at
 * activation time. Schema is fixed for the lifetime of the extension run
 * (pi.registerTool has no unregister counterpart — see design.md Decision 6).
 */
export function buildAgentParametersSchema(exposeIsolated: boolean) {
  const base = {
    subagent_type: Type.String({
      description:
        "Agent type label. If it matches an `.md` in ./.pi/agents/<type>.md or ~/.pi/agent/agents/<type>.md, that file's frontmatter supplies model/tools/prompt defaults. Otherwise any label works — spawn runs with parent defaults (override via `model` below).",
    }),
    description: Type.String({
      description: "Short human-readable description of the task (5–10 words).",
    }),
    prompt: Type.String({
      description: "The full task prompt for the subagent.",
    }),
    // Per-call model override. Accepts the same three forms as the .md
    // `model:` frontmatter field, resolved through the IDENTICAL
    // `resolveModelFromRef` mechanism. Wins over `.md` model when both are
    // present. See spec subagent-emission, capability "`args.model` SHALL be
    // resolved via the same `resolveModelFromRef` mechanism as `agentConfig.model`".
    model: Type.Optional(
      Type.String({
        description:
          'Optional model override. Accepts "@role" (e.g. "@fast"), "provider/model-id[:thinking]" (e.g. "anthropic/claude-haiku-4-5:high"), or bare "model-id". Overrides the agent .md `model:` field when both are present. Omit to use the .md value, or to inherit the parent default when no .md matches.',
      }),
    ),
  };
  if (!exposeIsolated) {
    return Type.Object(base);
  }
  return Type.Object({
    ...base,
    isolated: Type.Optional(
      Type.Boolean({
        description:
          "When true, the subagent runs WITHOUT inheriting parent context. Defaults to the global setting.",
      }),
    ),
  });
}

// ─── Tool definition ─────────────────────────────────────────────────────

interface AgentToolArgs {
  subagent_type: string;
  description: string;
  prompt: string;
  /**
   * Optional per-call model override. Accepts the same three forms as
   * frontmatter `model:` ("@role", "provider/model[:thinking]", bare
   * "model-id"). When non-empty, takes precedence over `agentConfig.model`.
   * Empty / whitespace strings are treated as absent.
   */
  model?: string;
  isolated?: boolean;
}

function makeAgentTool(exposeIsolated: boolean) {
  return defineTool({
    name: AGENT_TOOL_NAME,
    label: "Agent",
    description: [
      "Spawn a foreground subagent in-memory with a focused task.",
      "Runs synchronously; returns when the subagent finishes.",
      "Two modes: (1) curated — when `subagent_type` matches a project/user/bundled `.md`, that file's frontmatter supplies model/tools/prompt defaults; (2) inline — any label works without a `.md`; pass `model` to pick @role / provider/model / bare id at call time.",
      "Subagent's full timeline (tool calls, reasoning, assistant text) is",
      "streamed to the dashboard inspector and embedded in the returned result.",
    ].join(" "),
    parameters: buildAgentParametersSchema(exposeIsolated),

    async execute(
      _toolCallId: string,
      params: AgentToolArgs,
      signal: AbortSignal | undefined,
      onUpdate: AgentToolUpdateCallback<AgentDetails> | undefined,
      ctx: ExtensionContext,
    ): Promise<AgentToolResult<AgentDetails>> {
      return runAgentTool(ctx.cwd, params, signal, onUpdate, ctx, getPi()) as Promise<AgentToolResult<AgentDetails>>;
    },
  });
}

// ─── pi handle captured at activate() time ───────────────────────────────
//
// The tool's `execute` callback receives `ctx: ExtensionContext` but NOT the
// `pi: ExtensionAPI` handle. We capture `pi` in a module-level closure at
// activation so emit helpers can reach it.

let capturedPi: ExtensionAPI | undefined;

function getPi(): ExtensionAPI {
  if (!capturedPi) {
    throw new Error("pi-dashboard-subagents: Agent tool invoked before activate() captured pi handle");
  }
  return capturedPi;
}

// ─── The main spawn loop ────────────────────────────────────────────────

export async function runAgentTool(
  cwd: string,
  args: AgentToolArgs,
  signal: AbortSignal | undefined,
  onUpdate: AgentToolUpdateCallback<AgentDetails> | undefined,
  ctx: ExtensionContext,
  pi: ExtensionAPI,
): Promise<AgentToolResultWithError<AgentDetails>> {
  const agentId = randomUUID();
  const startedAt = Date.now();

  // ── Resolve the agent .md (4-tier: project → user → bundled → package) ──
  // Ensure the package discovery index is built (fallback for hosts that never
  // fire `resources_discover`, and the cwd-change rebuild path). Best-effort:
  // a failed/empty index must never block the spawn.
  let pkgIndex: PackageAgentIndex | undefined;
  try {
    pkgIndex = ensurePackageAgentIndex(cwd, getAgentDir());
  } catch {
    // Discovery unavailable — resolve without tier 4 (undefined → empty Map).
  }
  const resolvedMd = resolveAgentMdPath(args.subagent_type, cwd, BUNDLED_AGENTS_DIR, pkgIndex);
  const agentMdPath = resolvedMd?.path;
  const agentMdSource = resolvedMd?.source;
  const agentMdPkg = resolvedMd?.pkg;

  // ── Parse frontmatter from the resolved .md (or undefined if none) ──
  // Undefined on missing file, empty frontmatter, or malformed YAML.
  const agentConfig = agentMdPath ? parseAgentMd(agentMdPath) : undefined;

  // ── displayName: prefer frontmatter description, else subagent_type ──
  const displayName = agentConfig?.description ?? args.subagent_type;

  const entries: SubagentTimelineEntry[] = [];
  let toolUses = 0;
  let turnCount = 0;
  let activity: string | undefined;
  let modelName: string | undefined;

  const tracker = createToolCallTracker();
  const usage = createUsageAccumulator();
  const progress = createProgressEmitter(pi, agentId);

  let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
  let unsubscribe: (() => void) | undefined;
  let abortHandler: (() => void) | undefined;

  function snapshotDetails(status: AgentStatus, error?: string): AgentDetails {
    return buildDetails({
      agentId,
      displayName,
      description: args.description,
      subagentType: args.subagent_type,
      status,
      activity,
      entries: entries.slice(),
      toolUses,
      tokensTotal: usage.totals().total,
      tokensUsage: usage.totals(),
      turnCount,
      startedAt,
      modelName,
      agentMdPath,
      agentMdSource,
      agentMdPkg,
      error,
    });
  }

  function pushUpdate(status: AgentStatus): void {
    const details = snapshotDetails(status);
    progress.schedule(details);
    if (onUpdate) {
      onUpdate({
        content: [{ type: "text", text: activity ?? "(running…)" }],
        details,
      });
    }
  }

  // Emit created BEFORE we touch any other infrastructure so the dashboard
  // gets a card on screen as fast as possible.
  const initialDetails = snapshotDetails("queued");
  emitSubagentCreated(pi, {
    agentId,
    type: args.subagent_type,
    description: args.description,
    details: initialDetails,
  });

  try {
    // ── Effective model ref: tool-call `args.model` > .md frontmatter ──
    // Per spec agent-md-frontmatter precedence rule + spec subagent-emission
    // "Tool-call `args.model` SHALL take precedence over `agentConfig.model`".
    const { ref: effectiveModelRef, source: modelRefOrigin } = selectEffectiveModelRef(
      args.model,
      agentConfig?.model,
    );
    // Source label for error messages: synthetic for tool-call refs, real
    // path for frontmatter refs. Helps operators trace bad refs.
    const modelRefSource: string | undefined =
      modelRefOrigin === "args"
        ? "(tool-call argument)"
        : (modelRefOrigin === "config" ? agentMdPath : undefined);

    // ── Resolve before touching the session ──
    // Resolving up-front lets us fail the tool call cleanly (errorResult)
    // when @role can't be resolved, BEFORE we allocate session resources.
    let resolvedModel: Model<any> | undefined;
    let resolvedThinkingLevel: ThinkingLevelString | undefined;
    if (effectiveModelRef) {
      const resolution = resolveModelFromRef(pi, effectiveModelRef, modelRefSource);
      if (resolution.error || !resolution.model) {
        // Hard failure: see design Decision 3 of `add-model-resolve-event-
        // with-fallback`. Don't silently fall back to the parent default —
        // the caller (tool-call OR .md author) explicitly requested this
        // model.
        const failedDetails = snapshotDetails("error", resolution.error);
        emitSubagentFailed(pi, {
          agentId,
          error: resolution.error ?? "Model resolution failed",
          durationMs: Date.now() - startedAt,
          toolUses,
          details: failedDetails,
        });
        return errorResult(
          resolution.error ?? `Could not resolve model reference "${effectiveModelRef}".`,
          failedDetails,
        );
      }
      resolvedModel = resolution.model;
      resolvedThinkingLevel = resolution.thinkingLevel;
    }

    // ── Effective inheritance: frontmatter overrides global setting ──
    // Per design Decision 5: per-agent `inherit_context` wins over the
    // operator-level `inheritContext` config. Per-call `isolated` (LLM)
    // wins over both when `exposeInheritanceInTool` is on — that's already
    // handled by `resolveIsolated`.
    const isolated =
      typeof agentConfig?.inherit_context === "boolean"
        ? !agentConfig.inherit_context
        : resolveIsolated(args.isolated);
    const inheritanceOpts = isolated
      ? { isolated: true as const }
      : { isolated: false as const, ...getInheritanceCompression() };
    const inherited = buildInheritedContext(ctx, inheritanceOpts);

    // ── Effective task prompt: parent-context prefix + agent-prompt preamble ──
    // The .md's `prompt:` block is wrapped in an `<agent-prompt>` block so
    // it sits visually distinct from pi's default system prompt and the
    // inherited parent context. Order: parent-context → task-prompt-preamble → task.
    // Note: the agent-prompt prepends to the SUBAGENT'S effective user-side
    // prompt, not to pi's built-in system prompt template — we have no SDK
    // hook to inject into the system prompt directly. This still gives the
    // subagent strong steering: it appears as the very first thing in the
    // assistant's instructions and pi's default system prompt sits underneath.
    const promptSections: string[] = [];
    if (inherited) promptSections.push(inherited);
    if (agentConfig?.prompt) {
      promptSections.push(`<agent-prompt>\n${agentConfig.prompt}\n</agent-prompt>`);
    }
    promptSections.push(`<task>\n${args.prompt}\n</task>`);
    const effectivePrompt = promptSections.join("\n\n");

    // ── Construct in-memory subagent session ──
    const sessionManager = SessionManager.inMemory(cwd);
    const createResult = await createAgentSession({
      cwd,
      sessionManager,
      ...(resolvedModel ? { model: resolvedModel } : {}),
      ...(resolvedThinkingLevel && resolvedThinkingLevel !== "off"
        ? { thinkingLevel: resolvedThinkingLevel }
        : {}),
    });
    session = createResult.session;
    modelName = session.model?.id;

    // ── Tool allowlist ──
    // Always strip the `Agent` tool to prevent recursive nesting. When
    // frontmatter provides a `tools:` allowlist, intersect it with the
    // session's active tool set (so unknown names in the allowlist are
    // silently dropped — a typo doesn't crash the spawn) and apply via
    // `setActiveToolsByName`. Otherwise keep every tool the parent has
    // except `Agent` (unchanged pre-frontmatter behavior).
    const availableTools = session.getActiveToolNames().filter((n) => n !== AGENT_TOOL_NAME);
    const activeTools = agentConfig?.tools
      ? availableTools.filter((n) => agentConfig.tools!.includes(n))
      : availableTools;
    session.setActiveToolsByName(activeTools);

    // ── Subscribe to events and accumulate the timeline ──
    //
    // Important: call `tracker.onEvent(event)` EXACTLY ONCE per event.
    // It is destructive on `tool_execution_end` (deletes the pairing entry).
    unsubscribe = session.subscribe((event: AgentSessionEvent) => {
      usage.observe(event);
      const pairing = tracker.onEvent(event); // null on non-tool, { input } on end
      const newActivity = activityFromEvent(event);
      if (newActivity !== undefined) activity = newActivity ?? undefined;

      if (event.type === "tool_execution_end") {
        const entry = mapSessionEventToEntry(event);
        if (entry && entry.kind === "tool") {
          entry.input = pairing?.input;
          entries.push(entry);
          toolUses += 1;
        }
      } else if (event.type === "message_update") {
        const entry = mapSessionEventToEntry(event);
        if (entry) entries.push(entry);
      } else if (event.type === "message_end") {
        const msg = event.message as { role: string; content?: unknown };
        if (msg.role === "assistant") {
          turnCount += 1;
          // Backfill text / thinking entries from message_end content blocks
          // when streaming `text_end` / `thinking_end` events were NOT
          // emitted. Some providers (e.g. DeepSeek non-streaming responses)
          // deliver the entire assistant message in `message_end` only,
          // never firing the streaming end events. Without this backfill
          // the timeline shows only tools + reasoning, never assistant
          // text — and `lastAssistantText(entries)` returns undefined,
          // making the final result `"(no output)"`.
          //
          // Mirror of the same pattern in pi-flows' execution.ts.
          if (Array.isArray(msg.content)) {
            // Detect whether the streaming events already pushed these
            // blocks: walk back through entries and count how many
            // contiguous text/thinking entries match the suffix of the
            // message content. If the streaming path already added them,
            // skip the backfill to avoid duplicates.
            const textBlocks = msg.content.filter(
              (b: { type?: string }) => b && (b.type === "text" || b.type === "thinking"),
            ) as Array<{ type: string; text?: string; thinking?: string; redacted?: boolean }>;
            // Count contiguous trailing text/thinking entries (excluding tool/error).
            let trailingNonToolCount = 0;
            for (let i = entries.length - 1; i >= 0; i--) {
              const e = entries[i];
              if (e && (e.kind === "text" || e.kind === "thinking")) trailingNonToolCount++;
              else break;
            }
            if (trailingNonToolCount < textBlocks.length) {
              const now = Date.now();
              for (const block of textBlocks.slice(trailingNonToolCount)) {
                if (block.type === "text" && typeof block.text === "string" && block.text) {
                  entries.push({ kind: "text", text: block.text, ts: now });
                } else if (
                  block.type === "thinking" &&
                  typeof block.thinking === "string" &&
                  block.thinking &&
                  !block.redacted
                ) {
                  entries.push({ kind: "thinking", text: block.thinking, ts: now });
                }
              }
            }
          }
        }
      }

      pushUpdate("running");
    });

    // ── Wire parent abort to subagent ──
    if (signal) {
      const onAbort = () => {
        void session?.abort();
      };
      abortHandler = onAbort;
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
    }

    // ── Announce running ──
    const startDetails = snapshotDetails("running");
    emitSubagentStarted(pi, {
      agentId,
      type: args.subagent_type,
      description: args.description,
      details: startDetails,
    });

    // ── Run the subagent turn(s) ──
    await session.prompt(effectivePrompt);

    // ── Aborted via parent signal? ──
    if (signal?.aborted) {
      progress.flush();
      const abortedDetails = snapshotDetails("aborted", "aborted by parent");
      emitSubagentFailed(pi, {
        agentId,
        error: "aborted by parent",
        durationMs: Date.now() - startedAt,
        toolUses,
        details: abortedDetails,
      });
      return errorResult("Subagent aborted by parent.", abortedDetails);
    }

    // ── Success ──
    progress.flush();
    const finalText = lastAssistantText(entries) ?? "(no output)";
    const completedDetails = snapshotDetails("completed");
    emitSubagentCompleted(pi, {
      agentId,
      result: finalText,
      durationMs: Date.now() - startedAt,
      tokens: usage.totals(),
      toolUses,
      details: completedDetails,
    });
    return {
      content: [{ type: "text", text: finalText }],
      details: completedDetails,
    };
  } catch (err) {
    progress.flush();
    const message = err instanceof Error ? err.message : String(err);
    const failedDetails = snapshotDetails("error", message);
    emitSubagentFailed(pi, {
      agentId,
      error: message,
      durationMs: Date.now() - startedAt,
      toolUses,
      details: failedDetails,
    });
    return errorResult(`Subagent failed: ${message}`, failedDetails);
  } finally {
    if (abortHandler && signal) {
      try {
        signal.removeEventListener("abort", abortHandler);
      } catch {
        /* ignore */
      }
    }
    if (unsubscribe) {
      try {
        unsubscribe();
      } catch {
        /* ignore */
      }
    }
    progress.dispose();
    try {
      session?.dispose();
    } catch {
      /* ignore */
    }
  }
}

/** Last assistant-text entry's text — used as the `result` string. */
function lastAssistantText(entries: SubagentTimelineEntry[]): string | undefined {
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    if (e.kind === "text" && e.text) return e.text;
  }
  return undefined;
}

/**
 * Build an error-flavored AgentToolResult. `isError` is read by pi's runtime
 * to set the ToolResultMessage error flag (see pi-coding-agent's subagent
 * example which uses the same idiom). The field is not in `AgentToolResult<T>`'s
 * declared shape, so we widen the return type slightly.
 */
type AgentToolResultWithError<T> = AgentToolResult<T> & { isError?: boolean };

function errorResult(text: string, details: AgentDetails): AgentToolResultWithError<AgentDetails> {
  return {
    content: [{ type: "text", text }],
    details,
    isError: true,
  };
}

// ─── Activation ──────────────────────────────────────────────────────────

/**
 * Extension activation entry point. Matches pi's `ExtensionFactory` shape:
 *   (pi: ExtensionAPI) => void
 *
 * Reads `shouldExposeInheritanceInTool()` ONCE at activation. Schema is
 * fixed thereafter — settings changes require `/reload`.
 */
export default function activate(pi: ExtensionAPI): void {
  capturedPi = pi;
  const exposeIsolated = shouldExposeInheritanceInTool();
  pi.registerTool(makeAgentTool(exposeIsolated));

  // Build/refresh the package-agent discovery index whenever pi (re)discovers
  // resources. `cwd` is NOT available at activate() — it arrives on the event.
  // Fires on BOTH `reason: "startup"` and `"reload"` (not gated on reason).
  // Side-effect-only: returns undefined (no ResourcesDiscoverResult fabricated).
  // A discovery failure must never block resource discovery or tool registration.
  pi.on("resources_discover", (event) => {
    try {
      refreshPackageAgentIndex(event.cwd, getAgentDir());
    } catch {
      /* best-effort — never throw out of a lifecycle handler */
    }
    return undefined;
  });
}
