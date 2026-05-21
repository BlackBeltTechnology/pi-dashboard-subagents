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
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";

import { Type } from "@sinclair/typebox";

import {
  type AgentSessionEvent,
  type AgentToolResult,
  type AgentToolUpdateCallback,
  createAgentSession,
  defineTool,
  type ExtensionAPI,
  type ExtensionContext,
  getAgentDir,
  SessionManager,
} from "@mariozechner/pi-coding-agent";

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

// ─── Throttling window for progress emissions ────────────────────────────

const PROGRESS_THROTTLE_MS = 250; // → max 4 emissions/sec/subagent (§3.5)

// ─── Helpers ─────────────────────────────────────────────────────────────

/**
 * Resolve the absolute path to an agent's `.md` definition file.
 *
 * Lookup order (project-local wins):
 *   1. `<cwd>/.pi/agents/<type>.md`
 *   2. `<getAgentDir()>/agents/<type>.md`
 *
 * Returns `undefined` for built-in / anonymous agents.
 */
export function resolveAgentMdPath(agentType: string, cwd: string): string | undefined {
  // Defensive: reject path-traversal in the type name. The LLM controls
  // this string; we never want it to escape the agents directory.
  if (!agentType || agentType.includes("/") || agentType.includes("\\") || agentType.includes("..")) {
    return undefined;
  }
  const projectPath = resolve(cwd, ".pi", "agents", `${agentType}.md`);
  if (existsSync(projectPath)) return projectPath;
  try {
    const globalDir = getAgentDir();
    const globalPath = join(globalDir, "agents", `${agentType}.md`);
    if (existsSync(globalPath)) return globalPath;
  } catch {
    // getAgentDir may throw in unusual contexts; treat as no global path.
  }
  return undefined;
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
        "Agent type (e.g. 'Explore', 'reviewer'). Resolved against ./.pi/agents/<type>.md or ~/.pi/agent/agents/<type>.md.",
    }),
    description: Type.String({
      description: "Short human-readable description of the task (5–10 words).",
    }),
    prompt: Type.String({
      description: "The full task prompt for the subagent.",
    }),
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
  isolated?: boolean;
}

function makeAgentTool(exposeIsolated: boolean) {
  return defineTool({
    name: AGENT_TOOL_NAME,
    label: "Agent",
    description: [
      "Spawn a foreground subagent in-memory with a focused task.",
      "Runs synchronously; returns when the subagent finishes.",
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
  const agentMdPath = resolveAgentMdPath(args.subagent_type, cwd);

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
      displayName: args.subagent_type,
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
    // ── Build effective prompt with optional parent-context prefix ──
    const isolated = resolveIsolated(args.isolated);
    const inheritanceOpts = isolated
      ? { isolated: true as const }
      : { isolated: false as const, ...getInheritanceCompression() };
    const inherited = buildInheritedContext(ctx, inheritanceOpts);
    const effectivePrompt = inherited
      ? `${inherited}\n\n<task>\n${args.prompt}\n</task>`
      : args.prompt;

    // ── Construct in-memory subagent session ──
    const sessionManager = SessionManager.inMemory(cwd);
    const createResult = await createAgentSession({
      cwd,
      sessionManager,
    });
    session = createResult.session;
    modelName = session.model?.id;

    // ── Exclude the Agent tool from the subagent to prevent recursion ──
    const activeTools = session.getActiveToolNames().filter((n) => n !== AGENT_TOOL_NAME);
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
}
