/**
 * Handlers over the per-activation background registry for the `messages`,
 * `list` and `cancel` actions of `AgentControl` (formerly separate tools; see
 * change: add-subagent-orchestration, D0), plus the shared `progressLine`
 * (see change: agent-control-unified-wait). The
 * `makeAgent*Tool` factories build the handlers; they are no longer
 * registered on their own.
 *
 * Registered only when `allowBackground` is on at activation. Every response
 * is bounded by the configured result limits, and reading a finished result
 * emits `subagents:result_read`. See change: add-background-subagents
 * (design D5, D6, D7).
 */
import { Type } from "@sinclair/typebox";

import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { formatRetryDelay, type SubagentTimelineEntry } from "./events.js";
import { getResultLimits } from "./settings.js";
import {
  type BackgroundCounts,
  type BackgroundRecord,
  type BackgroundRegistry,
  type BackgroundStatus,
  isTerminalStatus,
  type StoredResult,
} from "./background.js";

// ─── Shared views (also served on the query channels) ────────────────────

/** One subagent as `AgentStatus` / `subagents:get` report it. */
export interface BackgroundAgentStatus {
  id: string;
  agentId?: string;
  status: BackgroundStatus | "not_found" | "ambiguous";
  subagent_type?: string;
  description?: string;
  /** Resolved working directory. See change: add-subagent-orchestration. */
  cwd?: string;
  /** Current run number (1-based; `AgentSteer` starts the next). */
  run?: number;
  /** Assistant turns so far, across runs. */
  turns?: number;
  /** Short ask form while blocked in `ask_parent`. */
  asking?: string;
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
  status: BackgroundStatus;
  cwd?: string;
  run: number;
  /** Short ask form while blocked in `ask_parent`. */
  asking?: string;
  ageMs: number;
  tokens: string;
  /** Finished, and its result was never returned to a reader. */
  unread: boolean;
}

export interface BackgroundMessagesPage {
  id: string;
  agentId: string;
  status: BackgroundStatus;
  total: number;
  from: number;
  next_from: number;
  entries: SubagentTimelineEntry[];
}

export function countsLine(c: BackgroundCounts): string {
  return `${c.running} running, ${c.queued} queued, ${c.idle} idle, ${c.finishedUnread} finished-unread`;
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
    ...(record.cwd !== undefined ? { cwd: record.cwd } : {}),
    run: record.run,
    ...(latest?.turnCount !== undefined ? { turns: latest.turnCount } : {}),
    ...(record.asking ? { asking: askLineOf(record) } : {}),
    ...(latest?.activity && record.status === "running" ? { activity: latest.activity } : {}),
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
    ...(record.cwd !== undefined ? { cwd: record.cwd } : {}),
    run: record.run,
    ...(record.asking ? { asking: askLineOf(record, now) } : {}),
    ageMs: now - record.createdAt,
    tokens: record.latest?.tokens ?? "0",
    unread: record.result !== undefined && record.readAt === undefined,
  };
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

/** Question length in the short ask line. */
const ASK_LINE_QUESTION_CHARS = 120;

/**
 * Short one-line ask form for status/list (design D14), or undefined when the
 * subagent is not blocked in `ask_parent`.
 */
export function askLineOf(record: BackgroundRecord, now = Date.now()): string | undefined {
  const a = record.asking;
  if (!a) return undefined;
  const q = a.question.length <= ASK_LINE_QUESTION_CHARS ? a.question : `${a.question.slice(0, ASK_LINE_QUESTION_CHARS - 1)}…`;
  const age = Math.round((now - a.askedAt) / 1000);
  return `⏸asking ${a.questionId} "${q}" (${age}s) → AgentControl(reply ${record.id} ${a.questionId})`;
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

/** Last assistant text shown in a progress line, chars. */
const LAST_TEXT_CHARS = 200;

/** Tail of the latest `text` timeline entry, whitespace-collapsed, or undefined. */
function lastTextTail(record: BackgroundRecord): string | undefined {
  for (let i = record.entries.length - 1; i >= 0; i--) {
    const e = record.entries[i]!;
    if (e.kind !== "text") continue;
    const t = e.text.replace(/\s+/g, " ").trim();
    if (!t) return undefined;
    return t.length <= LAST_TEXT_CHARS ? t : `…${t.slice(t.length - (LAST_TEXT_CHARS - 1))}`;
  }
  return undefined;
}

/**
 * One-line progress view of a subagent: id, status, type, run, turn, cwd,
 * short ask form, activity, tokens and (while running) the tail of its latest
 * assistant text. Shared by `wait` (updates and blocks), `steer`, `reply`,
 * `cancel`. See change: agent-control-unified-wait (D5).
 */
export function progressLine(record: BackgroundRecord, now = Date.now()): string {
  const s = statusOf(record);
  const ask = askLineOf(record, now);
  const tail = record.status === "running" ? lastTextTail(record) : undefined;
  return [
    `${s.id}: ${s.status}`,
    s.subagent_type ? `(${s.subagent_type}${s.description ? ` — ${s.description}` : ""})` : "",
    s.queuePosition !== undefined ? `queued #${s.queuePosition}` : "",
    s.run !== undefined ? `run ${s.run}` : "",
    s.turns !== undefined ? `turn ${s.turns}` : "",
    s.cwd ? `cwd ${s.cwd}` : "",
    ask ?? "",
    s.activity ? `▸ ${s.activity}` : "",
    s.stoppedBy ? `stopped by ${s.stoppedBy}` : "",
    s.tokens ? `${s.tokens} tokens` : "",
    tail ? `“${tail}”` : "",
  ]
    .filter(Boolean)
    .join(" ");
}

/** Text for an id that resolves to no record. */
export function missLine(id: string, miss: "not_found" | "ambiguous" | "not_alive"): string {
  if (miss === "ambiguous") return `${id}: ambiguous (matches several subagents; use a longer id)`;
  if (miss === "not_alive") return `${id}: not_alive (no live session: freed, or the session was reloaded)`;
  return `${id}: not_found (no such background subagent in this session; results do not survive /reload)`;
}

// ─── result_read ──────────────────────────────────────────────────────────

export function emitResultRead(pi: ExtensionAPI, record: BackgroundRecord, via: "wait" | "push" | "messages"): void {
  try {
    pi.events?.emit("subagents:result_read", { id: record.id, agentId: record.agentId, via });
  } catch {
    /* a broken bus never fails a read */
  }
}

// ─── Tools ────────────────────────────────────────────────────────────────

type ToolResult<D> = { content: Array<{ type: "text"; text: string }>; details: D; isError?: boolean };

/**
 * @deprecated The `status` action was folded into `wait`; kept so plugin type
 * imports keep compiling. See change: agent-control-unified-wait.
 */
export interface AgentStatusDetails {
  agents: BackgroundAgentStatus[];
  counts: BackgroundCounts;
  timedOut?: boolean;
  interrupted?: boolean;
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
          content: [{ type: "text", text: missLine(id, hit) }],
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
          `${a.id}  ${a.status}${a.unread ? " (unread)" : ""}  run ${a.run}  ${a.subagent_type} — ${a.description}  ${Math.round(a.ageMs / 1000)}s  ${a.tokens} tokens${a.cwd ? `  cwd ${a.cwd}` : ""}${a.asking ? `  ${a.asking}` : ""}`,
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

export type CancelOutcome = "stopped" | "disposed" | "already_finished" | "not_found" | "ambiguous";

export interface AgentCancelDetails {
  results: Array<{ id: string; outcome: CancelOutcome }>;
  counts: BackgroundCounts;
}

/**
 * Stop function shared with the `subagents:stop` listener: resolves to the
 * activation's `AgentControlRegistry.stop(agentId, by)`.
 */
export type StopAgent = (agentId: string, by: "tool" | "event" | "timeout" | "shutdown") => boolean;

/** Free an idle subagent's session; false when it is not idle. See change: add-subagent-orchestration. */
export type DisposeIdle = (record: BackgroundRecord) => boolean;

export function makeAgentCancelTool(registry: BackgroundRegistry, stopAgent: StopAgent, disposeIdle?: DisposeIdle) {
  return defineTool({
    name: "AgentCancel",
    label: "AgentCancel",
    description:
      'Stop background subagents by id, or all of them with ids: "all" (optionally only those with status "queued", "running" or "idle"). ' +
      "A queued one is removed before it starts; a running one is aborted, also while it waits in ask_parent. Stopped subagents end as `stopped` (not an error) and their partial timeline stays readable. " +
      "An idle one is freed (`disposed`); its last result stays readable. Does not wait for the stop to finish.",
    parameters: Type.Object({
      ids: Type.Union([Type.Array(Type.String(), { minItems: 1 }), Type.Literal("all")], {
        description: 'Background subagent ids, or "all".',
      }),
      status: Type.Optional(
        Type.Union([Type.Literal("queued"), Type.Literal("running"), Type.Literal("idle")], {
          description: "Only stop subagents currently in this state.",
        }),
      ),
    }),

    async execute(_toolCallId: string, rawParams: Record<string, unknown>): Promise<ToolResult<AgentCancelDetails>> {
      const params = rawParams as { ids?: unknown; status?: unknown };
      const only =
        params.status === "queued" || params.status === "running" || params.status === "idle" ? params.status : undefined;
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
        if (record.status === "idle" && matches(record)) {
          return { id, outcome: disposeIdle?.(record) ? ("disposed" as const) : ("already_finished" as const) };
        }
        if (isTerminalStatus(record.status) || !matches(record)) {
          return { id, outcome: isTerminalStatus(record.status) ? ("already_finished" as const) : ("not_found" as const) };
        }
        return { id, outcome: stopAgent(record.agentId, "tool") ? ("stopped" as const) : ("already_finished" as const) };
      });
      const counts = registry.counts();
      const progress = targets.flatMap(({ record }) => (record ? [progressLine(record)] : []));
      const text = results.length
        ? [results.map((r) => `${r.id}: ${r.outcome}`).join("\n"), progress.join("\n"), `Background: ${countsLine(counts)}.`]
            .filter(Boolean)
            .join("\n\n")
        : `Nothing to cancel. Background: ${countsLine(counts)}.`;
      return { content: [{ type: "text", text }], details: { results, counts } };
    },
  });
}
