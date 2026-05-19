/**
 * Emission layer — everything the dashboard bridge needs to render
 * foreground subagent cards (with timeline) and pop them out into a
 * new tab/window.
 *
 * Scope: FOREGROUND ONLY.
 *   - No background spawning
 *   - No get_subagent_result tool
 *   - No steer_subagent tool
 *
 * The bridge intercepts pi.events.emit() and forwards via this rename map:
 *   subagents:created   → subagent_created
 *   subagents:started   → subagent_started
 *   subagents:completed → subagent_completed
 *   subagents:failed    → subagent_failed
 *
 * The dashboard reducer routes by `data.id` into SessionState.subagents
 * and reads `data.details` for the card. `data.details.entries[]` is the
 * Tier-1 timeline (tool calls, reasoning, assistant text, errors).
 */

import type { ExtensionAPI, ExtensionContext, SessionEntry } from "@mariozechner/pi-coding-agent";
import type { AgentSessionEvent } from "@mariozechner/pi-coding-agent";
import type { AssistantMessage } from "@mariozechner/pi-ai";

// ─── Types matching dashboard's wire contract ────────────────────────────

export type SubagentTimelineEntry =
  | { kind: "tool"; toolName: string; input: unknown; output?: unknown; isError?: boolean; ts: number }
  | { kind: "text"; text: string; ts: number }
  | { kind: "thinking"; text: string; ts: number }
  | { kind: "error"; text: string; ts: number };

export type AgentStatus =
  | "queued" | "running" | "completed" | "aborted" | "stopped" | "error";

export interface AgentDetails {
  /** Stable id — drives popout URL `/session/<sid>/subagent/<agentId>` */
  agentId: string;
  displayName: string;
  description: string;
  subagentType: string;
  status: AgentStatus;
  /** Live current-activity line — e.g. "reading src/foo.ts" */
  activity?: string;
  /** Full per-step timeline. Tier-1 in the dashboard. */
  entries?: SubagentTimelineEntry[];
  /** Cumulative count of completed tool calls. */
  toolUses: number;
  /** Display-only formatted token total ("12.3k"). */
  tokens: string;
  /** Raw token breakdown — populated on completion. */
  tokensUsage?: TokenUsage;
  turnCount?: number;
  maxTurns?: number;
  durationMs: number;
  /** Resolved model id used by this subagent. */
  modelName?: string;
  /** Notable config flags surfaced on the card. */
  tags?: string[];
  /**
   * Absolute filesystem path to the agent's definition file
   * (e.g. ~/.pi/agent/agents/Explore.md). The dashboard uses this to
   * show a "View source" link on the card. Undefined when the agent
   * is anonymous / inline-defined.
   */
  agentMdPath?: string;
  error?: string;
}

export interface TokenUsage {
  input: number;
  output: number;
  total: number;
}

// ─── Mapping AgentSessionEvent → SubagentTimelineEntry ───────────────────

/**
 * Convert a single pi-coding-agent session event into a timeline entry the
 * dashboard knows how to render. Returns null when the event is uninteresting
 * (start/delta events, message lifecycle markers, etc.).
 *
 * Strategy: only emit on "end"-style events so each entry is final and
 * idempotent. Live activity is conveyed separately via `details.activity`.
 */
export function mapSessionEventToEntry(event: AgentSessionEvent): SubagentTimelineEntry | null {
  const now = Date.now();

  if (event.type === "tool_execution_end") {
    return {
      kind: "tool",
      toolName: event.toolName,
      input: undefined,
      output: event.result,
      isError: event.isError,
      ts: now,
    };
  }

  if (event.type === "message_update") {
    const e = event.assistantMessageEvent;
    if (e.type === "text_end") {
      return { kind: "text", text: e.content, ts: now };
    }
    if (e.type === "thinking_end") {
      return { kind: "thinking", text: e.content, ts: now };
    }
    if (e.type === "error") {
      const errMsg = typeof e.error === "object" && e.error !== null && "content" in e.error
        ? String((e.error as { content: unknown }).content)
        : String(e.error);
      return { kind: "error", text: errMsg, ts: now };
    }
  }

  return null;
}

/**
 * tool_execution_end events arrive without args (only the final result).
 * Pair them with the matching tool_execution_start to fill in `input`.
 * Call from a subscription closure that tracks pending starts.
 */
export function createToolCallTracker() {
  const pending = new Map<string, { toolName: string; args: unknown }>();
  return {
    onEvent(event: AgentSessionEvent): { input: unknown } | null {
      if (event.type === "tool_execution_start") {
        pending.set(event.toolCallId, { toolName: event.toolName, args: event.args });
        return null;
      }
      if (event.type === "tool_execution_end") {
        const start = pending.get(event.toolCallId);
        pending.delete(event.toolCallId);
        return start ? { input: start.args } : { input: undefined };
      }
      return null;
    },
    reset() { pending.clear(); },
  };
}

// ─── Emission helpers ────────────────────────────────────────────────────

/**
 * Fire pi.events.emit() with the channel name the dashboard bridge knows.
 * pi.events may not exist if the extension loads before the bus is ready,
 * so we always check.
 */
function emit(pi: ExtensionAPI, channel: string, data: Record<string, unknown>): void {
  pi.events?.emit(channel, data);
}

export function emitSubagentCreated(
  pi: ExtensionAPI,
  args: {
    agentId: string;
    type: string;
    description: string;
    details: AgentDetails;
  },
): void {
  emit(pi, "subagents:created", {
    id: args.agentId,
    type: args.type,
    description: args.description,
    details: args.details,
  });
}

export function emitSubagentStarted(
  pi: ExtensionAPI,
  args: {
    agentId: string;
    type: string;
    description: string;
    details: AgentDetails;
  },
): void {
  emit(pi, "subagents:started", {
    id: args.agentId,
    type: args.type,
    description: args.description,
    details: args.details,
  });
}

/**
 * Cumulative progress update — fire on every entry append, activity change,
 * token tick, or status transition while the subagent is running. Reuses
 * "subagents:started" since the dashboard reducer merges incoming `details`
 * with the existing SubagentState (entries[] are replaced wholesale each tick).
 */
export function emitSubagentProgress(
  pi: ExtensionAPI,
  args: {
    agentId: string;
    details: AgentDetails;
  },
): void {
  emit(pi, "subagents:started", {
    id: args.agentId,
    details: args.details,
  });
}

export function emitSubagentCompleted(
  pi: ExtensionAPI,
  args: {
    agentId: string;
    result: string;
    durationMs: number;
    tokens: TokenUsage;
    toolUses: number;
    details: AgentDetails;
  },
): void {
  emit(pi, "subagents:completed", {
    id: args.agentId,
    result: args.result,
    durationMs: args.durationMs,
    tokens: args.tokens,
    toolUses: args.toolUses,
    details: args.details,
  });
}

export function emitSubagentFailed(
  pi: ExtensionAPI,
  args: {
    agentId: string;
    error: string;
    durationMs: number;
    toolUses?: number;
    details: AgentDetails;
  },
): void {
  emit(pi, "subagents:failed", {
    id: args.agentId,
    error: args.error,
    durationMs: args.durationMs,
    toolUses: args.toolUses,
    details: args.details,
  });
}

// ─── Context inheritance (default ON) ──────────────────────────────

/**
 * Spawn options affecting parent-session inheritance.
 *
 * DEFAULT: `isolated: false` — the subagent INHERITS a compressed copy of
 * the parent's recent conversation. Pass `isolated: true` to opt OUT and
 * give the subagent a fresh, empty conversation (only its own prompt).
 *
 * Rationale: most foreground subagents are spawned mid-task and benefit
 * from seeing what the parent has been doing. Isolation is the unusual
 * case (e.g. one-off research unrelated to the parent's current task).
 */
export interface InheritanceOptions {
  /** Set true to spawn WITHOUT parent context. Default: false (inherit on). */
  isolated?: boolean;
  /**
   * Number of recent (user, assistant) turn pairs to keep verbatim.
   * Older turns are masked. Default: 6.
   */
  recentTurns?: number;
  /**
   * Past this many turns from the end, tool outputs are replaced with
   * `[…tool output omitted, see earlier message]`. Keeps recent tool
   * results visible while shrinking older noise. Default: 2.
   */
  toolOutputWindow?: number;
  /**
   * Hard cap on the compressed context's character count. If exceeded,
   * older content is truncated. Default: 24_000 (~6k tokens).
   */
  maxChars?: number;
}

/**
 * Compress a parent's message history into a concise prefix the subagent
 * can read as its first turn of context. Pure, no I/O.
 *
 * Strategy (verbatim-compaction, no LLM, zero hallucination risk):
 *   1. Drop everything older than (recentTurns * 2 + system) messages.
 *   2. For messages older than `toolOutputWindow` turns from the end,
 *      replace tool outputs and large content blocks with brief markers.
 *   3. Strip file-read bodies > 2 KB past the tool-output window.
 *   4. Hard-truncate the result from the MIDDLE if it exceeds maxChars,
 *      preserving the very first turn (often a high-signal user message)
 *      and the most recent turns.
 *
 * Returns a markdown-formatted string suitable for prepending to the
 * subagent's prompt as a `<parent-context>` block.
 */
export function compressParentContext(
  messages: ReadonlyArray<{ role: string; content: unknown }>,
  opts: Required<Omit<InheritanceOptions, "isolated">>,
): string {
  const turnPairs: Array<{ user?: typeof messages[number]; assistant?: typeof messages[number] }> = [];
  let current: { user?: typeof messages[number]; assistant?: typeof messages[number] } = {};
  for (const m of messages) {
    if (m.role === "user") {
      if (current.user || current.assistant) turnPairs.push(current);
      current = { user: m };
    } else if (m.role === "assistant") {
      current.assistant = m;
    }
  }
  if (current.user || current.assistant) turnPairs.push(current);

  const recent = turnPairs.slice(-opts.recentTurns);
  const toolWindowStart = Math.max(0, recent.length - opts.toolOutputWindow);

  const lines: string[] = ["<parent-context>"];
  recent.forEach((pair, i) => {
    const keepFullOutputs = i >= toolWindowStart;
    if (pair.user) {
      lines.push("", "### user", renderContent(pair.user.content, { keepFullOutputs }));
    }
    if (pair.assistant) {
      lines.push("", "### assistant", renderContent(pair.assistant.content, { keepFullOutputs }));
    }
  });
  lines.push("", "</parent-context>");

  let out = lines.join("\n");
  if (out.length > opts.maxChars) {
    // Truncate from middle, keep head + tail. Preserves the first user turn
    // (high signal) and most recent activity.
    const headLen = Math.floor(opts.maxChars * 0.4);
    const tailLen = opts.maxChars - headLen - 32; // 32 for the ellipsis marker
    out = out.slice(0, headLen) +
          "\n\n[…middle omitted for length…]\n\n" +
          out.slice(out.length - tailLen);
  }
  return out;
}

/** Render a message content block, masking large/tool content past the window. */
function renderContent(content: unknown, opts: { keepFullOutputs: boolean }): string {
  if (typeof content === "string") {
    return opts.keepFullOutputs || content.length <= 2_000
      ? content
      : content.slice(0, 1_500) + "\n[…truncated…]";
  }
  if (!Array.isArray(content)) return String(content);
  const parts: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    const b = block as { type?: string; text?: string; content?: unknown };
    if (b.type === "text" && typeof b.text === "string") {
      parts.push(opts.keepFullOutputs || b.text.length <= 2_000
        ? b.text
        : b.text.slice(0, 1_500) + "\n[…truncated…]");
    } else if (b.type === "tool_use") {
      parts.push(`[tool_use: ${(b as { name?: string }).name ?? "?"}]`);
    } else if (b.type === "tool_result") {
      parts.push(opts.keepFullOutputs
        ? `[tool_result] ${renderContent(b.content, opts)}`
        : "[…tool output omitted, see earlier message]");
    } else if (b.type === "thinking") {
      parts.push(opts.keepFullOutputs ? `[thinking] ${b.text ?? ""}` : "[…thinking omitted…]");
    }
  }
  return parts.join("\n");
}

/** Default inheritance settings — inherit ON, moderate compression. */
export const DEFAULT_INHERITANCE: Required<Omit<InheritanceOptions, "isolated">> = {
  recentTurns: 6,
  toolOutputWindow: 2,
  maxChars: 24_000,
};

/**
 * Build the parent-context block to prepend to the subagent's prompt.
 *
 * Reads parent conversation via `ctx.sessionManager.getBranch()`, which walks the
 * current branch leaf→root and returns all `SessionEntry` values (messages,
 * compactions, model changes, etc.). We:
 *   1. filter to `entry.type === "message"`
 *   2. extract `entry.message` (an `AgentMessage`)
 *   3. filter to user/assistant roles (tool results / custom messages are handled
 *      inside `compressParentContext` via the content block walker)
 *   4. reverse leaf→root → root→leaf so the compression sees chronological order.
 *
 * `buildSessionContext()` on the full `SessionManager` would be ideal but is NOT
 * part of `ReadonlySessionManager`'s `Pick` set, so we do the equivalent work
 * manually against the public `SessionEntry` union.
 *
 * Honors `isolated` for opt-out. Returns empty string when isolated, when there
 * is no session manager, or when the parent branch has no user/assistant
 * messages.
 */
export function buildInheritedContext(
  ctx: ExtensionContext,
  opts: InheritanceOptions = {},
): string {
  if (opts.isolated === true) return "";

  // Defensive optional chaining on `getBranch` so future SDK refactors fail soft.
  // The method name is the real one from `ReadonlySessionManager`.
  const sm = ctx.sessionManager as { getBranch?: (fromId?: string) => SessionEntry[] } | undefined;
  const branchEntries = sm?.getBranch?.() ?? [];
  if (branchEntries.length === 0) return "";

  // getBranch walks leaf→root; reverse for chronological order.
  const chronological = [...branchEntries].reverse();
  const messages: Array<{ role: string; content: unknown }> = [];
  for (const entry of chronological) {
    if (entry.type !== "message") continue;
    const msg = entry.message as { role: string; content: unknown };
    if (msg.role !== "user" && msg.role !== "assistant") continue;
    messages.push(msg);
  }
  if (messages.length === 0) return "";

  const settings: Required<Omit<InheritanceOptions, "isolated">> = {
    recentTurns: opts.recentTurns ?? DEFAULT_INHERITANCE.recentTurns,
    toolOutputWindow: opts.toolOutputWindow ?? DEFAULT_INHERITANCE.toolOutputWindow,
    maxChars: opts.maxChars ?? DEFAULT_INHERITANCE.maxChars,
  };
  return compressParentContext(messages, settings);
}

// ─── Details builders ────────────────────────────────────────────────────

/**
 * Format a token count compactly: 12000 → "12.0k", 1500000 → "1.5M".
 * The dashboard renderer treats `details.tokens` as opaque display text.
 */
export function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

/**
 * Build an AgentDetails snapshot from running state. Use this on every
 * progress emit so the dashboard always has the latest snapshot.
 */
export function buildDetails(snapshot: {
  agentId: string;
  displayName: string;
  description: string;
  subagentType: string;
  status: AgentStatus;
  activity?: string;
  entries: SubagentTimelineEntry[];
  toolUses: number;
  tokensTotal: number;
  tokensUsage?: TokenUsage;
  turnCount?: number;
  maxTurns?: number;
  startedAt: number;
  modelName?: string;
  tags?: string[];
  agentMdPath?: string;
  error?: string;
}): AgentDetails {
  return {
    agentId: snapshot.agentId,
    displayName: snapshot.displayName,
    description: snapshot.description,
    subagentType: snapshot.subagentType,
    status: snapshot.status,
    activity: snapshot.activity,
    entries: snapshot.entries,
    toolUses: snapshot.toolUses,
    tokens: formatTokens(snapshot.tokensTotal),
    tokensUsage: snapshot.tokensUsage,
    turnCount: snapshot.turnCount,
    maxTurns: snapshot.maxTurns,
    durationMs: Date.now() - snapshot.startedAt,
    modelName: snapshot.modelName,
    tags: snapshot.tags,
    agentMdPath: snapshot.agentMdPath,
    error: snapshot.error,
  };
}
