/**
 * Settings layer — persists extension-level config in
 *   ~/.pi/agent/extensions/pi-dashboard-subagents/config.json
 *
 * Design:
 *   - In-memory cache, loaded lazily on first access.
 *   - Atomic writes via tmp-file rename.
 *   - Defaults baked in so missing file / fields never throw.
 *
 * Two settings shape how subagents inherit context:
 *
 *   inheritContext           Whether subagents inherit parent context by default.
 *                            true  → inherited, compressed.
 *                            false → isolated, fresh conversation.
 *
 *   exposeInheritanceInTool  Whether the Agent tool's JSON schema includes
 *                            an `isolated` parameter that lets the LLM override
 *                            the default on a per-call basis.
 *                            false (default) → schema is fixed, LLM cannot override.
 *                            true            → schema exposes `isolated`,
 *                                              LLM can flip inheritance per spawn.
 *
 * Rationale: keeping the tool schema lean (exposeInheritanceInTool: false)
 * is the right choice for most users. The LLM doesn't need yet another knob,
 * and the user retains firm control via the global setting. Power users who
 * want the LLM to make per-task decisions can flip the expose flag on.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { getAgentDir } from "@earendil-works/pi-coding-agent";

// ─── Schema ──────────────────────────────────────────────────────────────

/** Compression knobs applied when inheriting parent context. Global-only. */
export interface InheritanceCompressionSettings {
  /** Number of recent (user, assistant) turn pairs to keep verbatim. */
  recentTurns: number;
  /** Turns from the end where tool outputs are kept verbatim. */
  toolOutputWindow: number;
  /** Hard cap on the compressed context's character count. */
  maxChars: number;
}

/** Top-level settings for this extension. */
export interface DashboardAgentSettings {
  /**
   * Whether subagents inherit parent context by default.
   * Default: true.
   */
  inheritContext: boolean;
  /**
   * Whether the Agent tool's JSON schema exposes an `isolated` parameter,
   * letting the LLM override inheritance per-call. When false, the schema
   * omits the parameter entirely and the global setting always applies.
   * Default: false.
   */
  exposeInheritanceInTool: boolean;
  /** Compression knobs applied when inheriting (global-only, not per-call). */
  inheritance: InheritanceCompressionSettings;
  /**
   * Maximum number of subagent sessions running at once in this process.
   * Excess spawns wait FIFO in `queued` status. `0` = unlimited.
   * Default: 4.
   */
  maxConcurrent: number;
  /**
   * Size limits on the tool result pi persists to the parent session
   * (`0` = unlimited). Bus events are never bounded.
   * See change: harden-subagent-lifecycle.
   */
  resultMaxChars: number;
  detailsMaxChars: number;
  entryFieldMaxChars: number;
}

/** The three result-size limits, as read by `getResultLimits()`. */
export type ResultLimits = Pick<
  DashboardAgentSettings,
  "resultMaxChars" | "detailsMaxChars" | "entryFieldMaxChars"
>;

export const DEFAULT_SETTINGS: DashboardAgentSettings = Object.freeze({
  inheritContext: true,
  exposeInheritanceInTool: false,
  inheritance: Object.freeze({
    recentTurns: 6,
    toolOutputWindow: 2,
    maxChars: 24_000,
  }) as InheritanceCompressionSettings,
  maxConcurrent: 4,
  resultMaxChars: 16_000,
  detailsMaxChars: 20_000,
  entryFieldMaxChars: 2_000,
}) as DashboardAgentSettings;

// ─── Storage location ────────────────────────────────────────────────────

const EXTENSION_NAME = "pi-dashboard-subagents";

/** Resolve config file path: ~/.pi/agent/extensions/pi-dashboard-subagents/config.json */
export function getSettingsPath(): string {
  return join(getAgentDir(), "extensions", EXTENSION_NAME, "config.json");
}

// ─── Cache ───────────────────────────────────────────────────────────────

let cached: DashboardAgentSettings | undefined;
/** mtime of the config file at the time `cached` was populated. */
let cachedMtimeMs: number | undefined;

/** Force-reload from disk on next read. Tests + reload-after-write use this. */
export function invalidateSettingsCache(): void {
  cached = undefined;
  cachedMtimeMs = undefined;
}

/** Current mtime of the config file, or undefined when absent/unreadable. */
function configMtimeMs(): number | undefined {
  try {
    const path = getSettingsPath();
    return existsSync(path) ? statSync(path).mtimeMs : undefined;
  } catch {
    return undefined;
  }
}

// ─── Read ────────────────────────────────────────────────────────────────

/**
 * Load settings from disk, merging with defaults. Missing file → defaults.
 * Malformed JSON → defaults (logs to stderr; never throws).
 * Result is cached in-memory; subsequent calls are free.
 */
export function loadSettings(): DashboardAgentSettings {
  if (cached) return cached;
  const path = getSettingsPath();
  cachedMtimeMs = configMtimeMs();
  if (!existsSync(path)) {
    cached = mergeWithDefaults({});
    return cached;
  }
  try {
    const raw = readFileSync(path, "utf-8");
    const parsed = JSON.parse(raw) as Partial<DashboardAgentSettings>;
    cached = mergeWithDefaults(parsed);
  } catch (err) {
    console.warn(
      `[${EXTENSION_NAME}] Failed to load settings from ${path}:`,
      err instanceof Error ? err.message : err,
    );
    cached = mergeWithDefaults({});
  }
  return cached;
}

function mergeWithDefaults(partial: Partial<DashboardAgentSettings>): DashboardAgentSettings {
  return {
    inheritContext: partial.inheritContext ?? DEFAULT_SETTINGS.inheritContext,
    exposeInheritanceInTool: partial.exposeInheritanceInTool ?? DEFAULT_SETTINGS.exposeInheritanceInTool,
    inheritance: {
      recentTurns: partial.inheritance?.recentTurns ?? DEFAULT_SETTINGS.inheritance.recentTurns,
      toolOutputWindow: partial.inheritance?.toolOutputWindow ?? DEFAULT_SETTINGS.inheritance.toolOutputWindow,
      maxChars: partial.inheritance?.maxChars ?? DEFAULT_SETTINGS.inheritance.maxChars,
    },
    maxConcurrent: coerceMaxConcurrent(partial.maxConcurrent),
    resultMaxChars: coerceLimit(partial.resultMaxChars, DEFAULT_SETTINGS.resultMaxChars),
    detailsMaxChars: coerceLimit(partial.detailsMaxChars, DEFAULT_SETTINGS.detailsMaxChars),
    entryFieldMaxChars: coerceLimit(partial.entryFieldMaxChars, DEFAULT_SETTINGS.entryFieldMaxChars),
  };
}

/** Non-number, non-finite or negative values fall back to `fallback`. `0` is valid (unlimited). */
function coerceLimit(value: unknown, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return fallback;
  return Math.floor(value);
}

function coerceMaxConcurrent(value: unknown): number {
  return coerceLimit(value, DEFAULT_SETTINGS.maxConcurrent);
}

// ─── Write ───────────────────────────────────────────────────────────────

/**
 * Persist a partial update. Reads current settings, merges, writes atomically,
 * refreshes the in-memory cache. Returns the new full settings object.
 */
export function saveSettings(patch: Partial<DashboardAgentSettings>): DashboardAgentSettings {
  const current = loadSettings();
  const next: DashboardAgentSettings = {
    inheritContext: patch.inheritContext ?? current.inheritContext,
    exposeInheritanceInTool: patch.exposeInheritanceInTool ?? current.exposeInheritanceInTool,
    inheritance: {
      recentTurns: patch.inheritance?.recentTurns ?? current.inheritance.recentTurns,
      toolOutputWindow: patch.inheritance?.toolOutputWindow ?? current.inheritance.toolOutputWindow,
      maxChars: patch.inheritance?.maxChars ?? current.inheritance.maxChars,
    },
    maxConcurrent:
      patch.maxConcurrent === undefined
        ? current.maxConcurrent
        : coerceMaxConcurrent(patch.maxConcurrent),
    resultMaxChars: coerceLimit(patch.resultMaxChars ?? current.resultMaxChars, current.resultMaxChars),
    detailsMaxChars: coerceLimit(patch.detailsMaxChars ?? current.detailsMaxChars, current.detailsMaxChars),
    entryFieldMaxChars: coerceLimit(
      patch.entryFieldMaxChars ?? current.entryFieldMaxChars,
      current.entryFieldMaxChars,
    ),
  };
  writeSettingsToDisk(next);
  cached = next;
  return next;
}

function writeSettingsToDisk(settings: DashboardAgentSettings): void {
  const path = getSettingsPath();
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, JSON.stringify(settings, null, 2) + "\n", { encoding: "utf-8" });
  renameSync(tmp, path);
}

// ─── Convenience getters ─────────────────────────────────────────────────

/** Returns true when inheritance is on for new spawns by default. */
export function shouldInheritByDefault(): boolean {
  return loadSettings().inheritContext;
}

/**
 * Returns true when the Agent tool's schema should include the `isolated`
 * parameter so the LLM can override the default per-call. Use this when
 * building your TypeBox schema for the tool: include the property
 * conditionally on this result.
 */
export function shouldExposeInheritanceInTool(): boolean {
  return loadSettings().exposeInheritanceInTool;
}

/**
 * Resolve the effective `isolated` value for a single spawn.
 *
 *   - If `exposeInheritanceInTool` is OFF: ignore the per-call value entirely
 *     (the LLM shouldn't have been able to set it; we treat it as absent).
 *     The global `inheritContext` setting wins.
 *
 *   - If `exposeInheritanceInTool` is ON: honor the per-call value when
 *     explicitly set. Falls back to the global setting when undefined.
 *
 * @param perCall  the value the LLM passed in (if the schema exposed it)
 */
export function resolveIsolated(perCall: boolean | undefined): boolean {
  const s = loadSettings();
  if (!s.exposeInheritanceInTool) return !s.inheritContext;
  if (typeof perCall === "boolean") return perCall;
  return !s.inheritContext;
}

/**
 * Compression knobs used for every inherited spawn. Global-only (these
 * are not exposed to the LLM under any setting — they're operator-controlled).
 */
export function getInheritanceCompression(): InheritanceCompressionSettings {
  return loadSettings().inheritance;
}

/**
 * Maximum number of subagents allowed to run at once (`0` = unlimited).
 * Read per spawn, so edits to the config file apply without `/reload`
 * (subject to the settings cache being invalidated).
 */
export function getMaxConcurrent(): number {
  // Re-read when the config file changed on disk so operators can retune the
  // cap without `/reload` (spec: "setting is read per call").
  refreshIfConfigChanged();
  return loadSettings().maxConcurrent;
}

/**
 * Result-size limits for the persisted tool result (`0` = unlimited). Read
 * per spawn like `getMaxConcurrent`. See change: harden-subagent-lifecycle.
 */
export function getResultLimits(): ResultLimits {
  refreshIfConfigChanged();
  const s = loadSettings();
  return {
    resultMaxChars: s.resultMaxChars,
    detailsMaxChars: s.detailsMaxChars,
    entryFieldMaxChars: s.entryFieldMaxChars,
  };
}

function refreshIfConfigChanged(): void {
  if (configMtimeMs() !== cachedMtimeMs) invalidateSettingsCache();
}
