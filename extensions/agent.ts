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

import { type TProperties, Type } from "@sinclair/typebox";

import { type CwdRejectReason, resolveChildProjectTrust, resolveSubagentCwd } from "./cwd.js";

import {
  type AgentSessionEvent,
  type AgentToolResult,
  type AgentToolUpdateCallback,
  createAgentSession,
  DefaultPackageManager,
  DefaultResourceLoader,
  defineTool,
  type ExtensionAPI,
  type ExtensionContext,
  getAgentDir,
  type LoadExtensionsResult,
  type ModelRuntime,
  parseFrontmatter,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";

import {
  type AgentDetails,
  type AgentStatus,
  type LiveTail,
  CLEARED_LIVE_TAIL,
  type SubagentTimelineEntry,
  type TokenUsage,
  buildDetails,
  buildInheritedContext,
  createToolCallTracker,
  emitSubagentCompleted,
  emitSubagentCreated,
  emitSubagentDelta,
  emitSubagentEntry,
  emitSubagentFailed,
  emitSubagentProgress,
  emitSubagentRetry,
  emitSubagentStarted,
  formatRetryDelay,
  mapSessionEventToEntry,
  retryEntryFromEvent,
} from "./events.js";

import {
  getBackgroundIdleTtlSec,
  getBackgroundTimeoutSec,
  getCwdScope,
  getMaxIdleBackground,
  isNotifyParentEnabled,
  getInheritanceCompression,
  getMaxBackgroundPending,
  getMaxConcurrent,
  getResultLimits,
  isBackgroundAllowed,
  type ResultLimits,
  resolveIsolated,
  shouldExposeInheritanceInTool,
} from "./settings.js";

import {
  type BackgroundCounts,
  type BackgroundRecord,
  type BackgroundRegistry,
  type BackgroundStatus,
  createBackgroundRegistry,
  type RunResultLike,
} from "./background.js";

import { countsLine, messagesPage, statusOf, summaryOf } from "./background-tools.js";

import { AGENT_CONTROL_TOOL_NAME, makeAgentControlTool } from "./agent-control.js";

import { createOrchestrator, type Orchestrator } from "./orchestration.js";

import { type GetQueryPayload, type ListQueryPayload, onGuarded, runBeforeSpawn, runBeforeStore, SUBAGENT_CHANNELS } from "./hooks.js";

// ─── Tool name (also used to exclude self from subagent tool set) ────────

const AGENT_TOOL_NAME = "Agent";

/**
 * Every tool that manages subagents. All are stripped from child sessions, so
 * a subagent can neither spawn nor manage subagents.
 * See change: add-background-subagents (D12).
 */
export const SUBAGENT_MANAGEMENT_TOOLS: readonly string[] = [AGENT_TOOL_NAME, AGENT_CONTROL_TOOL_NAME];

/** Child-side tool of background subagents. See change: add-subagent-orchestration (D9). */
export const ASK_PARENT_TOOL_NAME = "ask_parent";

/** Resolve with `p`, or reject with `SpawnAbortedError` once any signal aborts. */
function untilAborted<T>(p: Promise<T>, signals: Array<AbortSignal | undefined>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const live = signals.filter((x): x is AbortSignal => x !== undefined);
    const onAbort = (): void => {
      cleanup();
      reject(new SpawnAbortedError("aborted while waiting for the parent"));
    };
    const cleanup = (): void => {
      for (const sig of live) sig.removeEventListener("abort", onAbort);
    };
    if (live.some((x) => x.aborted)) return onAbort();
    for (const sig of live) sig.addEventListener("abort", onAbort, { once: true });
    p.then(
      (v) => {
        cleanup();
        resolve(v);
      },
      (e: unknown) => {
        cleanup();
        reject(e);
      },
    );
  });
}

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
// USER-SCOPE ONLY (deliberate design choice, not an SDK limitation). Only
// packages installed into `<agentDir>` (scope "user") — an explicit operator
// act — contribute spawnable agents. Project-scoped packages are intentionally
// NOT indexed: skipping them closes the untrusted-checkout injection surface
// entirely without having to reason about trust (see design Decision 5).
// NOTE: the SDK *does* expose a project-trust signal
// (`ExtensionContext.isProjectTrusted()`, `SettingsManagerCreateOptions.projectTrusted`),
// so a future opt-in could gate project scope on trust — deferred by choice,
// not a capability gap.

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

// Module-level cache keyed by cwd: sibling subagents in different worktrees
// keep their own entries. Bounded LRU (Map insertion order = recency).
// `resources_discover` drops every entry (packages may have changed).
// See change: add-subagent-orchestration (D10).
const PACKAGE_INDEX_CACHE_MAX = 8;
const packageAgentIndexes = new Map<string, PackageAgentIndex>();

function cacheIndex(cwd: string, index: PackageAgentIndex): PackageAgentIndex {
  packageAgentIndexes.delete(cwd);
  packageAgentIndexes.set(cwd, index);
  while (packageAgentIndexes.size > PACKAGE_INDEX_CACHE_MAX) {
    packageAgentIndexes.delete(packageAgentIndexes.keys().next().value!);
  }
  return index;
}

/**
 * Drop every cached index and rebuild the one for `cwd`. Called from the
 * `resources_discover` handler (startup + reload).
 */
export function refreshPackageAgentIndex(cwd: string, agentDir: string): PackageAgentIndex {
  packageAgentIndexes.clear();
  return cacheIndex(cwd, buildPackageAgentIndex(cwd, agentDir));
}

/**
 * Return the cached package-agent index for `cwd`, building it lazily when
 * absent. Used per spawn with the subagent's resolved cwd.
 */
export function ensurePackageAgentIndex(cwd: string, agentDir: string): PackageAgentIndex {
  const hit = packageAgentIndexes.get(cwd);
  return cacheIndex(cwd, hit ?? buildPackageAgentIndex(cwd, agentDir));
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
   * Absent / empty → inherit parent's live model (`ctx.model`).
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
 * Throttled progress fan-out. Coalesces updates within a fixed window and
 * hands the latest snapshot to `sink` (which fans out to
 * `emitSubagentProgress` AND the tool's `onUpdate` — design Decision 2).
 *
 * `schedule` takes a *producer*, not a snapshot: coalesced events never pay
 * for a `buildDetails` call. `flush()` always sends the latest state
 * regardless of throttle window — call before `completed`/`failed` so the
 * dashboard sees the final snapshot.
 */
export function createProgressEmitter(
  sink: (details: AgentDetails) => void,
  windowMs: number = PROGRESS_THROTTLE_MS,
): {
  schedule(produce: () => AgentDetails): void;
  flush(): void;
  dispose(): void;
} {
  let pending: (() => AgentDetails) | undefined;
  let lastEmitAt = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;

  function emitNow(produce: () => AgentDetails): void {
    lastEmitAt = Date.now();
    pending = undefined;
    if (timer) {
      clearTimeout(timer);
      timer = undefined;
    }
    sink(produce());
  }

  return {
    schedule(produce: () => AgentDetails) {
      pending = produce;
      const elapsed = Date.now() - lastEmitAt;
      if (elapsed >= windowMs) {
        emitNow(produce);
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

// ─── Per-child resource loader ────────────────────────────────────

/**
 * Build a fresh, lean resource loader for one child session (design
 * Decision 1). One loader → one `Extension[]` + one `runtime` per child:
 * sharing a loader is unsafe (`ExtensionRunner.bindCore` overwrites the
 * single `runtime`, and the first `dispose()` poisons it for siblings).
 *
 * Skills, prompt templates and themes are not read by a headless child, so
 * they are skipped — same tool surface, ~350 MB less RSS at n=7.
 */
async function createChildLoader(cwd: string, settingsManager: SettingsManager): Promise<DefaultResourceLoader> {
  const loader = new DefaultResourceLoader({
    cwd,
    agentDir: getAgentDir(),
    // Trust decided per child (D3): without this pi assumes a trusted project.
    settingsManager,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    extensionsOverride: stripChildSettlementHandlers,
  });
  await loader.reload();
  return loader;
}

/**
 * Settlement events whose extension handlers do NOT run in a child session.
 * pi awaits them inside `prompt()`, so a parent-scoped hook (memory summary,
 * telemetry flush) would delay the child or keep it running. `message_end`
 * is kept: its handlers may rewrite/redact the message itself.
 * See change: harden-subagent-lifecycle.
 */
const CHILD_STRIPPED_EVENTS = ["turn_end", "agent_end", "agent_before_settle", "agent_settled"] as const;

/**
 * `extensionsOverride` for child loaders: drops settlement-event handlers,
 * keeps every other handler and every tool. Mutates in place — safe because
 * each child has its own loader and thus its own `Extension` objects.
 */
export function stripChildSettlementHandlers(base: LoadExtensionsResult): LoadExtensionsResult {
  for (const ext of base.extensions) {
    for (const ev of CHILD_STRIPPED_EVENTS) ext.handlers.delete(ev);
  }
  return base;
}

// ─── Result bounds ────────────────────────────────────────────────────
//
// pi persists a custom tool's result (`content` + `details`) to the parent
// session JSONL unmodified, so the producer bounds it. Bus events stay full.
// See change: harden-subagent-lifecycle.

/** Keep head + tail of `s` within `max` chars, marking the cut. `max <= 0` = unlimited. */
function cutMiddle(s: string, max: number): string {
  if (max <= 0 || s.length <= max) return s;
  const head = Math.ceil(max / 2);
  const tail = max - head;
  return `${s.slice(0, head)}\n[… ${s.length - max} chars truncated …]\n${s.slice(s.length - tail)}`;
}

/** Cut an arbitrary value: strings directly, anything else via its JSON form. */
function cutValue(v: unknown, max: number): unknown {
  if (max <= 0 || v === undefined) return v;
  if (typeof v === "string") return cutMiddle(v, max);
  let json: string | undefined;
  try {
    json = JSON.stringify(v);
  } catch {
    return "[unserializable]";
  }
  return json !== undefined && json.length > max ? cutMiddle(json, max) : v;
}

function cutEntry(e: SubagentTimelineEntry, max: number): SubagentTimelineEntry {
  if (max <= 0) return e;
  if (e.kind === "tool") return { ...e, input: cutValue(e.input, max), output: cutValue(e.output, max) };
  return { ...e, text: cutMiddle(e.text, max) };
}

/**
 * Bound a tool result for persistence: result text head/tail-cut, each entry
 * field cut, and an oversized timeline reduced to a head + tail of entries
 * around one `[N timeline entries omitted]` marker (`entriesOmitted = N`;
 * `entryCount` keeps the original count). Metadata is never touched. Pure.
 */
export function boundToolResult(
  text: string,
  details: AgentDetails,
  limits: ResultLimits,
): { text: string; details: AgentDetails } {
  const outText = cutMiddle(text, limits.resultMaxChars);
  if (!details.entries) return { text: outText, details };
  let entries = details.entries.map((e) => cutEntry(e, limits.entryFieldMaxChars));
  let entriesOmitted: number | undefined;
  const max = limits.detailsMaxChars;
  if (max > 0 && JSON.stringify(entries).length > max) {
    const size = (e: SubagentTimelineEntry) => JSON.stringify(e).length + 1; // + comma
    const markerTs = entries[0]?.ts ?? 0;
    const markerFor = (n: number): SubagentTimelineEntry => ({
      kind: "error",
      text: `[${n} timeline entries omitted]`,
      ts: markerTs,
    });
    let budget = max - 2 - size(markerFor(entries.length)); // brackets + worst-case marker
    const head: SubagentTimelineEntry[] = [];
    const tail: SubagentTimelineEntry[] = [];
    let i = 0;
    let j = entries.length - 1;
    let takeHead = true;
    while (i <= j) {
      const next = takeHead ? entries[i] : entries[j];
      const cost = size(next);
      if (cost > budget) break;
      budget -= cost;
      if (takeHead) head.push(entries[i++]);
      else tail.unshift(entries[j--]);
      takeHead = !takeHead;
    }
    entriesOmitted = j - i + 1;
    if (entriesOmitted > 0) {
      const marker = { ...markerFor(entriesOmitted), ts: head.at(-1)?.ts ?? markerTs };
      entries = [...head, marker, ...tail];
    } else {
      entriesOmitted = undefined;
    }
  }
  return {
    text: outText,
    details: { ...details, entries, ...(entriesOmitted ? { entriesOmitted } : {}) },
  };
}

// ─── Spawn concurrency gate ───────────────────────────────────────
//
// Process-wide FIFO semaphore bounding how many child sessions run at once
// (design Decision 3). Nested subagents are impossible (`Agent` is stripped
// from children), so one gate per process is the right scope.

/** Thrown when a spawn's own signal aborts (parent abort or `subagents:stop`). */
class SpawnAbortedError extends Error {}

/** How often waiting calls re-read `maxConcurrent` (live limit change). */
const QUEUE_RECHECK_MS = 1_000;

/** Queue state a waiting call reports on its snapshots. */
export interface QueueInfo {
  queuePosition: number;
  activeSlots: number;
  maxConcurrent: number;
}

/**
 * Dispatch lane. Foreground waiters go first, then `resume` (a background
 * subagent re-acquiring after `ask_parent` was answered, design D12), then
 * background; FIFO within each lane. See change: add-background-subagents.
 */
export type SpawnLane = "foreground" | "resume" | "background";

interface SpawnWaiter {
  lane: SpawnLane;
  start(): void;
  /** Fresh queue info for this waiter; called from the batched flush. */
  onPosition?: (info: QueueInfo) => void;
}

let activeSpawns = 0;
/**
 * Waiters in dispatch order: every foreground waiter, then every background
 * one. Kept ordered on insert, so dispatch is `shift()` and the index is the
 * queue position.
 */
const spawnWaiters: SpawnWaiter[] = [];

/** Insert a waiter at the end of its lane; returns its index. */
function enqueueWaiter(waiter: SpawnWaiter): number {
  if (waiter.lane === "background") {
    spawnWaiters.push(waiter);
    return spawnWaiters.length - 1;
  }
  // foreground: ahead of every non-foreground waiter; resume: ahead of background.
  const firstBehind = spawnWaiters.findIndex((w) =>
    waiter.lane === "foreground" ? w.lane !== "foreground" : w.lane === "background",
  );
  const at = firstBehind === -1 ? spawnWaiters.length : firstBehind;
  spawnWaiters.splice(at, 0, waiter);
  return at;
}
let recheckTimer: ReturnType<typeof setInterval> | undefined;
let positionsDirty = false;
/** Limit seen by the last dispatch; a change re-pushes queue info. */
let lastDispatchLimit: number | undefined;

/** Current queue info for a waiter at 0-based `index`. */
function queueInfoAt(index: number, limit = getMaxConcurrent()): QueueInfo {
  return { queuePosition: index + 1, activeSlots: activeSpawns, maxConcurrent: limit };
}

/**
 * Coalesce every queue change in the current task into ONE frame per
 * remaining waiter (flushed on a microtask).
 */
function schedulePositionPush(): void {
  if (positionsDirty) return;
  positionsDirty = true;
  queueMicrotask(() => {
    positionsDirty = false;
    if (spawnWaiters.length === 0) return;
    const limit = getMaxConcurrent();
    spawnWaiters.forEach((w, i) => w.onPosition?.(queueInfoAt(i, limit)));
  });
}

/** Keep the live re-check running exactly while something waits. */
function syncRecheckTimer(): void {
  if (spawnWaiters.length > 0 && !recheckTimer) {
    recheckTimer = setInterval(dispatchSpawnWaiters, QUEUE_RECHECK_MS);
    (recheckTimer as { unref?: () => void }).unref?.();
  } else if (spawnWaiters.length === 0 && recheckTimer) {
    clearInterval(recheckTimer);
    recheckTimer = undefined;
  }
}

function dispatchSpawnWaiters(): void {
  const limit = getMaxConcurrent();
  let changed = lastDispatchLimit !== undefined && limit !== lastDispatchLimit;
  lastDispatchLimit = limit;
  while (spawnWaiters.length > 0 && (limit === 0 || activeSpawns < limit)) {
    const next = spawnWaiters.shift()!;
    activeSpawns += 1;
    changed = true;
    next.start();
  }
  if (changed) schedulePositionPush();
  syncRecheckTimer();
}

/**
 * Wait for a spawn slot. Resolves with the release function. Rejects with
 * `SpawnAbortedError` when `signal` aborts before the slot is granted — in
 * that case no slot is consumed.
 *
 * Fair: a call is granted at once only when NOBODY is waiting, so it can never
 * jump ahead of earlier waiters (e.g. right after `maxConcurrent` is raised,
 * before the re-check runs). See change: manage-subagent-spawn-queue.
 */
function acquireSpawnSlot(
  signal: AbortSignal | undefined,
  onPosition?: (info: QueueInfo) => void,
  lane: SpawnLane = "foreground",
): Promise<() => void> {
  let released = false;
  const release = (): void => {
    if (released) return;
    released = true;
    activeSpawns -= 1;
    dispatchSpawnWaiters();
  };

  if (signal?.aborted) return Promise.reject(new SpawnAbortedError("aborted"));

  const limit = getMaxConcurrent();
  lastDispatchLimit = limit;
  if (spawnWaiters.length === 0 && (limit === 0 || activeSpawns < limit)) {
    activeSpawns += 1;
    return Promise.resolve(release);
  }

  return new Promise<() => void>((resolve, reject) => {
    let onAbort: (() => void) | undefined;
    const waiter: SpawnWaiter = {
      lane,
      start: () => {
        if (onAbort && signal) signal.removeEventListener("abort", onAbort);
        resolve(release);
      },
      onPosition,
    };
    if (signal) {
      onAbort = () => {
        const idx = spawnWaiters.indexOf(waiter);
        if (idx >= 0) spawnWaiters.splice(idx, 1); // slot never consumed
        schedulePositionPush();
        syncRecheckTimer();
        reject(new SpawnAbortedError("aborted"));
      };
      signal.addEventListener("abort", onAbort, { once: true });
    }
    const index = enqueueWaiter(waiter);
    // Report this waiter's place synchronously (created snapshot) and
    // through the batched push. A foreground insert ahead of background
    // waiters renumbers them in the same batched frame.
    onPosition?.(queueInfoAt(index, limit));
    if (index < spawnWaiters.length - 1) schedulePositionPush();
    syncRecheckTimer();
  });
}

// ─── Per-subagent control (`subagents:stop`) ─────────────────────────────────
//
// One registry per activation (never module-level): a stop received on one
// session's bus can only reach subagents that session created.
// See change: manage-subagent-spawn-queue.

export type AgentPhase = "queued" | "running" | "idle" | "terminal";

/** Result of one stop request (also what is logged). */
export interface StopOutcome {
  agentId: string;
  phase: AgentPhase | "unknown";
  outcome: "stopped" | "ignored";
}

/** Who requested a stop. See change: add-background-subagents. */
export type StopSource = NonNullable<AgentDetails["stoppedBy"]>;

/** What a run registers so it can be stopped. */
export interface AgentControl {
  phase(): AgentPhase;
  /** Request a stop; false when the run already has an end reason. */
  stop(by: StopSource): boolean;
}

export interface AgentControlRegistry {
  /** Register a run; returns its unregister function. */
  register(agentId: string, control: AgentControl): () => void;
  /**
   * Stop one subagent of this activation. Never throws; always logs.
   * `by` defaults to `"event"` (a `subagents:stop` from the bus).
   */
  stop(agentId: unknown, by?: StopSource): StopOutcome;
  /** Number of registered (non-finished) runs. */
  size(): number;
  /** Whether `agentId` is a registered run of this activation. */
  has(agentId: string): boolean;
}

export function createAgentControlRegistry(): AgentControlRegistry {
  const controls = new Map<string, AgentControl>();
  return {
    register(agentId, control) {
      controls.set(agentId, control);
      return () => {
        if (controls.get(agentId) === control) controls.delete(agentId);
      };
    },
    stop(raw, by = "event") {
      const agentId = typeof raw === "string" ? raw : String(raw);
      const control = typeof raw === "string" && raw !== "" ? controls.get(raw) : undefined;
      let result: StopOutcome;
      if (!control) {
        result = { agentId, phase: "unknown", outcome: "ignored" };
      } else {
        const phase = control.phase();
        const stopped = phase !== "terminal" && control.stop(by);
        result = { agentId, phase, outcome: stopped ? "stopped" : "ignored" };
      }
      console.warn("[pi-dashboard-subagents] subagents:stop", result);
      return result;
    },
    size() {
      return controls.size;
    },
    has(agentId) {
      return controls.has(agentId);
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
  // `tool_execution_end` keeps the last activity (no flicker between steps).
  if (event.type === "message_update") {
    const e = event.assistantMessageEvent;
    if (e.type === "thinking_start") return "thinking";
    if (e.type === "text_start") return "writing";
  }
  return undefined; // no change
}

/** Max chars of the streaming block carried in `details.liveTail`. */
export const LIVE_TAIL_MAX = 280;

/**
 * Fold one session event into the bounded live tail of the block currently
 * streaming. Block end / message end clear it to the sentinel.
 */
export function nextLiveTail(prev: LiveTail, event: AgentSessionEvent): LiveTail {
  if (event.type === "message_end") return CLEARED_LIVE_TAIL;
  if (event.type !== "message_update") return prev;
  const e = event.assistantMessageEvent as { type: string; delta?: string };
  switch (e.type) {
    case "thinking_start":
      return { kind: "thinking", text: "" };
    case "text_start":
      return { kind: "text", text: "" };
    case "thinking_delta":
    case "text_delta": {
      const kind = e.type === "thinking_delta" ? "thinking" : "text";
      const base = prev.kind === kind ? prev.text : "";
      return { kind, text: (base + (e.delta ?? "")).slice(-LIVE_TAIL_MAX) };
    }
    case "thinking_end":
    case "text_end":
      return CLEARED_LIVE_TAIL;
    default:
      return prev;
  }
}

/** One `subagents:delta` piece minus the envelope (`v`/`agentId`/`toolCallId`). */
export interface BlockDeltaPiece {
  blockId: number;
  kind: "thinking" | "text";
  offset: number;
  text: string;
  final: boolean;
}

/**
 * Append-only accumulator for the streaming block's content (change:
 * emit-subagent-block-deltas). Unlike {@link createProgressEmitter} (latest
 * wins), pending text is APPENDED and never replaced, so a coalesced window
 * loses no characters. At most one non-final piece per `windowMs` (trailing
 * edge); `open`/`close`/`dispose` flush synchronously with `final: true`.
 *
 * - `open(kind)` closes any open block, then starts block `next++`.
 * - `push(kind, delta)` appends; opens implicitly when no block is open or the
 *   kind differs (providers that skip `_start`).
 * - `close()` emits the final piece and returns the closed id (undefined when
 *   nothing was open).
 * - `dispose()` closes any open block; nothing is emitted afterwards.
 */
export function createBlockDeltaEmitter(
  sink: (piece: BlockDeltaPiece) => void,
  windowMs: number = PROGRESS_THROTTLE_MS,
): {
  open(kind: "thinking" | "text"): number;
  push(kind: "thinking" | "text", delta: string): void;
  close(): number | undefined;
  dispose(): void;
} {
  let nextId = 0;
  let open: { blockId: number; kind: "thinking" | "text"; offset: number; pending: string } | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let disposed = false;

  function clearTimer(): void {
    if (timer) {
      clearTimeout(timer);
      timer = undefined;
    }
  }

  function emitPending(final: boolean): void {
    if (!open) return;
    const text = open.pending;
    if (!final && text === "") return;
    sink({ blockId: open.blockId, kind: open.kind, offset: open.offset, text, final });
    open.offset += text.length;
    open.pending = "";
  }

  function close(): number | undefined {
    clearTimer();
    if (!open) return undefined;
    const id = open.blockId;
    emitPending(true);
    open = undefined;
    return id;
  }

  function openBlock(kind: "thinking" | "text"): number {
    close();
    open = { blockId: nextId++, kind, offset: 0, pending: "" };
    return open.blockId;
  }

  return {
    open: openBlock,
    push(kind, delta) {
      if (disposed) return;
      if (!open || open.kind !== kind) openBlock(kind);
      open!.pending += delta;
      if (timer) return;
      timer = setTimeout(() => {
        timer = undefined;
        emitPending(false);
      }, windowMs);
    },
    close,
    dispose() {
      close();
      disposed = true;
    },
  };
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

type ThinkingLevelString = "minimal" | "low" | "medium" | "high" | "xhigh" | "max" | "off";
const VALID_THINKING_LEVELS: readonly ThinkingLevelString[] = [
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
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
export function buildAgentParametersSchema(exposeIsolated: boolean, allowBackground = false) {
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
          'Optional model override. Accepts "@role" (e.g. "@fast"), "provider/model-id[:thinking]" (e.g. "anthropic/claude-haiku-4-5:high"), or bare "model-id". Overrides the agent .md `model:` field when both are present. Omit to use the .md value, or to inherit the parent session\'s current model when no .md model is set.',
      }),
    ),
  };
  // One concrete property map: TypeBox cannot infer a union of conditional
  // shapes, and the tool's `execute` reads params as `AgentToolArgs` anyway.
  const properties: TProperties = {
    ...base,
    // Per-child working directory. See change: add-subagent-orchestration (D2).
    cwd: Type.Optional(
      Type.String({
        description:
          "Optional working directory for the subagent (absolute, or relative to yours), e.g. a git worktree. Its tools, AGENTS.md, .pi settings and agent definitions follow it. Give each parallel editing agent its own worktree; preparing the worktree (create, install deps) is your job. Default: your cwd.",
      }),
    ),
  };
  if (exposeIsolated) {
    properties.isolated = Type.Optional(
      Type.Boolean({
        description:
          "When true, the subagent runs WITHOUT inheriting parent context. Defaults to the global setting.",
      }),
    );
  }
  // Background parameters exist only when `allowBackground` is on at
  // activation. See change: add-background-subagents (D3).
  if (allowBackground) {
    properties.run_in_background = Type.Optional(
      Type.Boolean({
        description:
          "When true, return at once with a `bg-` id while the subagent runs on. Manage it with AgentControl (status, wait, reply, steer, cancel). Only background subagents can be steered or ask you questions.",
      }),
    );
    properties.timeout_s = Type.Optional(
      Type.Number({
        description:
          "Background only: stop the subagent after this many seconds of running (queue time not counted). Overrides the configured default; 0 = no limit.",
      }),
    );
  }
  return Type.Object(properties);
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
  /** Background spawn (only honored when `allowBackground` is on). */
  run_in_background?: boolean;
  /** Background run-time limit in seconds; `0` = none. */
  timeout_s?: number;
  /** Working directory; resolved + scope-checked before any spawn work. */
  cwd?: string;
}

/** `details` of an `Agent` call a `subagents:before_spawn` handler vetoed. */
export interface SpawnVetoDetails {
  vetoed: true;
  reason: string;
  background: boolean;
}

/** `details` of an `Agent` call whose `cwd` was rejected. See change: add-subagent-orchestration. */
export interface CwdRejectDetails {
  rejected: true;
  reason: CwdRejectReason;
  background: boolean;
}

/** `details` of a background `Agent` call: no `agentId`, so the dashboard does not finalize the card. */
export interface BackgroundSpawnDetails {
  background: true;
  /** Short `bg-` id; absent when the spawn was rejected. */
  id?: string;
  status: BackgroundStatus | "rejected";
  queuePosition?: number;
  counts: BackgroundCounts;
  /** Outstanding ids, set only on a pending-cap rejection. */
  outstanding?: string[];
}

function makeAgentTool(
  pi: ExtensionAPI,
  exposeIsolated: boolean,
  controls?: AgentControlRegistry,
  background?: BackgroundRegistry,
  orchestrator?: Orchestrator,
) {
  return defineTool({
    name: AGENT_TOOL_NAME,
    label: "Agent",
    description: [
      "Spawn a foreground subagent in-memory with a focused task.",
      background
        ? "Runs synchronously and returns when the subagent finishes, unless `run_in_background` is true: then it returns a `bg-` id at once (manage it with AgentControl)."
        : "Runs synchronously; returns when the subagent finishes.",
      "Two modes: (1) curated — when `subagent_type` matches a project/user/bundled `.md`, that file's frontmatter supplies model/tools/prompt defaults; (2) inline — any label works without a `.md`; pass `model` to pick @role / provider/model / bare id at call time.",
      "Subagent's full timeline (tool calls, reasoning, assistant text) is",
      "streamed to the dashboard inspector and embedded in the returned result.",
    ].join(" "),
    parameters: buildAgentParametersSchema(exposeIsolated, background !== undefined),

    async execute(
      toolCallId: string,
      rawParams: Record<string, unknown>,
      signal: AbortSignal | undefined,
      onUpdate: AgentToolUpdateCallback<AgentDetails> | undefined,
      ctx: ExtensionContext,
    ): Promise<AgentToolResult<AgentDetails>> {
      // pi validates against the schema above; the property map is untyped
      // because its keys depend on activation settings.
      const raw = rawParams as unknown as AgentToolArgs;
      const wantsBackground = background !== undefined && raw.run_in_background === true;
      // `cwd` is model input: resolve + scope-check before any hook, record,
      // event or slot. See change: add-subagent-orchestration (D2).
      const where = resolveSubagentCwd(ctx.cwd, raw.cwd, getCwdScope());
      if (!where.ok) {
        const rejected: AgentToolResultWithError<CwdRejectDetails> = {
          content: [{ type: "text", text: `Subagent not spawned (${where.reason}): ${where.message}` }],
          details: { rejected: true, reason: where.reason, background: wantsBackground },
          isError: true,
        };
        return rejected as unknown as AgentToolResult<AgentDetails>;
      }
      // Plugins may veto or patch any spawn before a record, event or slot
      // exists. See change: add-background-subagents (D10).
      const hook = runBeforeSpawn(pi, raw, wantsBackground);
      if (hook.veto) {
        // No agentId: nothing was created, so no dashboard card to finalize.
        const vetoed: AgentToolResultWithError<SpawnVetoDetails> = {
          content: [{ type: "text", text: `Subagent spawn vetoed: ${hook.reason}` }],
          details: { vetoed: true, reason: hook.reason, background: wantsBackground },
          isError: true,
        };
        return vetoed as unknown as AgentToolResult<AgentDetails>;
      }
      const params: AgentToolArgs = { ...raw, ...hook.args };
      if (background && wantsBackground) {
        return spawnInBackground(pi, background, controls, params, ctx, toolCallId, where.cwd, orchestrator) as unknown as AgentToolResult<AgentDetails>;
      }
      return runAgentTool(where.cwd, params, signal, onUpdate, ctx, pi, toolCallId, controls) as Promise<
        AgentToolResult<AgentDetails>
      >;
    },
  });
}

/** Per-call `timeout_s` (when a finite number ≥ 0) wins over `backgroundTimeoutSec`. */
function effectiveTimeoutSec(perCall: unknown): number {
  if (typeof perCall === "number" && Number.isFinite(perCall) && perCall >= 0) return perCall;
  return getBackgroundTimeoutSec();
}

/**
 * Background branch of `Agent.execute` (design D1, D8): check the pending
 * cap, register a record, start `runAgentTool` unawaited with no parent
 * signal, and return the short id at once. Every `subagents:*` event still
 * fires exactly as for a foreground run.
 */
function spawnInBackground(
  pi: ExtensionAPI,
  registry: BackgroundRegistry,
  controls: AgentControlRegistry | undefined,
  params: AgentToolArgs,
  ctx: ExtensionContext,
  toolCallId: string,
  cwd: string,
  orchestrator?: Orchestrator,
): AgentToolResultWithError<BackgroundSpawnDetails> {
  const cap = getMaxBackgroundPending();
  const outstanding = registry.outstanding();
  if (cap > 0 && outstanding.length >= cap) {
    const ids = outstanding.map((r) => r.id);
    return {
      content: [
        {
          type: "text",
          text:
            `Background limit reached: ${outstanding.length} of ${cap} background subagents are still queued or running ` +
            `(${ids.join(", ")}). Wait for them with AgentControl({ action: "status", ids, wait: "any" }) or stop some with AgentControl({ action: "cancel", ids }).`,
        },
      ],
      details: { background: true, status: "rejected", counts: registry.counts(), outstanding: ids },
      isError: true,
    };
  }

  let record: BackgroundRecord | undefined;
  let sink: ((update: { details?: AgentDetails }) => void) | undefined;
  // No parent signal: interrupting the parent turn must not stop background
  // work. AgentControl cancel, subagents:stop, the timeout and shutdown do (D1).
  const run = runAgentTool(
    cwd,
    params,
    undefined,
    (update) => sink?.(update as { details?: AgentDetails }),
    ctx,
    pi,
    toolCallId,
    controls,
    {
      background: true,
      timeoutMs: effectiveTimeoutSec(params.timeout_s) * 1000,
      backgroundId: () => record?.id,
      onAgentId: (agentId) => {
        record = registry.create({
          agentId,
          subagentType: params.subagent_type,
          description: params.description,
          cwd,
        });
        sink = registry.sink(record);
      },
      onEntry: (entry) => {
        if (record) registry.appendEntry(record, entry);
      },
      onRunning: () => {
        if (record) registry.markRunning(record);
      },
      // Idle keep-alive between runs (design D5).
      keepAlive: () => orchestrator !== undefined && getBackgroundIdleTtlSec() > 0 && getMaxIdleBackground() > 0,
      onIdle: (res, handle) => {
        if (record) orchestrator?.runEnded(record, res as RunResultLike, handle);
      },
      onIdleDisposed: (reason) => {
        if (record) orchestrator?.idleDisposed(record, reason);
      },
      ...(orchestrator
        ? {
            ask: (question: string) => {
              const rec = record!;
              const { questionId, answer } = orchestrator.ask(rec, question);
              return { questionId, answer, cancel: () => orchestrator.cancelAsks(rec) };
            },
            onSlot: (action, queuePosition) => {
              if (record) orchestrator.slot(record, action, queuePosition);
            },
            onSession: (live) => {
              if (record) orchestrator.attachSession(record, live);
            },
          }
        : {}),
    },
  );
  // `runAgentTool` registers the record and announces the run synchronously
  // (it first awaits at the spawn slot), so `record` is set here.
  const rec = record!;
  const ended = (res: RunResultLike): void => {
    if (orchestrator) orchestrator.runEnded(rec, res);
    else registry.finish(rec, res);
  };
  run.then(
    (res) => ended(res as RunResultLike),
    (err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      ended({
        content: [{ type: "text", text: `Subagent failed: ${message}` }],
        details: { status: "error", error: message },
        isError: true,
      });
    },
  );

  // A waiter has already received its queued frame; otherwise the slot was
  // granted at once and the run is about to start.
  const queuePosition = rec.latest?.status === "queued" ? rec.latest.queuePosition : undefined;
  if (queuePosition === undefined) registry.markRunning(rec);
  const status = rec.status;
  const counts = registry.counts();
  const where = status === "queued" ? `queued #${queuePosition}` : "running";
  return {
    content: [
      {
        type: "text",
        text:
          `Started background subagent ${rec.id} (${where}). ` +
          `Background: ${countsLine(counts)}. ` +
          `Coordinate with AgentControl: wait (questions + outcomes), reply, steer, status({ ids: ["${rec.id}"] }), cancel.`,
      },
    ],
    details: {
      background: true,
      id: rec.id,
      status,
      ...(queuePosition !== undefined ? { queuePosition } : {}),
      counts,
    },
  };
}

// The tool's `execute` callback receives `ctx: ExtensionContext` but NOT the
// `pi: ExtensionAPI` handle. `pi` is threaded in lexically by `activate()`.
// It MUST NOT be held in module-level state: a nested subagent session
// re-activates this same module instance and would clobber the parent's handle,
// which its own dispose() then invalidates.

// ─── The main spawn loop ────────────────────────────────────────────────

/** Per-run options beyond the tool args. See change: add-background-subagents. */
export interface RunAgentOptions {
  /**
   * Background run: background dispatch lane, `details.background: true`.
   * The caller passes no parent signal so a parent-turn interrupt does not
   * reach it.
   */
  background?: boolean;
  /** Called synchronously with the new `agentId`, before `subagents:created`. */
  onAgentId?: (agentId: string) => void;
  /** Called once per timeline step, right after `subagents:entry`. */
  onEntry?: (entry: SubagentTimelineEntry) => void;
  /** Called synchronously when the run is granted its slot. */
  onRunning?: () => void;
  /**
   * Run-time limit in ms, counted from slot grant (`0`/absent = none). On
   * expiry the run is stopped with `stoppedBy: "timeout"`.
   */
  timeoutMs?: number;
  /** Short `bg-` id, reported on `subagents:before_store`. */
  backgroundId?: () => string | undefined;
  /**
   * Background: whether a run that ended without a stop keeps its session
   * alive (`idle`) for `AgentSteer`. Read at each run end.
   * See change: add-subagent-orchestration (D5).
   */
  keepAlive?: () => boolean;
  /** A run ended and the session is parked idle; `handle` continues or frees it. */
  onIdle?: (result: AgentToolResultWithError<AgentDetails>, handle: IdleHandle) => void;
  /** The idle session was freed. Runs before `runAgentTool` resolves. */
  onIdleDisposed?: (reason: DisposeReason) => void;
  /**
   * Background: gives the child an `ask_parent` tool. Posts the question and
   * returns the pending answer (never times out) plus a cancel for stops.
   */
  ask?: (question: string) => { questionId: string; answer: Promise<string>; cancel: () => void };
  /** Slot hand-off around `ask_parent` (design D12). */
  onSlot?: (action: "released" | "reacquire_queued" | "reacquired", queuePosition?: number) => void;
  /** The live session, for `steer` / `followUp` while running. */
  onSession?: (live: LiveSession) => void;
}

/** Steering surface of a running background subagent. */
export interface LiveSession {
  steer(message: string): Promise<unknown>;
  followUp(message: string): Promise<unknown>;
}

/** Why an idle background subagent was freed. See change: add-subagent-orchestration. */
export type DisposeReason = "ttl" | "cap" | "cancel" | "shutdown";

/** Control over a background subagent parked `idle` between runs. */
export interface IdleHandle {
  /** Start the next run on the same history; `queued` when no slot is free. */
  continueWith(message: string): "started" | "queued";
  /** Free the session. Idempotent. */
  dispose(reason: DisposeReason): void;
}

/** Warned-once latch for {@link getParentModelRuntime}. */
let warnedMissingRuntime = false;

/**
 * Read the parent session's live `ModelRuntime` from `ctx.modelRegistry`.
 * pi declares `ModelRegistry.runtime` private and exposes no public accessor,
 * so this reads it defensively. When it is missing (renamed upstream), logs one
 * stderr warning and returns undefined; pi then builds its own disk runtime.
 */
export function getParentModelRuntime(ctx: ExtensionContext): ModelRuntime | undefined {
  const runtime = (ctx.modelRegistry as unknown as { runtime?: ModelRuntime } | undefined)?.runtime;
  if (runtime) return runtime;
  if (ctx.modelRegistry && !warnedMissingRuntime) {
    warnedMissingRuntime = true;
    console.warn(
      "[pi-dashboard-subagents] parent modelRuntime unavailable on ctx.modelRegistry; " +
        "subagents fall back to a disk-only model runtime (custom providers may lack auth).",
    );
  }
  return undefined;
}

export async function runAgentTool(
  cwd: string,
  args: AgentToolArgs,
  signal: AbortSignal | undefined,
  onUpdate: AgentToolUpdateCallback<AgentDetails> | undefined,
  ctx: ExtensionContext,
  pi: ExtensionAPI,
  /** Parent `Agent` tool call id, echoed on every `subagents:entry`. */
  toolCallId = "",
  /** Activation's control registry; when set, `subagents:stop` can stop this run. */
  controls?: AgentControlRegistry,
  /** Background-run options. See change: add-background-subagents. */
  runOpts: RunAgentOptions = {},
): Promise<AgentToolResultWithError<AgentDetails>> {
  const agentId = randomUUID();
  /** Call-creation time; `durationMs` counts from here (queue time included). */
  let startedAt = Date.now();
  const background = runOpts.background === true;
  runOpts.onAgentId?.(agentId);

  // ── Per-agent abort, linked to the parent signal ──
  // The first end reason wins: a parent abort keeps today's `aborted`
  // outcome, a `subagents:stop` yields `stopped`. See change:
  // manage-subagent-spawn-queue.
  const ctrl = new AbortController();
  let endReason: "parent" | { stop: "queued" | "running"; by: StopSource } | undefined;
  let phase: AgentPhase = "queued";
  let slotGrantedAt: number | undefined;
  let queueInfo: QueueInfo | undefined;
  const onParentAbort = (): void => {
    if (endReason) return;
    endReason = "parent";
    ctrl.abort();
  };
  if (signal?.aborted) onParentAbort();
  else signal?.addEventListener("abort", onParentAbort, { once: true });
  /** Set while a finished background run is parked `idle` (design D5). */
  let idleHandle: IdleHandle | undefined;
  const requestStop = (by: StopSource): boolean => {
    if (phase === "idle") {
      // Stopping an idle subagent frees its session; its last result stands.
      idleHandle?.dispose(by === "shutdown" ? "shutdown" : "cancel");
      return true;
    }
    if (endReason || phase === "terminal") return false;
    endReason = { stop: phase, by };
    ctrl.abort();
    return true;
  };
  const unregister = controls?.register(agentId, { phase: () => phase, stop: requestStop });
  let runTimer: ReturnType<typeof setTimeout> | undefined;
  /** Detach from the parent + registry. Idempotent; runs on every exit path. */
  function releaseControl(): void {
    phase = "terminal";
    if (runTimer) clearTimeout(runTimer);
    runTimer = undefined;
    signal?.removeEventListener("abort", onParentAbort);
    unregister?.();
  }

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
  let liveTail: LiveTail = CLEARED_LIVE_TAIL;
  let modelName: string | undefined;
  let thinkingLevel: string | undefined;
  // Read once per spawn; bound only what pi persists (tool result + terminal onUpdate).
  const limits = getResultLimits();
  /**
   * The final assistant message, overwritten on each assistant `message_end`.
   * It alone decides the outcome (pi has already retried by the time
   * `prompt()` resolves). See change: harden-subagent-lifecycle.
   */
  let lastAssistant: { stopReason?: string; errorMessage?: string; text: string } | undefined;
  /**
   * pi's own auto-retry, observed (never driven). `retries` sums every
   * scheduled attempt; `lastRetrySequence` is the most recent sequence, whose
   * `success === false` decorates a final failure. See change:
   * surface-subagent-retries.
   */
  let retries = 0;
  let lastRetrySequence: { attempts: number; success?: boolean } | undefined;

  /**
   * The ONLY way a step joins the timeline: push, then announce it once on
   * `subagents:entry` (synchronous, never throttled). Steps are never mutated
   * or removed afterwards, so `index` is stable.
   */
  function appendEntry(entry: SubagentTimelineEntry, blockId?: number): void {
    entries.push(entry);
    emitSubagentEntry(pi, {
      agentId,
      toolCallId,
      index: entries.length - 1,
      entry,
      ...(blockId !== undefined ? { blockId } : {}),
    });
    runOpts.onEntry?.(entry);
  }

  // Append-only pieces of the streaming block on `subagents:delta`. Closed
  // BEFORE the block's entry is appended, so the final piece always precedes
  // `subagents:entry`. See change: emit-subagent-block-deltas.
  const blockDeltas = createBlockDeltaEmitter((piece) =>
    emitSubagentDelta(pi, { agentId, toolCallId, ...piece }),
  );

  const tracker = createToolCallTracker();
  const usage = createUsageAccumulator();
  // One throttled emitter feeding BOTH legs (dashboard progress + the tool's
  // `onUpdate`), so a chatty child cannot flood the parent's event loop.
  const progressSink = (details: AgentDetails): void => {
    emitSubagentProgress(pi, { agentId, details });
    onUpdate?.({
      content: [{ type: "text", text: activity ?? "(running…)" }],
      details,
    });
  };
  const progress = createProgressEmitter(progressSink);
  /**
   * Queue frames go to the tool's `onUpdate` ONLY: re-pushing every waiter on
   * the bus would grow bus volume with the square of the queue length. Bus
   * consumers get the initial place on `subagents:created`.
   */
  function pushQueuedFrame(details: AgentDetails): void {
    onUpdate?.({
      content: [{ type: "text", text: `queued #${details.queuePosition ?? "?"}` }],
      details,
    });
  }

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
      liveTail: status === "running" ? liveTail : CLEARED_LIVE_TAIL,
      entries: entries.slice(),
      toolUses,
      tokensTotal: usage.totals().total,
      tokensUsage: usage.totals(),
      turnCount,
      startedAt,
      modelName,
      thinkingLevel: (session as { thinkingLevel?: string } | undefined)?.thinkingLevel ?? thinkingLevel,
      agentMdPath,
      agentMdSource,
      agentMdPkg,
      error,
      stoppable: true,
      ...(status === "queued"
        ? {
            queuePosition: queueInfo?.queuePosition,
            activeSlots: queueInfo?.activeSlots ?? activeSpawns,
            maxConcurrent: queueInfo?.maxConcurrent ?? getMaxConcurrent(),
          }
        : {}),
      slotGrantedAt,
      background,
      retries,
      cwd,
    });
  }

  function pushUpdate(status: AgentStatus): void {
    // Lazy: coalesced events never build a details snapshot.
    progress.schedule(() => snapshotDetails(status));
  }

  /**
   * Terminal snapshot for the tool's `onUpdate` leg. Always delivered
   * synchronously (the throttle window never swallows a final state).
   */
  function pushTerminalUpdate(details: AgentDetails): void {
    onUpdate?.({
      content: [{ type: "text", text: details.error ?? activity ?? "(done)" }],
      details: boundToolResult("", details, limits).details,
    });
  }

  /**
   * `subagents:before_store`: a plugin may replace the terminal result text
   * before it is emitted, bounded, stored or returned.
   */
  function storeText(status: AgentStatus, result: string): string {
    const id = runOpts.backgroundId?.();
    return runBeforeStore(pi, { ...(id ? { id } : {}), agentId, background, status, result });
  }

  /**
   * Terminal failure: emit `subagents:failed` (full details), flush the
   * terminal `onUpdate`, and return a bounded error result.
   */
  function failWith(
    status: "aborted" | "error",
    message: string,
    resultText: string,
  ): AgentToolResultWithError<AgentDetails> {
    const details = snapshotDetails(status, message);
    const text = storeText(status, resultText);
    emitSubagentFailed(pi, {
      agentId,
      error: message,
      durationMs: Date.now() - startedAt,
      toolUses,
      details,
    });
    pushTerminalUpdate(details);
    const bounded = boundToolResult(text, details, limits);
    return errorResult(bounded.text, bounded.details);
  }

  /**
   * User/plugin stop (`subagents:stop`): `subagents:completed` with
   * `status: "stopped"` and a NON-error result, so the parent turn goes on.
   * See change: manage-subagent-spawn-queue.
   */
  function stopWith(stopPhase: "queued" | "running", stoppedBy: StopSource): AgentToolResultWithError<AgentDetails> {
    const partial = stopPhase === "running" ? (lastAssistant?.text.trim() ?? "") : "";
    const resultText = storeText(
      "stopped",
      stopPhase === "queued"
        ? "Subagent removed from queue before starting."
        : partial
          ? `Subagent stopped by user.\n\n${partial}`
          : "Subagent stopped by user.",
    );
    const details: AgentDetails = { ...snapshotDetails("stopped"), stopReason: stopPhase, stoppedBy };
    emitSubagentCompleted(pi, {
      agentId,
      result: resultText,
      durationMs: Date.now() - startedAt,
      tokens: usage.totals(),
      toolUses,
      details,
    });
    pushTerminalUpdate(details);
    const bounded = boundToolResult(resultText, details, limits);
    return { content: [{ type: "text", text: bounded.text }], details: bounded.details };
  }

  /** Outcome once the run's own signal aborted: whichever reason came first. */
  function endedByAbort(): AgentToolResultWithError<AgentDetails> {
    if (endReason && endReason !== "parent") return stopWith(endReason.stop, endReason.by);
    return failWith("aborted", "aborted by parent", "Subagent aborted by parent.");
  }

  /**
   * The child's `ask_parent` tool (design D9 + D12): post the question, give
   * the slot back while waiting (no timeout), re-acquire it with priority on
   * the answer. Any stop settles the ask.
   */
  function makeAskParentTool() {
    return defineTool({
      name: ASK_PARENT_TOOL_NAME,
      label: ASK_PARENT_TOOL_NAME,
      description:
        "Ask your parent agent a question when you need a decision you cannot make yourself. Blocks until the parent answers (no timeout). " +
        "Ask only when truly blocked; otherwise decide, state your assumption, and continue.",
      parameters: Type.Object({ question: Type.String({ description: "One clear question with the options you see." }) }),
      async execute(
        _toolCallId: string,
        rawParams: { question: string },
        toolSignal: AbortSignal | undefined,
      ): Promise<AgentToolResultWithError<{ question_id?: string }>> {
        const question = typeof rawParams.question === "string" ? rawParams.question.trim() : "";
        if (!question) {
          return { content: [{ type: "text" as const, text: "ask_parent: question is required." }], details: {}, isError: true };
        }
        const pending = runOpts.ask!(question);
        releaseSlot?.();
        releaseSlot = undefined;
        runOpts.onSlot?.("released");
        let answer: string;
        try {
          answer = await untilAborted(pending.answer, [ctrl.signal, toolSignal]);
        } catch (err) {
          pending.cancel();
          throw err;
        }
        let queued = false;
        releaseSlot = await acquireSpawnSlot(
          ctrl.signal,
          (info) => {
            if (queued) return;
            queued = true;
            runOpts.onSlot?.("reacquire_queued", info.queuePosition);
          },
          "resume",
        );
        runOpts.onSlot?.("reacquired");
        return { content: [{ type: "text" as const, text: answer }], details: { question_id: pending.questionId } };
      },
    });
  }

  // ── Concurrency gate ──
  // Requested synchronously so the created snapshot already carries this
  // call's queue position; awaited AFTER the card is on screen and BEFORE
  // any loader / session work, so queued spawns cost nothing but a promise.
  let announced = false;
  const slot = acquireSpawnSlot(
    ctrl.signal,
    (info) => {
      queueInfo = info;
      // Batched queue frames bypass the throttle: one per waiter per change.
      if (announced && phase === "queued") pushQueuedFrame(snapshotDetails("queued"));
    },
    runOpts.background ? "background" : "foreground",
  );
  slot.catch(() => {}); // handled at the await below

  // Emit created BEFORE we touch any other infrastructure so the dashboard
  // gets a card on screen as fast as possible.
  const initialDetails = snapshotDetails("queued");
  emitSubagentCreated(pi, {
    agentId,
    type: args.subagent_type,
    description: args.description,
    details: initialDetails,
  });
  announced = true;
  if (queueInfo) pushQueuedFrame(initialDetails); // waiting: give the tool card its place

  let releaseSlot: (() => void) | undefined;
  try {
    releaseSlot = await slot;
    phase = "running";
    slotGrantedAt = Date.now();
    queueInfo = undefined;
    runOpts.onRunning?.();
    // Run-time limit counts from slot grant, so queue time is free (D8).
    if (runOpts.timeoutMs && runOpts.timeoutMs > 0) {
      runTimer = setTimeout(() => requestStop("timeout"), runOpts.timeoutMs);
    }
  } catch (err) {
    // Only an abort-while-queued is expected here; anything else is reported
    // as a genuine failure rather than masquerading as a parent abort.
    progress.dispose();
    try {
      if (err instanceof SpawnAbortedError) return endedByAbort();
      const message = err instanceof Error ? err.message : String(err);
      return failWith("error", message, `Subagent failed: ${message}`);
    } finally {
      releaseControl();
    }
  }

  try {
    // Stop may land between slot grant and here.
    throwIfAborted(ctrl.signal);
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
        return failWith(
          "error",
          resolution.error ?? "Model resolution failed",
          resolution.error ?? `Could not resolve model reference "${effectiveModelRef}".`,
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
    // Project trust is resolved for the child's own cwd and never prompts;
    // untrusted → no project settings / extensions / SYSTEM.md. See change:
    // add-subagent-orchestration (D3).
    const settingsManager = SettingsManager.create(cwd, getAgentDir(), {
      projectTrusted: resolveChildProjectTrust(cwd, getAgentDir()),
    });
    const resourceLoader = await createChildLoader(cwd, settingsManager);
    // pi's session.abort() is a no-op before a run starts, so a Stop pressed
    // during construction must be checked here, not relayed.
    throwIfAborted(ctrl.signal);
    const askTool = runOpts.ask ? makeAskParentTool() : undefined;
    const parentRuntime = getParentModelRuntime(ctx);
    const effectiveThinking: ThinkingLevelString | undefined =
      resolvedThinkingLevel ??
      (ctx.thinkingLevel as ThinkingLevelString | undefined) ??
      (pi.getThinkingLevel?.() as ThinkingLevelString | undefined);
    const createResult = await createAgentSession({
      cwd,
      sessionManager,
      settingsManager,
      // Background children may ask the parent (design D9).
      ...(askTool ? { customTools: [askTool] } : {}),
      // Lean, per-child loader — full extension isolation, no skills/prompt
      // templates/themes (design Decision 1). Without this the SDK builds a
      // full DefaultResourceLoader per child, in the parent's event loop.
      resourceLoader,
      // Inherit the parent's live model runtime so the subagent sees every
      // provider registered on it, including custom providers from
      // providers.json (models AND auth). Without it, createAgentSession
      // builds a fresh disk-only runtime and fails with "No API key found
      // for <provider>". (pi >=0.80.8 removed the modelRegistry/authStorage
      // options; only `modelRuntime` is honored.)
      ...(parentRuntime ? { modelRuntime: parentRuntime } : {}),
      // No ref -> the parent's LIVE model (ctx.model). Without it the SDK
      // falls back to settings `defaultModel`, not what the parent runs.
      ...(resolvedModel ?? ctx.model ? { model: resolvedModel ?? ctx.model } : {}),
      // Precedence: explicit ref suffix > parent's live level > pi defaults.
      // `off` is passed through so it isn't replaced by settings defaults.
      ...(effectiveThinking ? { thinkingLevel: effectiveThinking } : {}),
    });
    session = createResult.session; // assigned first: `finally` disposes it
    throwIfAborted(ctrl.signal);
    modelName = session.model?.id;
    // Requested level; snapshots prefer the session's live (possibly clamped) one.
    thinkingLevel = effectiveThinking;

    // ── Tool allowlist ──
    // Always strip the `Agent` tool to prevent recursive nesting. When
    // frontmatter provides a `tools:` allowlist, intersect it with the
    // session's active tool set (so unknown names in the allowlist are
    // silently dropped — a typo doesn't crash the spawn) and apply via
    // `setActiveToolsByName`. Otherwise keep every tool the parent has
    // except `Agent` (unchanged pre-frontmatter behavior).
    const availableTools = session
      .getActiveToolNames()
      .filter((n) => !SUBAGENT_MANAGEMENT_TOOLS.includes(n));
    const activeTools = agentConfig?.tools
      ? availableTools.filter((n) => agentConfig.tools!.includes(n))
      : availableTools;
    // `ask_parent` survives a frontmatter allowlist: it is how a background
    // child reaches its parent, not a capability the .md opts into.
    if (askTool && !activeTools.includes(ASK_PARENT_TOOL_NAME)) activeTools.push(ASK_PARENT_TOOL_NAME);
    session.setActiveToolsByName(activeTools);
    if (background) {
      const live = session;
      runOpts.onSession?.({
        steer: (m) => live.steer(m),
        followUp: (m) => live.followUp(m),
      });
    }

    // ── Subscribe to events and accumulate the timeline ──
    //
    // Important: call `tracker.onEvent(event)` EXACTLY ONCE per event.
    // It is destructive on `tool_execution_end` (deletes the pairing entry).
    unsubscribe = session.subscribe((event: AgentSessionEvent) => {
      // ── pi auto-retry (observed only) ──
      // A provider error reaches the child only as an errored `message_end`,
      // so the `retry` entry is the timeline's record of the failed attempt.
      const retryEntry = retryEntryFromEvent(event);
      if (retryEntry && retryEntry.kind === "retry") {
        blockDeltas.close();
        appendEntry(retryEntry);
        retries += 1;
        lastRetrySequence = { attempts: retryEntry.attempt };
        emitSubagentRetry(pi, {
          agentId,
          toolCallId,
          phase: "scheduled",
          attempt: retryEntry.attempt,
          maxAttempts: retryEntry.maxAttempts,
          delayMs: retryEntry.delayMs,
          error: retryEntry.text,
          retries,
        });
        activity = `retrying (attempt ${retryEntry.attempt}/${retryEntry.maxAttempts}) in ${formatRetryDelay(retryEntry.delayMs)}…`;
        liveTail = CLEARED_LIVE_TAIL;
        pushUpdate("running");
        return;
      }
      if ((event as { type?: string }).type === "auto_retry_end") {
        const end = event as { success?: unknown; attempt?: unknown; finalError?: unknown };
        const success = end.success === true;
        const attempt =
          typeof end.attempt === "number" && end.attempt > 0 ? end.attempt : (lastRetrySequence?.attempts ?? 0);
        if (lastRetrySequence) {
          lastRetrySequence.success = success;
          lastRetrySequence.attempts = attempt;
        }
        emitSubagentRetry(pi, {
          agentId,
          toolCallId,
          phase: "ended",
          attempt,
          success,
          ...(!success && typeof end.finalError === "string" ? { finalError: end.finalError } : {}),
          retries,
        });
        return;
      }

      usage.observe(event);
      const pairing = tracker.onEvent(event); // null on non-tool, { input } on end
      const newActivity = activityFromEvent(event);
      if (newActivity !== undefined) activity = newActivity ?? undefined;
      liveTail = nextLiveTail(liveTail, event);

      let closedBlockId: number | undefined;
      if (event.type === "message_update") {
        const e = event.assistantMessageEvent as { type: string; delta?: string };
        if (e.type === "thinking_start") blockDeltas.open("thinking");
        else if (e.type === "text_start") blockDeltas.open("text");
        else if (e.type === "thinking_delta") blockDeltas.push("thinking", e.delta ?? "");
        else if (e.type === "text_delta") blockDeltas.push("text", e.delta ?? "");
        else if (e.type === "thinking_end" || e.type === "text_end") closedBlockId = blockDeltas.close();
      } else if (event.type === "message_end") {
        blockDeltas.close(); // before any backfilled entry
      }

      if (event.type === "tool_execution_end") {
        const entry = mapSessionEventToEntry(event);
        if (entry && entry.kind === "tool") {
          entry.input = pairing?.input;
          appendEntry(entry);
          toolUses += 1;
        }
      } else if (event.type === "message_update") {
        const entry = mapSessionEventToEntry(event);
        if (entry) appendEntry(entry, entry.kind === "error" ? undefined : closedBlockId);
      } else if (event.type === "message_end") {
        const msg = event.message as { role: string; content?: unknown };
        if (msg.role === "assistant") {
          turnCount += 1;
          const am = msg as { stopReason?: string; errorMessage?: string };
          lastAssistant = {
            stopReason: am.stopReason,
            errorMessage: am.errorMessage,
            text: assistantText(msg.content),
          };
          // Backfill text / thinking entries from message_end content blocks
          // when streaming `text_end` / `thinking_end` events were NOT
          // emitted. Some providers (e.g. DeepSeek non-streaming responses)
          // deliver the entire assistant message in `message_end` only,
          // never firing the streaming end events. Without this backfill
          // the timeline shows only tools + reasoning, never assistant
          // text entries.
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
                  appendEntry({ kind: "text", text: block.text, ts: now });
                } else if (
                  block.type === "thinking" &&
                  typeof block.thinking === "string" &&
                  block.thinking &&
                  !block.redacted
                ) {
                  appendEntry({ kind: "thinking", text: block.thinking, ts: now });
                }
              }
            }
          }
        }
      }

      pushUpdate("running");
    });

    // ── Wire this run's abort (parent or stop) to the subagent ──
    const onAbort = () => {
      void session?.abort();
    };
    abortHandler = onAbort;
    if (ctrl.signal.aborted) onAbort();
    else ctrl.signal.addEventListener("abort", onAbort, { once: true });

    /** Outcome of the run that just ended: the final assistant message decides. */
    function runOutcome(): AgentToolResultWithError<AgentDetails> {
      // Only an errored final reply can be the end of a failed retry sequence.
      const failure = withRetrySuffix(
        finalReplyFailure(lastAssistant),
        lastAssistant?.stopReason === "error" ? lastRetrySequence : undefined,
      );
      if (failure) return failWith("error", failure, `Subagent failed: ${failure}`);
      const finalText = storeText("completed", lastAssistant!.text);
      const completedDetails = snapshotDetails("completed");
      emitSubagentCompleted(pi, {
        agentId,
        result: finalText,
        durationMs: Date.now() - startedAt,
        tokens: usage.totals(),
        toolUses,
        details: completedDetails,
      });
      pushTerminalUpdate(completedDetails);
      const bounded = boundToolResult(finalText, completedDetails, limits);
      return {
        content: [{ type: "text", text: bounded.text }],
        details: bounded.details,
      };
    }

    /**
     * Park a finished background run as `idle` (design D5): release the slot,
     * hand the caller a handle, and wait. Resolves with the next prompt
     * (slot re-acquired) or undefined once disposed.
     */
    async function parkIdle(result: AgentToolResultWithError<AgentDetails>): Promise<string | undefined> {
      releaseSlot?.();
      releaseSlot = undefined;
      if (runTimer) clearTimeout(runTimer);
      runTimer = undefined;
      phase = "idle";
      lastAssistant = undefined;
      const next = await new Promise<{ message: string; slot: Promise<() => void> } | undefined>((resolve) => {
        idleHandle = {
          continueWith(message) {
            let queued = false;
            const slot = acquireSpawnSlot(
              ctrl.signal,
              (info) => {
                queued = true;
                queueInfo = info;
              },
              "background",
            );
            slot.catch(() => {}); // handled at the await below
            phase = "queued";
            idleHandle = undefined;
            resolve({ message, slot });
            return queued ? "queued" : "started";
          },
          dispose(reason) {
            if (!idleHandle) return;
            idleHandle = undefined;
            resolve(undefined);
            runOpts.onIdleDisposed?.(reason);
          },
        };
        runOpts.onIdle?.(result, idleHandle);
      });
      if (!next) return undefined;
      releaseSlot = await next.slot; // rejects (SpawnAbortedError) on a stop while re-queued
      phase = "running";
      startedAt = Date.now();
      slotGrantedAt = startedAt;
      queueInfo = undefined;
      runOpts.onRunning?.();
      if (runOpts.timeoutMs && runOpts.timeoutMs > 0) {
        runTimer = setTimeout(() => requestStop("timeout"), runOpts.timeoutMs);
      }
      return next.message;
    }

    let prompt = effectivePrompt;
    for (;;) {
      // ── Announce running ──
      const startDetails = snapshotDetails("running");
      emitSubagentStarted(pi, {
        agentId,
        type: args.subagent_type,
        description: args.description,
        details: startDetails,
      });

      // ── Run the subagent turn(s) ──
      await session.prompt(prompt);

      // ── Aborted (parent) or stopped (`subagents:stop`)? ──
      if (endReason) {
        blockDeltas.dispose();
        progress.flush();
        return endedByAbort();
      }

      blockDeltas.close();
      progress.flush();
      const result = runOutcome();
      // Foreground runs, and background runs with keep-alive off, end here.
      if (!background || !runOpts.keepAlive?.()) return result;
      const nextPrompt = await parkIdle(result);
      if (nextPrompt === undefined) return result; // disposed: ttl, cap, cancel or shutdown
      prompt = nextPrompt;
    }
  } catch (err) {
    blockDeltas.dispose();
    progress.flush();
    // A child that rejects because it was aborted reports the abort reason.
    if (err instanceof SpawnAbortedError || endReason) return endedByAbort();
    const message = err instanceof Error ? err.message : String(err);
    return failWith("error", message, `Subagent failed: ${message}`);
  } finally {
    releaseControl();
    releaseSlot?.();
    if (abortHandler) ctrl.signal.removeEventListener("abort", abortHandler);
    if (unsubscribe) {
      try {
        unsubscribe();
      } catch {
        /* ignore */
      }
    }
    blockDeltas.dispose(); // idempotent; clears any trailing timer
    progress.dispose();
    try {
      session?.dispose();
    } catch {
      /* ignore */
    }
  }
}

/** Joined text blocks of an assistant message's content (string content passes through). */
function assistantText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((b: { type?: string; text?: unknown }) => b?.type === "text" && typeof b.text === "string")
    .map((b: { text: string }) => b.text)
    .join("\n");
}

/**
 * Why the final assistant message makes the run fail, or `undefined` when it
 * succeeds. Earlier turns never count. See change: harden-subagent-lifecycle.
 */
function finalReplyFailure(
  last: { stopReason?: string; errorMessage?: string; text: string } | undefined,
): string | undefined {
  if (last?.stopReason === "error") return last.errorMessage || "subagent's final reply errored";
  if (last?.stopReason === "aborted") return last.errorMessage || "subagent run was aborted";
  if (!last || last.text.trim() === "") return "subagent produced no final output";
  return undefined;
}

/**
 * Add ` (after N retries)` to a final failure when the last retry sequence
 * ended unsuccessfully. A recovered earlier sequence never decorates a later
 * unrelated failure. See change: surface-subagent-retries.
 */
export function withRetrySuffix(
  failure: string | undefined,
  seq: { attempts: number; success?: boolean } | undefined,
): string | undefined {
  if (!failure || !seq || seq.success !== false || seq.attempts <= 0) return failure;
  return `${failure} (after ${seq.attempts} ${seq.attempts === 1 ? "retry" : "retries"})`;
}

/** Throw `SpawnAbortedError` once the parent signal has aborted. */
function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new SpawnAbortedError("aborted by parent");
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
  const exposeIsolated = shouldExposeInheritanceInTool();
  // Per-activation: a stop on this session's bus reaches only its subagents.
  const controls = createAgentControlRegistry();
  // Read once: the tool surface is fixed for the activation (D3).
  const background = isBackgroundAllowed()
    ? createBackgroundRegistry({
        cutEntry: (e) => cutEntry(e, getResultLimits().entryFieldMaxChars),
      })
    : undefined;
  const orchestrator = background
    ? createOrchestrator({
        pi,
        registry: background,
        idleTtlSec: getBackgroundIdleTtlSec,
        maxIdle: getMaxIdleBackground,
        notifyParent: isNotifyParentEnabled,
      })
    : undefined;
  pi.registerTool(makeAgentTool(pi, exposeIsolated, controls, background, orchestrator));
  if (background && orchestrator) {
    // One tool for every background action (design D0).
    pi.registerTool(
      makeAgentControlTool({
        pi,
        registry: background,
        stopAgent: (agentId, by) => controls.stop(agentId, by).outcome === "stopped",
        disposeIdle: (record) => orchestrator.dispose(record, "cancel"),
        orchestrator,
        isForeground: (id) => controls.has(id) && typeof background.lookup(id) === "string",
      }),
    );
    // Stop every outstanding background subagent when the session ends (D9).
    // Idempotent: a second call finds nothing outstanding to stop.
    pi.on("session_shutdown", () => {
      orchestrator.shutdown(); // no push afterwards; settles pending asks
      for (const r of background.outstanding()) controls.stop(r.agentId, "shutdown");
      orchestrator.disposeAll("shutdown");
      return undefined;
    });

    // Query channels (D10): answer only when no other activation has, and
    // only from this activation's registry. Reads here never mark results read.
    onGuarded(pi, SUBAGENT_CHANNELS.list, (data) => {
      const q = data as ListQueryPayload | undefined;
      if (!q || typeof q !== "object" || q.out !== undefined) return;
      const status = q.filter?.status;
      const now = Date.now();
      q.out = background
        .list()
        .filter((r) => !status || r.status === status)
        .map((r) => summaryOf(r, now));
    });
    onGuarded(pi, SUBAGENT_CHANNELS.get, (data) => {
      const q = data as GetQueryPayload | undefined;
      if (!q || typeof q !== "object" || q.out !== undefined || typeof q.id !== "string") return;
      const hit = background.lookup(q.id);
      if (typeof hit === "string") return; // unknown here: another activation may own it
      q.out = { status: statusOf(hit), messages: messagesPage(hit, q) };
    });
  }

  // `subagents:stop { agentId }` stops one queued or running subagent.
  // See change: manage-subagent-spawn-queue.
  const bus = pi.events as { on?: (channel: string, h: (data: unknown) => void) => unknown } | undefined;
  if (typeof bus?.on === "function") {
    bus.on("subagents:stop", (data) => {
      controls.stop((data as { agentId?: unknown } | undefined)?.agentId);
    });
  }

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
