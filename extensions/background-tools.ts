/**
 * LLM tools over the per-activation background registry:
 * `AgentStatus`, `AgentMessages`, `AgentList` and `AgentCancel`.
 *
 * Registered only when `allowBackground` is on at activation. Every response
 * is bounded by the configured result limits, and reading a finished result
 * emits `subagents:result_read`. See change: add-background-subagents
 * (design D5, D6, D7).
 */
import { Type } from "@sinclair/typebox";

import { type AgentToolUpdateCallback, defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { type AgentStatus, formatRetryDelay, type SubagentTimelineEntry } from "./events.js";
import { getResultLimits } from "./settings.js";
import {
  type BackgroundCounts,
  type BackgroundRecord,
  type BackgroundRegistry,
  isTerminalStatus,
  type StoredResult,
} from "./background.js";

// ─── Shared views (also served on the query channels) ────────────────────

/** One subagent as `AgentStatus` / `subagents:get` report it. */
export interface BackgroundAgentStatus {
  id: string;
  agentId?: string;
  status: AgentStatus | "not_found" | "ambiguous";
  subagent_type?: string;
  description?: string;
  activity?: string;
  queuePosition?: number;
  tokens?: string;
  durationMs?: number;
  /** Final result text; present once terminal. */
  result?: string;
  error?: string;
  stopReason?: StoredResult["stopReason"];
  stoppedBy?: StoredResult["stoppedBy"];
}

/** One row of `AgentList` / `subagents:list`. */
export interface BackgroundAgentSummary {
  id: string;
  agentId: string;
  subagent_type: string;
  description: string;
  status: AgentStatus;
  ageMs: number;
  tokens: string;
  /** Finished, and its result was never returned to a reader. */
  unread: boolean;
}

export interface BackgroundMessagesPage {
  id: string;
  agentId: string;
  status: AgentStatus;
  total: number;
  from: number;
  next_from: number;
  entries: SubagentTimelineEntry[];
}

export function countsLine(c: BackgroundCounts): string {
  return `${c.running} running, ${c.queued} queued, ${c.finishedUnread} finished-unread`;
}

export function statusOf(record: BackgroundRecord): BackgroundAgentStatus {
  const latest = record.latest;
  const r = record.result;
  return {
    id: record.id,
    agentId: record.agentId,
    status: record.status,
    subagent_type: record.subagentType,
    description: record.description,
    ...(latest?.activity && !r ? { activity: latest.activity } : {}),
    ...(record.status === "queued" && latest?.queuePosition !== undefined
      ? { queuePosition: latest.queuePosition }
      : {}),
    ...(latest?.tokens ? { tokens: latest.tokens } : {}),
    ...(r ? { durationMs: r.durationMs, result: r.result } : {}),
    ...(r?.error !== undefined ? { error: r.error } : {}),
    ...(r?.stopReason ? { stopReason: r.stopReason } : {}),
    ...(r?.stoppedBy ? { stoppedBy: r.stoppedBy } : {}),
  };
}

export function summaryOf(record: BackgroundRecord, now = Date.now()): BackgroundAgentSummary {
  return {
    id: record.id,
    agentId: record.agentId,
    subagent_type: record.subagentType,
    description: record.description,
    status: record.status,
    ageMs: now - record.createdAt,
    tokens: record.latest?.tokens ?? "0",
    unread: record.result !== undefined && record.readAt === undefined,
  };
}

/** Resolve one id into a record or a `not_found` / `ambiguous` status row. */
export function resolveStatus(
  registry: BackgroundRegistry,
  id: string,
): { record: BackgroundRecord } | { miss: BackgroundAgentStatus } {
  const hit = registry.lookup(id);
  if (typeof hit === "string") return { miss: { id: String(id), status: hit } };
  return { record: hit };
}

/** Paged, kind-filtered view of a record's timeline (design D6). */
export function messagesPage(
  record: BackgroundRecord,
  opts: { from?: number; limit?: number; kinds?: readonly string[] },
): BackgroundMessagesPage {
  const kinds = opts.kinds && opts.kinds.length > 0 ? new Set(opts.kinds) : undefined;
  const all = kinds ? record.entries.filter((e) => kinds.has(e.kind)) : record.entries;
  const total = all.length;
  const limit = clampInt(opts.limit, 1, 200, 20);
  const from =
    opts.from === undefined ? Math.max(0, total - limit) : clampInt(opts.from, 0, total, 0);
  const entries = all.slice(from, from + limit);
  return {
    id: record.id,
    agentId: record.agentId,
    status: record.status,
    total,
    from,
    next_from: from + entries.length,
    entries,
  };
}

function clampInt(v: unknown, min: number, max: number, fallback: number): number {
  if (typeof v !== "number" || !Number.isFinite(v)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(v)));
}

// ─── Bounding ─────────────────────────────────────────────────────────────

/** Cut `text` to `max` chars (0 = unlimited), keeping head and tail. */
function boundText(text: string, max: number): string {
  if (max <= 0 || text.length <= max) return text;
  const marker = `\n[… ${text.length - max} chars truncated …]\n`;
  const head = Math.ceil(max / 2);
  return `${text.slice(0, head)}${marker}${text.slice(text.length - (max - head))}`;
}

function entryLine(e: SubagentTimelineEntry, index: number): string {
  switch (e.kind) {
    case "tool": {
      const out = typeof e.output === "string" ? e.output : JSON.stringify(e.output ?? null);
      return `[${index}] tool ${e.toolName}${e.isError ? " (error)" : ""}: ${JSON.stringify(e.input ?? null)} → ${out}`;
    }
    case "retry":
      return `[${index}] retry ${e.attempt}/${e.maxAttempts} after ${formatRetryDelay(e.delayMs)}: ${e.text}`;
    default:
      return `[${index}] ${e.kind}: ${e.text}`;
  }
}

function statusBlock(s: BackgroundAgentStatus): string {
  const head = [
    `${s.id}: ${s.status}`,
    s.subagent_type ? `(${s.subagent_type}${s.description ? ` — ${s.description}` : ""})` : "",
    s.queuePosition !== undefined ? `queued #${s.queuePosition}` : "",
    s.activity ? `▸ ${s.activity}` : "",
    s.stoppedBy ? `stopped by ${s.stoppedBy}` : "",
    s.tokens ? `${s.tokens} tokens` : "",
  ]
    .filter(Boolean)
    .join(" ");
  if (s.status === "not_found") return `${s.id}: not_found (no such background subagent in this session; results do not survive /reload)`;
  if (s.status === "ambiguous") return `${s.id}: ambiguous (matches several subagents; use a longer id)`;
  if (s.result === undefined) return head;
  return `${head}\n${s.error && !s.result ? `error: ${s.error}` : s.result}`;
}

// ─── Waiting ──────────────────────────────────────────────────────────────

/**
 * Resolve when `done()` is true, the timeout elapses or `signal` aborts.
 * Re-checks on every registry change. Never cancels any subagent.
 */
function waitFor(
  registry: BackgroundRegistry,
  done: () => boolean,
  timeoutMs: number | undefined,
  signal: AbortSignal | undefined,
  onChange?: () => void,
): Promise<{ timedOut: boolean; interrupted: boolean }> {
  return new Promise((resolve) => {
    if (done()) return resolve({ timedOut: false, interrupted: false });
    if (signal?.aborted) return resolve({ timedOut: false, interrupted: true });
    let timer: ReturnType<typeof setTimeout> | undefined;
    let settled = false;
    const finish = (r: { timedOut: boolean; interrupted: boolean }) => {
      if (settled) return;
      settled = true;
      unsubscribe();
      if (timer) clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      resolve(r);
    };
    const onAbort = () => finish({ timedOut: false, interrupted: true });
    const unsubscribe = registry.subscribe(() => {
      if (done()) finish({ timedOut: false, interrupted: false });
      else onChange?.();
    });
    signal?.addEventListener("abort", onAbort, { once: true });
    if (timeoutMs !== undefined && timeoutMs > 0) {
      timer = setTimeout(() => finish({ timedOut: true, interrupted: false }), timeoutMs);
    }
  });
}

// ─── result_read ──────────────────────────────────────────────────────────

export function emitResultRead(pi: ExtensionAPI, record: BackgroundRecord, via: "status" | "messages"): void {
  try {
    pi.events?.emit("subagents:result_read", { id: record.id, agentId: record.agentId, via });
  } catch {
    /* a broken bus never fails a read */
  }
}

// ─── Tools ────────────────────────────────────────────────────────────────

type ToolResult<D> = { content: Array<{ type: "text"; text: string }>; details: D; isError?: boolean };

export interface AgentStatusDetails {
  agents: BackgroundAgentStatus[];
  counts: BackgroundCounts;
  timedOut?: boolean;
  interrupted?: boolean;
}

/** Build the `AgentStatus` report for `ids`, marking terminal results read. */
export function readStatuses(
  pi: ExtensionAPI,
  registry: BackgroundRegistry,
  ids: readonly string[],
  markRead: boolean,
): BackgroundAgentStatus[] {
  return ids.map((id) => {
    const r = resolveStatus(registry, id);
    if ("miss" in r) return r.miss;
    if (markRead && r.record.result) {
      registry.markRead(r.record);
      emitResultRead(pi, r.record, "status");
    }
    return statusOf(r.record);
  });
}

export function makeAgentStatusTool(pi: ExtensionAPI, registry: BackgroundRegistry) {
  return defineTool({
    name: "AgentStatus",
    label: "AgentStatus",
    description:
      "Report the status (and stored result, once finished) of background subagents by id (`bg-…`, full agentId, or unique prefix). " +
      'wait: "none" (default) returns at once; "any" returns when at least one is finished; "all" when all are. ' +
      "timeout_s caps the wait and never cancels anything.",
    parameters: Type.Object({
      ids: Type.Array(Type.String(), { minItems: 1, description: "Background subagent ids." }),
      wait: Type.Optional(
        Type.Union([Type.Literal("none"), Type.Literal("any"), Type.Literal("all")], {
          description: 'How long to block: "none" (default), "any" or "all".',
        }),
      ),
      timeout_s: Type.Optional(Type.Number({ description: "Maximum seconds to wait; the subagents keep running." })),
    }),

    async execute(
      _toolCallId: string,
      rawParams: Record<string, unknown>,
      signal: AbortSignal | undefined,
      onUpdate: AgentToolUpdateCallback<AgentStatusDetails> | undefined,
    ): Promise<ToolResult<AgentStatusDetails>> {
      const params = rawParams as { ids?: unknown; wait?: unknown; timeout_s?: unknown };
      const ids = (Array.isArray(params.ids) ? params.ids : [params.ids]).filter(
        (x): x is string => typeof x === "string" && x.trim() !== "",
      );
      const wait = params.wait === "any" || params.wait === "all" ? params.wait : "none";
      const timeoutS = typeof params.timeout_s === "number" && params.timeout_s > 0 ? params.timeout_s : undefined;

      const records = ids
        .map((id) => registry.lookup(id))
        .filter((r): r is BackgroundRecord => typeof r !== "string");
      const terminal = (r: BackgroundRecord) => isTerminalStatus(r.status) && r.result !== undefined;
      let timedOut = false;
      let interrupted = false;
      if (wait !== "none" && records.length > 0) {
        const done = () => (wait === "all" ? records.every(terminal) : records.some(terminal));
        const snapshot = (): AgentStatusDetails => ({
          agents: readStatuses(pi, registry, ids, false),
          counts: registry.counts(),
        });
        const res = await waitFor(registry, done, timeoutS !== undefined ? timeoutS * 1000 : undefined, signal, () => {
          if (onUpdate) {
            const d = snapshot();
            onUpdate({ content: [{ type: "text", text: d.agents.map(statusBlock).join("\n") }], details: d });
          }
        });
        timedOut = res.timedOut;
        interrupted = res.interrupted;
      }

      const agents = readStatuses(pi, registry, ids, true);
      const counts = registry.counts();
      const notes = [
        timedOut ? `(wait timed out after ${timeoutS}s; nothing was cancelled)` : "",
        interrupted ? "(wait interrupted; the subagents keep running)" : "",
        `Background: ${countsLine(counts)}.`,
      ].filter(Boolean);
      const text = boundText([...agents.map(statusBlock), ...notes].join("\n\n"), getResultLimits().resultMaxChars);
      return {
        content: [{ type: "text", text }],
        details: { agents, counts, ...(timedOut ? { timedOut } : {}), ...(interrupted ? { interrupted } : {}) },
      };
    },
  });
}

export function makeAgentMessagesTool(pi: ExtensionAPI, registry: BackgroundRegistry) {
  return defineTool({
    name: "AgentMessages",
    label: "AgentMessages",
    description:
      "Read a background subagent's timeline (tool calls, reasoning, text), live or finished. " +
      "Without `from` returns the last `limit` (default 20) entries; pass the returned `next_from` as `from` to read only new ones. " +
      "`kinds` filters (tool, text, thinking, error, retry) before paging.",
    parameters: Type.Object({
      id: Type.String({ description: "Background subagent id." }),
      from: Type.Optional(Type.Number({ description: "0-based entry index to start from." })),
      limit: Type.Optional(Type.Number({ description: "Max entries to return (default 20)." })),
      kinds: Type.Optional(Type.Array(Type.String(), { description: "Entry kinds to include." })),
    }),

    async execute(
      _toolCallId: string,
      rawParams: Record<string, unknown>,
    ): Promise<ToolResult<BackgroundMessagesPage | { id: string; status: string }>> {
      const params = rawParams as { id?: unknown; from?: unknown; limit?: unknown; kinds?: unknown };
      const id = typeof params.id === "string" ? params.id : "";
      const hit = registry.lookup(id);
      if (typeof hit === "string") {
        return {
          content: [{ type: "text", text: statusBlock({ id, status: hit }) }],
          details: { id, status: hit },
          isError: true,
        };
      }
      const page = messagesPage(hit, {
        from: typeof params.from === "number" ? params.from : undefined,
        limit: typeof params.limit === "number" ? params.limit : undefined,
        kinds: Array.isArray(params.kinds) ? params.kinds.filter((k): k is string => typeof k === "string") : undefined,
      });
      if (page.entries.length > 0) emitResultRead(pi, hit, "messages");
      const limits = getResultLimits();
      const header = `${hit.id}: ${hit.status} — entries ${page.from}–${page.next_from - 1} of ${page.total} (next_from: ${page.next_from})`;
      const body = page.entries.map((e, i) => entryLine(e, page.from + i)).join("\n");
      const text = boundText(page.entries.length ? `${header}\n${body}` : `${hit.id}: ${hit.status} — no entries (total: ${page.total})`, limits.resultMaxChars);
      return { content: [{ type: "text", text }], details: page };
    },
  });
}

export function makeAgentListTool(registry: BackgroundRegistry) {
  return defineTool({
    name: "AgentList",
    label: "AgentList",
    description:
      "List every background subagent of this session with id, type, description, status, age, tokens and whether a finished result is unread.",
    parameters: Type.Object({}),

    async execute(): Promise<ToolResult<{ agents: BackgroundAgentSummary[]; counts: BackgroundCounts }>> {
      const now = Date.now();
      const agents = registry.list().map((r) => summaryOf(r, now));
      const counts = registry.counts();
      const lines = agents.map(
        (a) =>
          `${a.id}  ${a.status}${a.unread ? " (unread)" : ""}  ${a.subagent_type} — ${a.description}  ${Math.round(a.ageMs / 1000)}s  ${a.tokens} tokens`,
      );
      const text = agents.length
        ? `${lines.join("\n")}\n\nBackground: ${countsLine(counts)}.`
        : "No background subagents in this session.";
      return {
        content: [{ type: "text", text: boundText(text, getResultLimits().resultMaxChars) }],
        details: { agents, counts },
      };
    },
  });
}

// ─── AgentCancel ──────────────────────────────────────────────────────────

export type CancelOutcome = "stopped" | "already_finished" | "not_found" | "ambiguous";

export interface AgentCancelDetails {
  results: Array<{ id: string; outcome: CancelOutcome }>;
  counts: BackgroundCounts;
}

/**
 * Stop function shared with the `subagents:stop` listener: resolves to the
 * activation's `AgentControlRegistry.stop(agentId, by)`.
 */
export type StopAgent = (agentId: string, by: "tool" | "event" | "timeout" | "shutdown") => boolean;

export function makeAgentCancelTool(registry: BackgroundRegistry, stopAgent: StopAgent) {
  return defineTool({
    name: "AgentCancel",
    label: "AgentCancel",
    description:
      'Stop background subagents by id, or all of them with ids: "all" (optionally only those with status "queued" or "running"). ' +
      "A queued one is removed before it starts; a running one is aborted. Stopped subagents end as `stopped` (not an error) and their partial timeline stays readable. Does not wait for the stop to finish.",
    parameters: Type.Object({
      ids: Type.Union([Type.Array(Type.String(), { minItems: 1 }), Type.Literal("all")], {
        description: 'Background subagent ids, or "all".',
      }),
      status: Type.Optional(
        Type.Union([Type.Literal("queued"), Type.Literal("running")], {
          description: "Only stop subagents currently in this state.",
        }),
      ),
    }),

    async execute(_toolCallId: string, rawParams: Record<string, unknown>): Promise<ToolResult<AgentCancelDetails>> {
      const params = rawParams as { ids?: unknown; status?: unknown };
      const only = params.status === "queued" || params.status === "running" ? params.status : undefined;
      const matches = (r: BackgroundRecord) => !only || r.status === only;
      let targets: Array<{ id: string; record?: BackgroundRecord; miss?: CancelOutcome }>;
      if (params.ids === "all") {
        targets = registry
          .list()
          .filter((r) => !isTerminalStatus(r.status) && matches(r))
          .map((record) => ({ id: record.id, record }));
      } else {
        const ids = (Array.isArray(params.ids) ? params.ids : [params.ids]).filter(
          (x): x is string => typeof x === "string",
        );
        targets = ids.map((id) => {
          const hit = registry.lookup(id);
          return typeof hit === "string" ? { id, miss: hit } : { id: hit.id, record: hit };
        });
      }

      const results = targets.map(({ id, record, miss }) => {
        if (!record) return { id, outcome: miss! };
        if (isTerminalStatus(record.status) || !matches(record)) {
          return { id, outcome: isTerminalStatus(record.status) ? ("already_finished" as const) : ("not_found" as const) };
        }
        return { id, outcome: stopAgent(record.agentId, "tool") ? ("stopped" as const) : ("already_finished" as const) };
      });
      const counts = registry.counts();
      const text = results.length
        ? `${results.map((r) => `${r.id}: ${r.outcome}`).join("\n")}\n\nBackground: ${countsLine(counts)}.`
        : `Nothing to cancel. Background: ${countsLine(counts)}.`;
      return { content: [{ type: "text", text }], details: { results, counts } };
    },
  });
}
