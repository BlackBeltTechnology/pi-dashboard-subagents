/**
 * `AgentControl`: the ONE parent-side tool for background subagents.
 *
 * Every tool definition costs parent context on every turn, so all
 * background operations are `action`s of this single tool instead of one tool
 * each: `status`, `list`, `messages`, `cancel` (formerly `AgentStatus`,
 * `AgentList`, `AgentMessages`, `AgentCancel`, same parameters) plus the
 * orchestration actions `wait`, `reply`, `steer`.
 *
 * The schema is one flat object (required `action` + every action's
 * parameters as optionals); `execute` validates per action.
 *
 * See change: add-subagent-orchestration (design D0).
 */
import { Type } from "@sinclair/typebox";

import { type AgentToolUpdateCallback, defineTool, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";

import type { BackgroundRegistry } from "./background.js";
import {
  countsLine,
  type DisposeIdle,
  makeAgentCancelTool,
  makeAgentListTool,
  makeAgentMessagesTool,
  makeAgentStatusTool,
  type StopAgent,
} from "./background-tools.js";
import { DEFAULT_WAIT_MS, type MailEntry, type Orchestrator, type ReplyResult, type SteerMode, type SteerResult } from "./orchestration.js";
import { getResultLimits } from "./settings.js";

export const AGENT_CONTROL_TOOL_NAME = "AgentControl";

export const AGENT_CONTROL_ACTIONS = ["status", "list", "messages", "cancel", "wait", "reply", "steer"] as const;
export type AgentControlAction = (typeof AGENT_CONTROL_ACTIONS)[number];

type ToolResult = { content: Array<{ type: "text"; text: string }>; details: unknown; isError?: boolean };

/** One action's handler: same signature as a tool `execute`, minus the action. */
export type ActionHandler = (
  toolCallId: string,
  params: Record<string, unknown>,
  signal: AbortSignal | undefined,
  onUpdate: AgentToolUpdateCallback<unknown> | undefined,
  ctx: ExtensionContext | undefined,
) => Promise<ToolResult>;

export interface AgentControlDeps {
  pi: ExtensionAPI;
  registry: BackgroundRegistry;
  stopAgent: StopAgent;
  disposeIdle?: DisposeIdle;
  /** Mailbox, asks and steering; enables the `wait`, `reply` and `steer` actions. */
  orchestrator?: Orchestrator;
  /** `id` names a foreground run of this activation (steer → `foreground`). */
  isForeground?: (id: string) => boolean;
}

/** Cut `text` to `max` chars (0 = unlimited). */
function bound(text: string, max: number): string {
  return max > 0 && text.length > max ? `${text.slice(0, max)}\n[… ${text.length - max} chars truncated …]` : text;
}

function ok(text: string, details: unknown): ToolResult {
  return { content: [{ type: "text", text: bound(text, getResultLimits().resultMaxChars) }], details };
}

/** `wait`: block on the mailbox, return every pending entry with reply instructions (D7, D14). */
function waitAction(registry: BackgroundRegistry, orch: Orchestrator): ActionHandler {
  return async (_id, p, signal) => {
    const ids = Array.isArray(p.ids) ? p.ids.filter((x): x is string => typeof x === "string") : undefined;
    const timeoutMs =
      typeof p.timeout_s === "number" && p.timeout_s > 0 ? p.timeout_s * 1000 : DEFAULT_WAIT_MS;
    let res;
    try {
      res = await orch.wait({ ...(ids ? { ids } : {}), timeoutMs, ...(signal ? { signal } : {}) });
    } catch (err) {
      return errorResult(err instanceof Error ? err.message : String(err), { error: "wait_in_progress" });
    }
    const counts = registry.counts();
    const note = res.interrupted
      ? "(wait interrupted; nothing was cancelled)"
      : res.timedOut
        ? `(no messages within ${Math.round(timeoutMs / 1000)}s; nothing was cancelled)`
        : "";
    const body = res.entries.length > 0 ? orch.render(res.entries) : "No new messages.";
    return ok([body, note, `Background: ${countsLine(counts)}.`].filter(Boolean).join("\n\n"), {
      entries: res.entries.map(publicEntry),
      counts,
      ...(res.timedOut ? { timedOut: true } : {}),
      ...(res.interrupted ? { interrupted: true } : {}),
    });
  };
}

/**
 * Whether `id` names a background subagent persisted in the parent session
 * (`subagents:run` entries) — i.e. one that existed before a reload and is
 * no longer alive (design D8).
 */
export function isPersistedRun(ctx: ExtensionContext | undefined, id: string): boolean {
  const key = id.trim();
  if (!key) return false;
  try {
    const entries = (ctx?.sessionManager as { getEntries?: () => unknown[] } | undefined)?.getEntries?.() ?? [];
    return entries.some((e) => {
      const entry = e as { type?: string; customType?: string; data?: { id?: unknown; agentId?: unknown } };
      if (entry.type !== "custom" || entry.customType !== "subagents:run") return false;
      return entry.data?.id === key || entry.data?.agentId === key;
    });
  } catch {
    return false;
  }
}

const NOT_ALIVE_HINT =
  "\nnot_alive: that subagent no longer has a live session (finished and freed, or the session was reloaded). Spawn a new one.";

/** Entry as returned in `details` (same fields, question text included). */
function publicEntry(e: MailEntry) {
  return {
    seq: e.seq,
    id: e.id,
    kind: e.kind,
    ...(e.questionId ? { question_id: e.questionId } : {}),
    ...(e.outcome ? { outcome: e.outcome } : {}),
    text: e.text,
    run: e.run,
    ...(e.cwd ? { cwd: e.cwd } : {}),
  };
}

/** `reply`: answer one or many pending questions; each settles independently (D13). */
function replyAction(orch: Orchestrator): ActionHandler {
  return async (_id, p, _signal, _onUpdate, ctx) => {
    const items: Array<{ id: string; question_id: string; answer: string }> = Array.isArray(p.replies)
      ? (p.replies as Array<Record<string, unknown>>).map((r) => ({
          id: String(r?.id ?? ""),
          question_id: String(r?.question_id ?? ""),
          answer: String(r?.answer ?? ""),
        }))
      : [{ id: String(p.id), question_id: String(p.question_id), answer: String(p.answer) }];
    const results: Array<{ id: string; question_id: string; result: ReplyResult }> = items.map((r) => ({
      id: r.id,
      question_id: r.question_id,
      result: ((res) => (res === "not_found" && isPersistedRun(ctx, r.id) ? "not_alive" : res))(
        orch.reply(r.id, r.question_id, r.answer),
      ),
    }));
    const lines = results.map((r) => `${r.id} ${r.question_id}: ${r.result}`);
    const hint = results.some((r) => r.result === "not_alive") ? NOT_ALIVE_HINT : "";
    return ok(lines.join("\n") + hint, { results });
  };
}

/** `steer`: per id — running → steer/followUp, idle → next run, else a reason (D6). */
function steerAction(
  registry: BackgroundRegistry,
  orch: Orchestrator,
  isForeground: ((id: string) => boolean) | undefined,
): ActionHandler {
  return async (_id, p, _signal, _onUpdate, ctx) => {
    const ids =
      typeof p.id === "string" && p.id.trim() !== ""
        ? [p.id]
        : Array.isArray(p.ids)
          ? p.ids.filter((x): x is string => typeof x === "string")
          : [];
    const mode: SteerMode = p.mode === "followUp" ? "followUp" : "steer";
    const message = String(p.message);
    const results: Array<{ id: string; result: SteerResult }> = [];
    for (const id of ids) {
      const hit = registry.lookup(id);
      if (typeof hit === "string") {
        results.push({
          id,
          result: isForeground?.(id) ? "foreground" : isPersistedRun(ctx, id) ? "not_alive" : "not_found",
        });
        continue;
      }
      results.push({ id: hit.id, result: await orch.steer(hit, message, mode) });
    }
    const hint =
      (results.some((r) => r.result === "foreground")
        ? "\nOnly background subagents can be steered (spawn with run_in_background: true)."
        : "") + (results.some((r) => r.result === "not_alive") ? NOT_ALIVE_HINT : "");
    return ok(results.map((r) => `${r.id}: ${r.result}`).join("\n") + hint, { mode, results });
  };
}

const present = (v: unknown): boolean =>
  v !== undefined && v !== null && !(typeof v === "string" && v.trim() === "") && !(Array.isArray(v) && v.length === 0);

/** Missing required parameter names for `action`, or [] when complete. */
export function missingParams(action: AgentControlAction, p: Record<string, unknown>): string[] {
  switch (action) {
    case "status":
    case "cancel":
      return present(p.ids) ? [] : ["ids"];
    case "messages":
      return present(p.id) ? [] : ["id"];
    case "reply":
      if (present(p.replies)) return [];
      return ["id", "question_id", "answer"].filter((k) => !present(p[k]));
    case "steer": {
      const miss: string[] = [];
      if (!present(p.id) && !present(p.ids)) miss.push("id or ids");
      if (!present(p.message)) miss.push("message");
      return miss;
    }
    default:
      return [];
  }
}

function errorResult(text: string, details: Record<string, unknown>): ToolResult {
  return { content: [{ type: "text", text }], details, isError: true };
}

const DESCRIPTION = [
  "Manage background subagents (spawned with Agent run_in_background). One tool, pick an `action`:",
  'status {ids, wait?: "none"|"any"|"all", timeout_s?=300 when waiting} — state + stored result; idle counts as finished.',
  "list {} — every background subagent with status, run, cwd.",
  'cancel {ids | "all", status?} — stop queued/running (also while asking), free idle ones.',
  "wait {ids?, timeout_s?=300} — block until children post questions or outcomes; returns ALL pending at once.",
  "reply {id, question_id, answer} | {replies:[...]} — answer blocked ask_parent questions; the child waits until you do, answer promptly.",
  'steer {id | ids, message, mode?: "steer"|"followUp"} — redirect a running child or continue an idle one. Only background subagents can be steered.',
  "messages {id, from?, limit?, kinds?} — DEBUG view of a child's raw timeline; do not use it to coordinate (use wait / status / steer).",
].join("\n");

export function makeAgentControlTool(deps: AgentControlDeps) {
  const { pi, registry } = deps;
  const builtin: Partial<Record<AgentControlAction, ActionHandler>> = {
    status: makeAgentStatusTool(pi, registry).execute as unknown as ActionHandler,
    list: makeAgentListTool(registry).execute as unknown as ActionHandler,
    messages: makeAgentMessagesTool(pi, registry).execute as unknown as ActionHandler,
    cancel: makeAgentCancelTool(registry, deps.stopAgent, deps.disposeIdle).execute as unknown as ActionHandler,
  };
  const orch = deps.orchestrator;
  const handlers: Partial<Record<AgentControlAction, ActionHandler>> = {
    ...builtin,
    ...(orch
      ? {
          wait: waitAction(registry, orch),
          reply: replyAction(orch),
          steer: steerAction(registry, orch, deps.isForeground),
        }
      : {}),
  };

  return defineTool({
    name: AGENT_CONTROL_TOOL_NAME,
    label: AGENT_CONTROL_TOOL_NAME,
    description: DESCRIPTION,
    parameters: Type.Object({
      action: Type.Union(
        AGENT_CONTROL_ACTIONS.map((a) => Type.Literal(a)),
        { description: "Which operation to run." },
      ),
      ids: Type.Optional(
        Type.Union([Type.Array(Type.String()), Type.Literal("all")], {
          description: 'status/cancel/wait/steer: background ids (bg-…, agentId or unique prefix); cancel also accepts "all".',
        }),
      ),
      id: Type.Optional(Type.String({ description: "messages/reply/steer: one background id." })),
      wait: Type.Optional(
        Type.Union([Type.Literal("none"), Type.Literal("any"), Type.Literal("all")], {
          description: "status: block until any/all finished their current run.",
        }),
      ),
      timeout_s: Type.Optional(Type.Number({ description: "status/wait: max seconds to block (default 300); never cancels." })),
      status: Type.Optional(
        Type.Union([Type.Literal("queued"), Type.Literal("running"), Type.Literal("idle")], {
          description: "cancel: only subagents in this state.",
        }),
      ),
      from: Type.Optional(Type.Number({ description: "messages: 0-based entry index to start from." })),
      limit: Type.Optional(Type.Number({ description: "messages: max entries (default 20)." })),
      kinds: Type.Optional(Type.Array(Type.String(), { description: "messages: entry kinds to include." })),
      question_id: Type.Optional(Type.String({ description: "reply: the question being answered." })),
      answer: Type.Optional(Type.String({ description: "reply: the answer text." })),
      replies: Type.Optional(
        Type.Array(
          Type.Object({ id: Type.String(), question_id: Type.String(), answer: Type.String() }),
          { description: "reply: several answers at once." },
        ),
      ),
      message: Type.Optional(Type.String({ description: "steer: the instruction to deliver." })),
      mode: Type.Optional(
        Type.Union([Type.Literal("steer"), Type.Literal("followUp")], {
          description: "steer: steer = after the current turn (default); followUp = when the run has no more tool calls.",
        }),
      ),
    }),

    async execute(
      toolCallId: string,
      rawParams: Record<string, unknown>,
      signal: AbortSignal | undefined,
      onUpdate: AgentToolUpdateCallback<unknown> | undefined,
      ctx: ExtensionContext,
    ): Promise<ToolResult> {
      const { action, ...params } = rawParams as { action?: unknown } & Record<string, unknown>;
      const valid = AGENT_CONTROL_ACTIONS.join(", ");
      if (typeof action !== "string" || !(AGENT_CONTROL_ACTIONS as readonly string[]).includes(action)) {
        return errorResult(`Unknown AgentControl action ${JSON.stringify(action)}. Valid actions: ${valid}.`, {
          action,
          valid: AGENT_CONTROL_ACTIONS,
        });
      }
      const act = action as AgentControlAction;
      const missing = missingParams(act, params);
      if (missing.length > 0) {
        return errorResult(`AgentControl ${act}: missing ${missing.join(", ")}.`, { action: act, missing });
      }
      const handler = handlers[act];
      if (!handler) return errorResult(`AgentControl ${act} is not available in this session.`, { action: act });
      return handler(toolCallId, params, signal, onUpdate, ctx);
    },
  });
}
