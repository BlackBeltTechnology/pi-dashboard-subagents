/**
 * Per-activation registry of background subagents.
 *
 * A background `Agent` call runs the same `runAgentTool` promise as a
 * foreground one, unawaited. This registry is the only place its state lives
 * between the spawn and later `AgentStatus` / `AgentMessages` / `AgentList` /
 * `AgentCancel` calls (and the `subagents:list` / `subagents:get` query
 * channels). It is created inside `activate()` — never module-level — so one
 * session's tools and bus can only see that session's subagents.
 *
 * Results live in memory for the rest of the activation; nothing is pushed
 * into the parent conversation.
 *
 * See change: add-background-subagents (design D2, D4).
 */
import { randomBytes } from "node:crypto";

import type { AgentDetails, AgentStatus, SubagentTimelineEntry, TokenUsage } from "./events.js";

/** Short-id prefix every background id starts with. */
export const BACKGROUND_ID_PREFIX = "bg-";

/** Statuses after which a record never changes again. */
const TERMINAL: ReadonlySet<AgentStatus> = new Set(["completed", "aborted", "stopped", "error"]);

export function isTerminalStatus(status: BackgroundStatus): boolean {
  return status !== "idle" && TERMINAL.has(status);
}

/**
 * Record status: a run status, or `idle` = the last run finished and the
 * session is kept alive for `AgentSteer`. See change: add-subagent-orchestration.
 */
export type BackgroundStatus = AgentStatus | "idle";

/** Who caused a stop. See change: add-background-subagents (D7). */
export type StoppedBy = "tool" | "event" | "timeout" | "shutdown";

/** What a finished background subagent leaves behind. */
export interface StoredResult {
  status: AgentStatus;
  stopReason?: "queued" | "running";
  stoppedBy?: StoppedBy;
  /** Result text (final reply, stop notice or failure text). */
  result: string;
  error?: string;
  isError: boolean;
  tokens?: TokenUsage;
  durationMs: number;
  finishedAt: number;
}

export interface BackgroundRecord {
  /** Short id (`bg-` + 6 hex chars), unique within the registry. */
  readonly id: string;
  /** Full subagent id used on every `subagents:*` event. */
  readonly agentId: string;
  readonly subagentType: string;
  readonly description: string;
  /** Resolved working directory of the subagent. See change: add-subagent-orchestration. */
  readonly cwd?: string;
  readonly createdAt: number;
  status: BackgroundStatus;
  /** Current run number, 1-based; `AgentSteer` on an idle record starts the next. */
  run: number;
  /** Run whose result is stored in `result`. */
  finishedRun?: number;
  /** Latest snapshot from the run's `onUpdate` (progress frames carry no entries). */
  latest?: AgentDetails;
  /** Live timeline, each entry field-cut on append. */
  readonly entries: SubagentTimelineEntry[];
  /** Set once the run reached a terminal state. */
  result?: StoredResult;
  /** Epoch ms the stored result was first returned to a reader. */
  readAt?: number;
  /** Set when the stop was requested; copied into the stored result. */
  stoppedBy?: StoppedBy;
  /** Set while the subagent is blocked in `ask_parent`. See change: add-subagent-orchestration. */
  asking?: { questionId: string; question: string; askedAt: number };
}

export interface BackgroundCounts {
  running: number;
  queued: number;
  idle: number;
  finishedUnread: number;
}

/** `lookup` miss reasons. */
export type LookupMiss = "not_found" | "ambiguous";

/** Minimal tool-result shape the registry reads on completion. */
export interface RunResultLike {
  content?: Array<{ type: string; text?: string }>;
  details?: Partial<AgentDetails> & { stopReason?: "queued" | "running" };
  isError?: boolean;
}

export interface BackgroundRegistryOptions {
  /** Field-cut applied to each entry as it is appended (default: identity). */
  cutEntry?: (entry: SubagentTimelineEntry) => SubagentTimelineEntry;
  /** Clock (tests). */
  now?: () => number;
  /** 6-hex-char id source (tests). */
  randomHex?: () => string;
}

export interface BackgroundRegistry {
  /** Register a new background subagent (status `queued`). */
  create(init: { agentId: string; subagentType: string; description: string; cwd?: string }): BackgroundRecord;
  /** `onUpdate` sink for the run: tracks status and the latest snapshot. */
  sink(record: BackgroundRecord): (update: { details?: AgentDetails }) => void;
  /** Mark the run as holding a slot. */
  markRunning(record: BackgroundRecord): void;
  /** Append one timeline step (field-cut). */
  appendEntry(record: BackgroundRecord, entry: SubagentTimelineEntry): void;
  /**
   * Store the current run's result; `idle` keeps the record alive (status
   * `idle`) instead of terminal. Once per run: returns false when this run's
   * result is already stored.
   */
  finish(record: BackgroundRecord, result: RunResultLike, opts?: { idle?: boolean }): boolean;
  /** Start the next run of an idle record (`run` + 1). */
  startRun(record: BackgroundRecord, status: "queued" | "running"): void;
  /** Idle → its last run's status. False when not idle. */
  dispose(record: BackgroundRecord): boolean;
  /** Idle records, oldest first. */
  idle(): BackgroundRecord[];
  /** Resolve a short id, full `agentId` or unique prefix of either. */
  lookup(idOrPrefix: string): BackgroundRecord | LookupMiss;
  /** Every record, oldest first. */
  list(): BackgroundRecord[];
  /** Queued + running records. */
  outstanding(): BackgroundRecord[];
  counts(): BackgroundCounts;
  /** Record that a terminal result was read (first read time is kept). */
  markRead(record: BackgroundRecord): void;
  /** Called after every record change; returns the unsubscribe function. */
  subscribe(listener: (record: BackgroundRecord) => void): () => void;
}

export function createBackgroundRegistry(opts: BackgroundRegistryOptions = {}): BackgroundRegistry {
  const cut = opts.cutEntry ?? ((e: SubagentTimelineEntry) => e);
  const now = opts.now ?? Date.now;
  const randomHex = opts.randomHex ?? (() => randomBytes(3).toString("hex"));
  const byId = new Map<string, BackgroundRecord>();
  const byAgentId = new Map<string, BackgroundRecord>();
  const listeners = new Set<(record: BackgroundRecord) => void>();

  function changed(record: BackgroundRecord): void {
    for (const l of [...listeners]) {
      try {
        l(record);
      } catch {
        /* a reader's failure never affects the run */
      }
    }
  }

  function newId(): string {
    for (let i = 0; i < 64; i++) {
      const id = `${BACKGROUND_ID_PREFIX}${randomHex()}`;
      if (!byId.has(id)) return id;
    }
    // Pathological collision run (or a stuck test source): widen the id.
    let id: string;
    do id = `${BACKGROUND_ID_PREFIX}${randomBytes(6).toString("hex")}`;
    while (byId.has(id));
    return id;
  }

  /** The current run's result is stored (idle or terminal). */
  const runDone = (record: BackgroundRecord): boolean => record.finishedRun === record.run;

  function setStatus(record: BackgroundRecord, status: BackgroundStatus): boolean {
    if (runDone(record) || record.status === status) return false;
    if (record.status !== "idle" && isTerminalStatus(record.status)) return false;
    record.status = status;
    return true;
  }

  return {
    create({ agentId, subagentType, description, cwd }) {
      const record: BackgroundRecord = {
        id: newId(),
        agentId,
        subagentType,
        description,
        ...(cwd !== undefined ? { cwd } : {}),
        createdAt: now(),
        status: "queued",
        run: 1,
        entries: [],
      };
      byId.set(record.id, record);
      byAgentId.set(agentId, record);
      changed(record);
      return record;
    },

    sink(record) {
      return (update) => {
        const details = update?.details;
        if (!details || runDone(record)) return;
        record.latest = details;
        // Terminal states are stored by `finish`, which has the result text.
        if (details.status && !isTerminalStatus(details.status)) setStatus(record, details.status);
        changed(record);
      };
    },

    markRunning(record) {
      if (setStatus(record, "running")) changed(record);
    },

    appendEntry(record, entry) {
      record.entries.push(cut(entry));
    },

    finish(record, res, opts) {
      if (runDone(record)) return false;
      const d = res.details ?? {};
      const status: AgentStatus =
        d.status && isTerminalStatus(d.status) ? d.status : res.isError ? "error" : "completed";
      const stoppedBy = (d as { stoppedBy?: StoppedBy }).stoppedBy ?? record.stoppedBy;
      record.result = {
        status,
        ...(d.stopReason ? { stopReason: d.stopReason } : {}),
        ...(status === "stopped" && stoppedBy ? { stoppedBy } : {}),
        result: (res.content ?? [])
          .filter((c) => c?.type === "text" && typeof c.text === "string")
          .map((c) => c.text)
          .join("\n"),
        ...(d.error !== undefined ? { error: d.error } : {}),
        isError: res.isError === true,
        ...(d.tokensUsage ? { tokens: d.tokensUsage } : {}),
        durationMs: typeof d.durationMs === "number" ? d.durationMs : now() - record.createdAt,
        finishedAt: now(),
      };
      record.finishedRun = record.run;
      record.readAt = undefined;
      record.status = opts?.idle ? "idle" : status;
      if (d.agentId) record.latest = { ...(record.latest ?? {}), ...(d as AgentDetails) };
      changed(record);
      return true;
    },

    startRun(record, status) {
      if (record.status !== "idle") return;
      record.run += 1;
      record.status = status;
      changed(record);
    },

    dispose(record) {
      if (record.status !== "idle" || !record.result) return false;
      record.status = record.result.status;
      changed(record);
      return true;
    },

    idle() {
      return [...byId.values()].filter((r) => r.status === "idle");
    },

    lookup(raw) {
      const key = typeof raw === "string" ? raw.trim() : "";
      if (!key) return "not_found";
      const exact = byId.get(key) ?? byAgentId.get(key);
      if (exact) return exact;
      const hits = new Set<BackgroundRecord>();
      for (const [id, r] of byId) if (id.startsWith(key)) hits.add(r);
      for (const [agentId, r] of byAgentId) if (agentId.startsWith(key)) hits.add(r);
      if (hits.size === 1) return [...hits][0]!;
      return hits.size === 0 ? "not_found" : "ambiguous";
    },

    list() {
      return [...byId.values()];
    },

    outstanding() {
      return [...byId.values()].filter((r) => r.status === "queued" || r.status === "running");
    },

    counts() {
      const c: BackgroundCounts = { running: 0, queued: 0, idle: 0, finishedUnread: 0 };
      for (const r of byId.values()) {
        if (r.status === "running") c.running++;
        else if (r.status === "queued") c.queued++;
        else if (r.status === "idle") {
          c.idle++;
          if (r.readAt === undefined) c.finishedUnread++;
        }
        else if (r.result && r.readAt === undefined) c.finishedUnread++;
      }
      return c;
    },

    markRead(record) {
      if (record.result && record.readAt === undefined) {
        record.readAt = now();
        changed(record);
      }
    },

    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
