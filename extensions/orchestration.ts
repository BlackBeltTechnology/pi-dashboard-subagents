/**
 * Per-activation orchestration of background subagents.
 *
 * Owns, for ONE parent activation (created inside `activate()`, never
 * module-level):
 *   - the idle pool: finished background runs whose session stays alive for
 *     `steer`, freed by TTL, the idle cap, cancel or shutdown (D5);
 *   - the mailbox: `question` (from `ask_parent`) and `outcome` (every run
 *     end) entries, drained by the `wait` action or pushed to the parent as
 *     one batched follow-up (D7);
 *   - pending asks: `ask_parent` blocks until `reply` (no timeout); stops
 *     settle it (D9);
 *   - the text the parent sees: full question form with reply instructions,
 *     short ask line for status/list (D14).
 *
 * Children stay in-memory; the parent JSONL is the only durable record
 * (each run end is persisted with `appendEntry`, D8).
 *
 * See change: add-subagent-orchestration.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import type { DisposeReason, IdleHandle, LiveSession } from "./agent.js";
import { askLineOf } from "./background-tools.js";
import type { BackgroundRecord, BackgroundRegistry, RunResultLike } from "./background.js";

/** Max undelivered mailbox entries; overflow drops the oldest outcome. */
export const MAILBOX_MAX = 100;
/** Outcome summary length in mailbox entries and pushes. */
export const OUTCOME_SUMMARY_CHARS = 500;
/** Default `wait` timeout. */
export const DEFAULT_WAIT_MS = 300_000;
/** Late arrivals joining a woken `wait`. */
const WAIT_COALESCE_MS = 250;
/** Push batching window. */
const PUSH_BATCH_MS = 1_000;

export type OutcomeKind = "done" | "failed" | "stopped";

export interface MailEntry {
  seq: number;
  /** Short `bg-` id. */
  id: string;
  agentId: string;
  kind: "question" | "outcome";
  questionId?: string;
  outcome?: OutcomeKind;
  /** Question text, or the bounded outcome summary. Never put on the bus. */
  text: string;
  run: number;
  cwd?: string;
  ts: number;
}

export interface WaitResult {
  entries: MailEntry[];
  timedOut: boolean;
  interrupted: boolean;
}

export type ReplyResult = "answered" | "not_pending" | "not_found" | "not_alive";

export type SteerResult = "queued" | "started" | "not_started" | "not_alive" | "not_found" | "foreground";
export type SteerMode = "steer" | "followUp";

export interface OrchestratorOptions {
  pi: ExtensionAPI;
  registry: BackgroundRegistry;
  /** Idle keep-alive in seconds (`0` = none). Read per park. */
  idleTtlSec: () => number;
  /** Cap on idle subagents. Read per park. */
  maxIdle: () => number;
  /** Whether mailbox entries are pushed to the parent. Read per post. */
  notifyParent: () => boolean;
  /** Mailbox bound (tests). */
  maxMailbox?: number;
}

export interface Orchestrator {
  /**
   * A background run ended: store it, post its outcome, persist it. With
   * `handle` the session stays alive (`idle`); without it the result is
   * terminal. No-op when this run is already stored.
   */
  runEnded(record: BackgroundRecord, result: RunResultLike, handle?: IdleHandle): void;
  /** The idle session behind `record` was freed (called from the run). */
  idleDisposed(record: BackgroundRecord, reason: DisposeReason): void;
  /** Free an idle subagent. False when it is not idle here. */
  dispose(record: BackgroundRecord, reason: DisposeReason): boolean;
  /** Free every idle subagent. */
  disposeAll(reason: DisposeReason): void;
  /** Start the next run of an idle subagent; undefined when not idle here. */
  continueRun(record: BackgroundRecord, message: string): "started" | "queued" | undefined;
  /** Post a question; the promise settles on `reply` or rejects on cancel. */
  ask(record: BackgroundRecord, question: string): { questionId: string; answer: Promise<string> };
  /** Answer a pending question. */
  reply(id: string, questionId: string, answer: string): ReplyResult;
  /** Settle (reject) every pending ask of `record`. */
  cancelAsks(record: BackgroundRecord): void;
  /** Undelivered mailbox entries, oldest first. */
  pending(): MailEntry[];
  /** Block until entries for `ids` (or any) arrive; drains them. One at a time. */
  wait(opts: { ids?: readonly string[]; timeoutMs?: number; signal?: AbortSignal }): Promise<WaitResult>;
  /** Parent-facing text for entries: full question form + outcomes (D14). */
  render(entries: readonly MailEntry[]): string;
  /** Short one-line ask form for status/list, or undefined when not asking. */
  askLine(record: BackgroundRecord): string | undefined;
  /** Stop pushes and settle every pending ask. */
  shutdown(): void;
  /** The run's live session (for `steer` while running). */
  attachSession(record: BackgroundRecord, live: LiveSession): void;
  /** Slot hand-off around `ask_parent` (design D12), as an event. */
  slot(record: BackgroundRecord, action: "released" | "reacquire_queued" | "reacquired", queuePosition?: number): void;
  /** Route one steer (design D6); emits `subagents:steer`. */
  steer(record: BackgroundRecord, message: string, mode: SteerMode): Promise<SteerResult>;
}

function emit(pi: ExtensionAPI, channel: string, data: Record<string, unknown>): void {
  try {
    pi.events?.emit(channel, data);
  } catch {
    /* a broken bus never breaks orchestration */
  }
}

function cut(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

function outcomeOf(record: BackgroundRecord): OutcomeKind {
  const st = record.result?.status;
  if (st === "completed") return "done";
  if (st === "stopped") return "stopped";
  return "failed";
}

export function createOrchestrator(opts: OrchestratorOptions): Orchestrator {
  const { pi, registry } = opts;
  const maxMailbox = opts.maxMailbox ?? MAILBOX_MAX;
  /** Idle handles by record id, in park order (oldest first). */
  const idle = new Map<string, { record: BackgroundRecord; handle: IdleHandle; timer?: ReturnType<typeof setTimeout> }>();
  /** Undelivered entries, oldest first. */
  let mailbox: MailEntry[] = [];
  let seq = 0;
  let questionSeq = 0;
  const asks = new Map<
    string,
    { record: BackgroundRecord; resolve: (a: string) => void; reject: (e: Error) => void }
  >();
  let waiter: { matches: (e: MailEntry) => boolean; wake: () => void } | undefined;
  let pushTimer: ReturnType<typeof setTimeout> | undefined;
  let shut = false;
  /** Live sessions of background subagents that may still run. */
  const live = new Map<string, LiveSession>();

  // ── idle pool ──

  function unpark(record: BackgroundRecord): IdleHandle | undefined {
    const slot = idle.get(record.id);
    if (!slot) return undefined;
    if (slot.timer) clearTimeout(slot.timer);
    idle.delete(record.id);
    return slot.handle;
  }

  function enforceCap(): void {
    const max = opts.maxIdle();
    while (idle.size > Math.max(0, max)) {
      const oldest = idle.values().next().value!;
      oldest.handle.dispose("cap");
      unpark(oldest.record); // in case the handle did not report back
    }
  }

  // ── mailbox ──

  function removeQuestion(questionId: string): void {
    mailbox = mailbox.filter((e) => e.questionId !== questionId);
  }

  function post(entry: Omit<MailEntry, "seq" | "ts">): void {
    const full: MailEntry = { ...entry, seq: ++seq, ts: Date.now() };
    mailbox.push(full);
    emit(pi, "subagents:mail", {
      id: full.id,
      agentId: full.agentId,
      seq: full.seq,
      kind: full.kind,
      ...(full.outcome ? { outcome: full.outcome } : {}),
    });
    while (mailbox.length > maxMailbox) {
      const idx = mailbox.findIndex((e) => e.kind === "outcome");
      if (idx === -1) break; // questions are never dropped
      const [dropped] = mailbox.splice(idx, 1);
      emit(pi, "subagents:mail_dropped", { id: dropped!.id, agentId: dropped!.agentId, seq: dropped!.seq });
    }
    if (waiter?.matches(full)) waiter.wake();
    else schedulePush();
  }

  function take(matches: (e: MailEntry) => boolean): MailEntry[] {
    const out = mailbox.filter(matches);
    mailbox = mailbox.filter((e) => !matches(e));
    return out;
  }

  // ── push ──

  function schedulePush(): void {
    if (shut || waiter || pushTimer || mailbox.length === 0 || !opts.notifyParent()) return;
    pushTimer = setTimeout(flushPush, PUSH_BATCH_MS);
    (pushTimer as { unref?: () => void }).unref?.();
  }

  function flushPush(): void {
    pushTimer = undefined;
    if (shut || waiter || !opts.notifyParent()) return;
    const entries = take(() => true);
    if (entries.length === 0) return;
    const seqs = entries.map((e) => e.seq);
    try {
      // followUp never interrupts a streaming parent; triggerTurn only
      // starts a turn when the parent is idle (pi semantics).
      pi.sendMessage(
        {
          customType: "subagents:mail",
          content: `Background subagent updates:\n\n${self.render(entries)}`,
          display: true,
          details: { seqs },
        },
        { deliverAs: "followUp", triggerTurn: true },
      );
    } catch (err) {
      console.warn("[pi-dashboard-subagents] push to parent failed:", err instanceof Error ? err.message : err);
    }
    emit(pi, "subagents:push", { seqs, count: entries.length, triggerTurn: true });
  }

  // ── persistence ──

  function persistRun(record: BackgroundRecord, result: RunResultLike): void {
    try {
      pi.appendEntry?.("subagents:run", {
        id: record.id,
        agentId: record.agentId,
        run: record.run,
        ...(record.cwd !== undefined ? { cwd: record.cwd } : {}),
        status: record.result?.status,
        result: record.result?.result,
        ...(result.details ? { details: result.details } : {}),
      });
    } catch {
      /* persistence is best-effort */
    }
  }

  const self: Orchestrator = {
    runEnded(record, result, handle) {
      if (!registry.finish(record, result, { idle: handle !== undefined })) return;
      if (!handle) live.delete(record.id);
      persistRun(record, result);
      post({
        id: record.id,
        agentId: record.agentId,
        kind: "outcome",
        outcome: outcomeOf(record),
        text: cut(record.result?.result ?? "", OUTCOME_SUMMARY_CHARS),
        run: record.run,
        ...(record.cwd !== undefined ? { cwd: record.cwd } : {}),
      });
      if (!handle) return;
      const ttlSec = opts.idleTtlSec();
      const timer =
        ttlSec > 0
          ? setTimeout(() => {
              if (idle.get(record.id)?.handle === handle) handle.dispose("ttl");
            }, ttlSec * 1000)
          : undefined;
      (timer as { unref?: () => void } | undefined)?.unref?.();
      idle.set(record.id, { record, handle, ...(timer ? { timer } : {}) });
      emit(pi, "subagents:idle", { id: record.id, agentId: record.agentId, run: record.run });
      if (ttlSec <= 0) handle.dispose("ttl");
      else enforceCap();
    },

    idleDisposed(record, reason) {
      unpark(record);
      live.delete(record.id);
      if (registry.dispose(record)) {
        emit(pi, "subagents:disposed", { id: record.id, agentId: record.agentId, reason });
      }
    },

    dispose(record, reason) {
      const slot = idle.get(record.id);
      if (!slot) return false;
      slot.handle.dispose(reason);
      unpark(record);
      return true;
    },

    disposeAll(reason) {
      for (const { record } of [...idle.values()]) self.dispose(record, reason);
    },

    continueRun(record, message) {
      if (record.status !== "idle") return undefined;
      const handle = unpark(record);
      if (!handle) return undefined;
      const status = handle.continueWith(message);
      registry.startRun(record, status === "started" ? "running" : "queued");
      return status;
    },

    ask(record, question) {
      const questionId = `q${++questionSeq}`;
      const answer = new Promise<string>((resolve, reject) => {
        asks.set(questionId, { record, resolve, reject });
      });
      answer.catch(() => {}); // the caller awaits; never an unhandled rejection
      record.asking = { questionId, question, askedAt: Date.now() };
      emit(pi, "subagents:question", { id: record.id, agentId: record.agentId, question_id: questionId, run: record.run });
      post({
        id: record.id,
        agentId: record.agentId,
        kind: "question",
        questionId,
        text: question,
        run: record.run,
        ...(record.cwd !== undefined ? { cwd: record.cwd } : {}),
      });
      return { questionId, answer };
    },

    reply(id, questionId, answer) {
      const hit = registry.lookup(id);
      if (typeof hit === "string") return "not_found";
      const ask = asks.get(questionId);
      if (!ask || ask.record !== hit) {
        const alive = hit.status === "running" || hit.status === "queued" || hit.status === "idle";
        return alive ? "not_pending" : "not_alive";
      }
      asks.delete(questionId);
      if (hit.asking?.questionId === questionId) hit.asking = undefined;
      removeQuestion(questionId);
      emit(pi, "subagents:answer", { id: hit.id, agentId: hit.agentId, question_id: questionId, via: "reply" });
      ask.resolve(answer);
      return "answered";
    },

    cancelAsks(record) {
      for (const [questionId, ask] of [...asks]) {
        if (ask.record !== record) continue;
        asks.delete(questionId);
        removeQuestion(questionId);
        emit(pi, "subagents:answer", {
          id: record.id,
          agentId: record.agentId,
          question_id: questionId,
          via: "cancel",
        });
        ask.reject(new Error("ask_parent cancelled: the subagent was stopped"));
      }
      record.asking = undefined;
    },

    pending() {
      return mailbox.slice();
    },

    wait({ ids, timeoutMs = DEFAULT_WAIT_MS, signal }) {
      if (waiter) return Promise.reject(new Error("wait_in_progress: another AgentControl wait is already blocking"));
      let matches: (e: MailEntry) => boolean = () => true;
      if (ids && ids.length > 0) {
        const wanted = new Set<string>();
        for (const id of ids) {
          const hit = registry.lookup(id);
          if (typeof hit !== "string") wanted.add(hit.id);
        }
        matches = (e) => wanted.has(e.id);
      }
      emit(pi, "subagents:wait", { phase: "start", ...(ids && ids.length > 0 ? { ids: [...ids] } : {}) });
      return new Promise<WaitResult>((resolve) => {
        // Timers live in one holder: early-return paths call `finish` before
        // they are armed.
        const timers: { main?: ReturnType<typeof setTimeout>; coalesce?: ReturnType<typeof setTimeout> } = {};
        const finish = (timedOut: boolean, interrupted: boolean): void => {
          if (timers.main) clearTimeout(timers.main);
          if (timers.coalesce) clearTimeout(timers.coalesce);
          signal?.removeEventListener("abort", onAbort);
          waiter = undefined;
          const entries = interrupted ? [] : take(matches);
          emit(pi, "subagents:wait", { phase: "end", returned: entries.length, timedOut });
          resolve({ entries, timedOut, interrupted });
          schedulePush(); // leftovers for other children
        };
        const onAbort = (): void => finish(false, true);
        if (signal?.aborted) {
          waiter = { matches, wake: () => {} };
          return finish(false, true);
        }
        if (mailbox.some(matches)) {
          waiter = { matches, wake: () => {} };
          return finish(false, false);
        }
        waiter = {
          matches,
          wake: () => {
            if (!timers.coalesce) timers.coalesce = setTimeout(() => finish(false, false), WAIT_COALESCE_MS);
          },
        };
        if (pushTimer) {
          clearTimeout(pushTimer);
          pushTimer = undefined;
        }
        signal?.addEventListener("abort", onAbort, { once: true });
        timers.main = setTimeout(() => finish(true, false), timeoutMs);
      });
    },

    render(entries) {
      const now = Date.now();
      const lines: string[] = [];
      let questions = 0;
      for (const e of entries) {
        const where = e.cwd ? `, cwd ${e.cwd}` : "";
        if (e.kind === "question") {
          questions++;
          lines.push(
            `⏸ ${e.id} is BLOCKED until you answer (asked ${Math.round((now - e.ts) / 1000)}s ago${where})\n` +
              `  ${e.questionId}: "${e.text}"\n` +
              `  → reply now: AgentControl({ action: "reply", id: "${e.id}", question_id: "${e.questionId}", answer: "…" })`,
          );
        } else {
          const rec = registry.lookup(e.id);
          const isIdle = typeof rec !== "string" && rec.status === "idle";
          lines.push(
            `${e.outcome === "done" ? "✓" : e.outcome === "stopped" ? "■" : "✗"} ${e.id} ${e.outcome} (run ${e.run}${where}): ${e.text}` +
              (isIdle
                ? `\n  → continue it: AgentControl({ action: "steer", id: "${e.id}", message: "…", mode: "followUp" })`
                : ""),
          );
        }
      }
      if (questions > 1) {
        lines.push(
          'answer all at once: AgentControl({ action: "reply", replies: [{ id, question_id, answer }, …] })',
        );
      }
      return lines.join("\n\n");
    },

    askLine(record) {
      return askLineOf(record);
    },

    attachSession(record, session) {
      live.set(record.id, session);
    },

    slot(record, action, queuePosition) {
      emit(pi, "subagents:slot", {
        id: record.id,
        agentId: record.agentId,
        action,
        ...(queuePosition !== undefined ? { queuePosition } : {}),
      });
    },

    async steer(record, message, mode) {
      let result: SteerResult;
      if (record.status === "idle") {
        result = self.continueRun(record, message) ?? "not_alive";
      } else if (record.status === "queued") {
        result = "not_started";
      } else if (record.status === "running") {
        const session = live.get(record.id);
        if (!session) result = "not_started";
        else {
          try {
            await (mode === "followUp" ? session.followUp(message) : session.steer(message));
            result = "queued";
          } catch {
            result = "not_alive";
          }
        }
      } else {
        result = "not_alive";
      }
      emit(pi, "subagents:steer", { id: record.id, agentId: record.agentId, mode, result });
      return result;
    },

    shutdown() {
      shut = true;
      if (pushTimer) clearTimeout(pushTimer);
      pushTimer = undefined;
      for (const { record } of [...asks.values()]) self.cancelAsks(record);
    },
  };
  return self;
}
