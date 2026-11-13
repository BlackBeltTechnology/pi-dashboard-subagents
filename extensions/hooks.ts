/**
 * Plugin hooks on `pi.events` (change: add-background-subagents, design D10).
 *
 * Intercept channels (`subagents:before_spawn`, `subagents:before_store`) and
 * query channels (`subagents:list`, `subagents:get`) pass a mutable payload
 * that handlers fill SYNCHRONOUSLY during `emit`. Values set after `emit`
 * returns are ignored (each emit gets a fresh object, read once).
 *
 * pi's bus wraps every handler in its own try/catch, so a throwing handler
 * never stops the others. Because it swallows errors silently, we also guard
 * our own handlers and log failures.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import type { AgentStatus, SubagentTimelineEntry } from "./events.js";
import type {
  BackgroundAgentStatus,
  BackgroundAgentSummary,
  BackgroundMessagesPage,
} from "./background-tools.js";

// ─── Channel names ───────────────────────────────────────────────────────

export const SUBAGENT_CHANNELS = {
  created: "subagents:created",
  started: "subagents:started",
  entry: "subagents:entry",
  delta: "subagents:delta",
  completed: "subagents:completed",
  failed: "subagents:failed",
  resultRead: "subagents:result_read",
  retry: "subagents:retry",
  beforeSpawn: "subagents:before_spawn",
  beforeStore: "subagents:before_store",
  list: "subagents:list",
  get: "subagents:get",
  stop: "subagents:stop",
  // Orchestration observe events (ids only, never text). See change: add-subagent-orchestration.
  question: "subagents:question",
  answer: "subagents:answer",
  slot: "subagents:slot",
  steer: "subagents:steer",
  idle: "subagents:idle",
  disposed: "subagents:disposed",
  mail: "subagents:mail",
  mailDropped: "subagents:mail_dropped",
  wait: "subagents:wait",
  push: "subagents:push",
} as const;

// ─── Payload types ───────────────────────────────────────────────────────

/** Spawn arguments a `before_spawn` handler sees. Read-only: patch instead. */
export interface SpawnArgs {
  subagent_type: string;
  description: string;
  prompt: string;
  model?: string;
  run_in_background?: boolean;
  timeout_s?: number;
}

/** `subagents:before_spawn`: veto or patch any spawn, before anything is created. */
export interface BeforeSpawnPayload {
  readonly args: Readonly<SpawnArgs>;
  readonly background: boolean;
  veto?: boolean;
  reason?: string;
  patch?: { prompt?: string; model?: string; description?: string };
}

/** `subagents:before_store`: transform a terminal result before it is bounded, stored or returned. */
export interface BeforeStorePayload {
  /** Short `bg-` id; absent for foreground runs. */
  readonly id?: string;
  readonly agentId: string;
  readonly background: boolean;
  readonly status: AgentStatus;
  readonly result: string;
  patch?: { result?: string };
}

/**
 * `subagents:result_read`: a stored background result was returned to a reader
 * (`wait`), delivered by a push, or its timeline read (`messages`).
 * See change: agent-control-unified-wait.
 */
export interface ResultReadEvent {
  id: string;
  agentId: string;
  via: "wait" | "push" | "messages";
}

/** `subagents:list` query. */
export interface ListQueryPayload {
  filter?: { status?: AgentStatus };
  out?: BackgroundAgentSummary[];
}

/** `subagents:get` query. */
export interface GetQueryPayload {
  id: string;
  from?: number;
  limit?: number;
  kinds?: Array<SubagentTimelineEntry["kind"]>;
  out?: { status: BackgroundAgentStatus; messages: BackgroundMessagesPage };
}

/** `subagents:stop` control event. */
export interface StopRequest {
  agentId: string;
}

// ─── Orchestration observe events (add-subagent-orchestration, D11) ───────
// Ids, kinds, counters and results only: never question / answer / steer /
// summary text.

/** `subagents:question`: a background subagent called `ask_parent`. */
export interface QuestionEvent {
  id: string;
  agentId: string;
  question_id: string;
  run: number;
}
/** `subagents:answer`: a pending ask settled. */
export interface AnswerEvent {
  id: string;
  agentId: string;
  question_id: string;
  via: "reply" | "cancel";
}
/** `subagents:slot`: concurrency slot hand-off around `ask_parent`. */
export interface SlotEvent {
  id: string;
  agentId: string;
  action: "released" | "reacquire_queued" | "reacquired";
  queuePosition?: number;
}
/** `subagents:steer`: one id of an `AgentControl` steer. */
export interface SteerEvent {
  id: string;
  agentId: string;
  mode: "steer" | "followUp";
  result: "queued" | "started" | "not_started" | "not_alive" | "not_found" | "foreground";
}
/** `subagents:idle`: a run ended and the session stays alive. */
export interface IdleEvent {
  id: string;
  agentId: string;
  run: number;
}
/** `subagents:disposed`: an idle session was freed. */
export interface DisposedEvent {
  id: string;
  agentId: string;
  reason: "ttl" | "cap" | "cancel" | "shutdown";
}
/** `subagents:mail`: a mailbox entry was posted. */
export interface MailEvent {
  id: string;
  agentId: string;
  seq: number;
  kind: "question" | "outcome";
  outcome?: "done" | "failed" | "stopped";
}
/**
 * @deprecated Never emitted: pending entries are a registry view and are never
 * dropped. Kept so plugin type imports keep compiling. See change:
 * agent-control-unified-wait.
 */
export interface MailDroppedEvent {
  id: string;
  agentId: string;
  seq: number;
}
/** `subagents:wait`: an `AgentControl` wait began / ended. */
export type WaitEvent =
  | { phase: "start"; ids?: string[] }
  | { phase: "end"; returned: number; timedOut: boolean };
/** `subagents:push`: a batched update was sent to the parent. */
export interface PushEvent {
  seqs: number[];
  count: number;
  triggerTurn: boolean;
}

/** Payload shape per observable channel, for {@link onSubagentEvent}. */
export interface SubagentEventMap {
  "subagents:created": { id: string; type: string; description: string; details: import("./events.js").AgentDetails };
  "subagents:started": { id: string; details: import("./events.js").AgentDetails };
  "subagents:entry": import("./events.js").SubagentEntryEvent;
  "subagents:delta": import("./events.js").SubagentDeltaEvent;
  "subagents:completed": {
    id: string;
    result: string;
    durationMs: number;
    tokens: import("./events.js").TokenUsage;
    toolUses: number;
    details: import("./events.js").AgentDetails;
  };
  "subagents:failed": {
    id: string;
    error: string;
    durationMs: number;
    toolUses?: number;
    details: import("./events.js").AgentDetails;
  };
  "subagents:result_read": ResultReadEvent;
  "subagents:retry": import("./events.js").SubagentRetryEvent;
  "subagents:before_spawn": BeforeSpawnPayload;
  "subagents:before_store": BeforeStorePayload;
  "subagents:list": ListQueryPayload;
  "subagents:get": GetQueryPayload;
  "subagents:stop": StopRequest;
  "subagents:question": QuestionEvent;
  "subagents:answer": AnswerEvent;
  "subagents:slot": SlotEvent;
  "subagents:steer": SteerEvent;
  "subagents:idle": IdleEvent;
  "subagents:disposed": DisposedEvent;
  "subagents:mail": MailEvent;
  "subagents:mail_dropped": MailDroppedEvent;
  "subagents:wait": WaitEvent;
  "subagents:push": PushEvent;
}

// ─── Bus access ──────────────────────────────────────────────────────────

type Bus = { emit?: (channel: string, data: unknown) => void; on?: (channel: string, h: (d: unknown) => void) => unknown };

function busOf(pi: ExtensionAPI | undefined): Bus | undefined {
  return (pi as { events?: Bus } | undefined)?.events;
}

/** Emit a mutable payload; never throws. */
export function emitMutable<T extends object>(pi: ExtensionAPI, channel: string, payload: T): T {
  try {
    busOf(pi)?.emit?.(channel, payload);
  } catch (err) {
    console.warn(`[pi-dashboard-subagents] ${channel} handler failed:`, err instanceof Error ? err.message : err);
  }
  return payload;
}

/** Subscribe a handler that never throws out of the bus. */
export function onGuarded(pi: ExtensionAPI, channel: string, handler: (data: unknown) => void): void {
  const bus = busOf(pi);
  if (typeof bus?.on !== "function") return;
  bus.on(channel, (data) => {
    try {
      handler(data);
    } catch (err) {
      console.warn(`[pi-dashboard-subagents] ${channel} handler failed:`, err instanceof Error ? err.message : err);
    }
  });
}

/**
 * Run `subagents:before_spawn` and return the outcome, reading the payload
 * once, right after `emit` returns.
 */
export function runBeforeSpawn(
  pi: ExtensionAPI,
  args: SpawnArgs,
  background: boolean,
): { veto: true; reason: string } | { veto: false; args: SpawnArgs } {
  const payload: BeforeSpawnPayload = { args: Object.freeze({ ...args }), background };
  emitMutable(pi, SUBAGENT_CHANNELS.beforeSpawn, payload);
  // Snapshot now: later writes are ignored.
  const veto = payload.veto === true;
  const reason = typeof payload.reason === "string" ? payload.reason : undefined;
  const patch = payload.patch && typeof payload.patch === "object" ? { ...payload.patch } : undefined;
  if (veto) return { veto: true, reason: reason ?? "vetoed by a plugin" };
  const next: SpawnArgs = { ...args };
  if (patch) {
    if (typeof patch.prompt === "string") next.prompt = patch.prompt;
    if (typeof patch.description === "string") next.description = patch.description;
    if (typeof patch.model === "string") next.model = patch.model;
  }
  return { veto: false, args: next };
}

/** Run `subagents:before_store`; returns the (possibly patched) result text. */
export function runBeforeStore(pi: ExtensionAPI, info: Omit<BeforeStorePayload, "patch">): string {
  const payload: BeforeStorePayload = { ...info };
  emitMutable(pi, SUBAGENT_CHANNELS.beforeStore, payload);
  const patched = payload.patch?.result;
  return typeof patched === "string" ? patched : info.result;
}

// ─── Exported helpers for plugin authors ─────────────────────────────────

/**
 * Subscribe to one `subagents:*` channel with a typed payload. Returns the
 * unsubscribe function (a no-op when the host bus has none).
 */
export function onSubagentEvent<K extends keyof SubagentEventMap>(
  pi: ExtensionAPI,
  channel: K,
  handler: (payload: SubagentEventMap[K]) => void,
): () => void {
  const bus = busOf(pi);
  if (typeof bus?.on !== "function") return () => {};
  const off = bus.on(channel, (d) => handler(d as SubagentEventMap[K]));
  return typeof off === "function" ? (off as () => void) : () => {};
}

/** Every background subagent of the session that answers (`subagents:list`). */
export function listBackgroundAgents(pi: ExtensionAPI, filter?: ListQueryPayload["filter"]): BackgroundAgentSummary[] {
  const payload: ListQueryPayload = filter ? { filter } : {};
  emitMutable(pi, SUBAGENT_CHANNELS.list, payload);
  return payload.out ?? [];
}

/** Status plus a page of messages for one background subagent (`subagents:get`). */
export function getBackgroundAgent(
  pi: ExtensionAPI,
  id: string,
  page: Omit<GetQueryPayload, "id" | "out"> = {},
): GetQueryPayload["out"] {
  const payload: GetQueryPayload = { id, ...page };
  emitMutable(pi, SUBAGENT_CHANNELS.get, payload);
  return payload.out;
}

/** Ask the owning session to stop one subagent (`subagents:stop`). */
export function stopSubagent(pi: ExtensionAPI, agentId: string): void {
  emitMutable(pi, SUBAGENT_CHANNELS.stop, { agentId } satisfies StopRequest);
}
