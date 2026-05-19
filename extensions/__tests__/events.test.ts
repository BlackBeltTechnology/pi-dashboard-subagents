/**
 * Tests for extensions/events.ts
 *
 * Covers tasks §2.8 + §9.6:
 *   - mapSessionEventToEntry returns null for uninteresting events
 *   - mapSessionEventToEntry maps each interesting kind correctly
 *   - createToolCallTracker pairs across nested concurrent calls
 *   - compressParentContext produces expected output for representative inputs
 *   - Emission helpers call pi.events.emit with the right channel + payload
 *   - buildInheritedContext reads via sessionManager.getBranch() (not getMessages)
 */

import { describe, expect, it, vi } from "vitest";

import {
  buildDetails,
  buildInheritedContext,
  compressParentContext,
  createToolCallTracker,
  DEFAULT_INHERITANCE,
  emitSubagentCompleted,
  emitSubagentCreated,
  emitSubagentFailed,
  emitSubagentProgress,
  emitSubagentStarted,
  formatTokens,
  mapSessionEventToEntry,
} from "../events.js";

// ── Fixtures ────────────────────────────────────────────────────────────

function fakePi() {
  const calls: Array<{ channel: string; data: any }> = [];
  return {
    pi: {
      events: {
        emit: (channel: string, data: any) => {
          calls.push({ channel, data });
        },
      },
    } as any,
    calls,
  };
}

function snapshot(overrides: Partial<Parameters<typeof buildDetails>[0]> = {}) {
  return buildDetails({
    agentId: "agent-1",
    displayName: "test",
    description: "test task",
    subagentType: "Test",
    status: "running",
    entries: [],
    toolUses: 0,
    tokensTotal: 0,
    startedAt: Date.now() - 100,
    ...overrides,
  });
}

// ── mapSessionEventToEntry ──────────────────────────────────────────────

describe("mapSessionEventToEntry", () => {
  it("returns null for uninteresting events", () => {
    expect(mapSessionEventToEntry({ type: "agent_start" } as any)).toBeNull();
    expect(mapSessionEventToEntry({ type: "turn_end" } as any)).toBeNull();
    expect(mapSessionEventToEntry({ type: "tool_execution_start", toolCallId: "x", toolName: "bash", args: {} } as any)).toBeNull();
    expect(
      mapSessionEventToEntry({
        type: "message_update",
        message: {} as any,
        assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "x", partial: {} } as any,
      } as any),
    ).toBeNull();
  });

  it("maps tool_execution_end to a tool entry with toolName + output + isError", () => {
    const entry = mapSessionEventToEntry({
      type: "tool_execution_end",
      toolCallId: "abc",
      toolName: "bash",
      result: "ok",
      isError: false,
    } as any);
    expect(entry?.kind).toBe("tool");
    if (entry?.kind === "tool") {
      expect(entry.toolName).toBe("bash");
      expect(entry.output).toBe("ok");
      expect(entry.isError).toBe(false);
      expect(typeof entry.ts).toBe("number");
    }
  });

  it("maps text_end to a text entry", () => {
    const entry = mapSessionEventToEntry({
      type: "message_update",
      message: {} as any,
      assistantMessageEvent: { type: "text_end", contentIndex: 0, content: "hello", partial: {} as any },
    } as any);
    expect(entry?.kind).toBe("text");
    if (entry?.kind === "text") expect(entry.text).toBe("hello");
  });

  it("maps thinking_end to a thinking entry", () => {
    const entry = mapSessionEventToEntry({
      type: "message_update",
      message: {} as any,
      assistantMessageEvent: { type: "thinking_end", contentIndex: 0, content: "hmm", partial: {} as any },
    } as any);
    expect(entry?.kind).toBe("thinking");
    if (entry?.kind === "thinking") expect(entry.text).toBe("hmm");
  });

  it("maps error to an error entry", () => {
    const entry = mapSessionEventToEntry({
      type: "message_update",
      message: {} as any,
      assistantMessageEvent: {
        type: "error",
        reason: "error",
        error: { content: "boom" } as any,
      },
    } as any);
    expect(entry?.kind).toBe("error");
    if (entry?.kind === "error") expect(entry.text).toBe("boom");
  });
});

// ── createToolCallTracker ───────────────────────────────────────────────

describe("createToolCallTracker", () => {
  it("pairs single start↔end correctly", () => {
    const t = createToolCallTracker();
    expect(t.onEvent({ type: "tool_execution_start", toolCallId: "a", toolName: "bash", args: { cmd: "ls" } } as any)).toBeNull();
    expect(t.onEvent({ type: "tool_execution_end", toolCallId: "a", toolName: "bash", result: "ok", isError: false } as any)).toEqual({
      input: { cmd: "ls" },
    });
  });

  it("pairs nested concurrent calls independently", () => {
    const t = createToolCallTracker();
    t.onEvent({ type: "tool_execution_start", toolCallId: "a", toolName: "bash", args: { cmd: "ls" } } as any);
    t.onEvent({ type: "tool_execution_start", toolCallId: "b", toolName: "read", args: { path: "/x" } } as any);
    const endB = t.onEvent({ type: "tool_execution_end", toolCallId: "b", toolName: "read", result: "content", isError: false } as any);
    const endA = t.onEvent({ type: "tool_execution_end", toolCallId: "a", toolName: "bash", result: "ok", isError: false } as any);
    expect(endB).toEqual({ input: { path: "/x" } });
    expect(endA).toEqual({ input: { cmd: "ls" } });
  });

  it("end-without-start returns input: undefined (defensive)", () => {
    const t = createToolCallTracker();
    expect(t.onEvent({ type: "tool_execution_end", toolCallId: "x", toolName: "y", result: "z", isError: false } as any)).toEqual({
      input: undefined,
    });
  });

  it("reset() clears pending", () => {
    const t = createToolCallTracker();
    t.onEvent({ type: "tool_execution_start", toolCallId: "a", toolName: "bash", args: { cmd: "ls" } } as any);
    t.reset();
    expect(t.onEvent({ type: "tool_execution_end", toolCallId: "a", toolName: "bash", result: "ok", isError: false } as any)).toEqual({
      input: undefined,
    });
  });
});

// ── compressParentContext ───────────────────────────────────────────────

describe("compressParentContext", () => {
  const opts = { ...DEFAULT_INHERITANCE };

  it("returns wrapped <parent-context> block for simple inputs", () => {
    const messages = [
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello" },
    ];
    const out = compressParentContext(messages, opts);
    expect(out.startsWith("<parent-context>")).toBe(true);
    expect(out.endsWith("</parent-context>")).toBe(true);
    expect(out).toContain("hi");
    expect(out).toContain("hello");
  });

  it("keeps last N turn pairs verbatim and drops older ones", () => {
    const messages: Array<{ role: string; content: unknown }> = [];
    for (let i = 0; i < 12; i++) {
      messages.push({ role: "user", content: `user-${i}` });
      messages.push({ role: "assistant", content: `asst-${i}` });
    }
    const out = compressParentContext(messages, { ...opts, recentTurns: 3 });
    // Last 3 turn pairs ⇒ user-9..11 / asst-9..11 visible; older ones gone.
    expect(out).toContain("user-11");
    expect(out).toContain("asst-9");
    expect(out).not.toContain("user-0");
    expect(out).not.toContain("user-5");
  });

  it("masks tool_result content past the tool-output window", () => {
    const messages = [
      {
        role: "assistant",
        content: [{ type: "tool_use", name: "bash" }, { type: "tool_result", content: "BIG OUTPUT" }],
      },
      { role: "user", content: "ok" },
      { role: "assistant", content: "done" },
      { role: "user", content: "more" },
      { role: "assistant", content: "final" },
    ];
    const out = compressParentContext(messages, { ...opts, recentTurns: 3, toolOutputWindow: 1 });
    // The early tool_result should be masked (window is 1 turn from end)
    expect(out).toContain("[…tool output omitted, see earlier message]");
    expect(out).not.toContain("BIG OUTPUT");
  });

  it("hard-caps at maxChars with middle truncation marker", () => {
    const big = "x".repeat(500_000);
    const messages = [{ role: "user", content: big }];
    const out = compressParentContext(messages, { ...opts, maxChars: 1000 });
    expect(out.length).toBeLessThanOrEqual(1100); // allow some marker overhead
    expect(out).toContain("[…middle omitted for length…]");
  });
});

// ── Emission helpers ────────────────────────────────────────────────────

describe("emit* helpers", () => {
  it("emitSubagentCreated fires on the right channel with the right payload", () => {
    const { pi, calls } = fakePi();
    const details = snapshot({ status: "queued" });
    emitSubagentCreated(pi, { agentId: "a1", type: "Test", description: "t", details });
    expect(calls).toHaveLength(1);
    expect(calls[0].channel).toBe("subagents:created");
    expect(calls[0].data.id).toBe("a1");
    expect(calls[0].data.type).toBe("Test");
    expect(calls[0].data.details).toBe(details);
  });

  it("emitSubagentStarted + emitSubagentProgress share the subagents:started channel", () => {
    const { pi, calls } = fakePi();
    emitSubagentStarted(pi, { agentId: "a1", type: "Test", description: "t", details: snapshot() });
    emitSubagentProgress(pi, { agentId: "a1", details: snapshot() });
    expect(calls).toHaveLength(2);
    expect(calls[0].channel).toBe("subagents:started");
    expect(calls[1].channel).toBe("subagents:started");
  });

  it("emitSubagentCompleted carries result, durationMs, tokens, toolUses", () => {
    const { pi, calls } = fakePi();
    emitSubagentCompleted(pi, {
      agentId: "a1",
      result: "done",
      durationMs: 1234,
      tokens: { input: 10, output: 5, total: 15 },
      toolUses: 3,
      details: snapshot({ status: "completed" }),
    });
    expect(calls[0].channel).toBe("subagents:completed");
    expect(calls[0].data.result).toBe("done");
    expect(calls[0].data.durationMs).toBe(1234);
    expect(calls[0].data.tokens).toEqual({ input: 10, output: 5, total: 15 });
    expect(calls[0].data.toolUses).toBe(3);
  });

  it("emitSubagentFailed carries error string", () => {
    const { pi, calls } = fakePi();
    emitSubagentFailed(pi, {
      agentId: "a1",
      error: "boom",
      durationMs: 100,
      toolUses: 2,
      details: snapshot({ status: "error" }),
    });
    expect(calls[0].channel).toBe("subagents:failed");
    expect(calls[0].data.error).toBe("boom");
  });

  it("emit helpers are silent no-ops when pi.events is undefined", () => {
    expect(() =>
      emitSubagentCreated({} as any, {
        agentId: "x",
        type: "y",
        description: "z",
        details: snapshot(),
      }),
    ).not.toThrow();
  });
});

// ── buildInheritedContext (the §9 fix) ──────────────────────────────────

describe("buildInheritedContext (uses getBranch, not getMessages)", () => {
  function fakeCtx(branchEntries: Array<{ type: string; message?: any }>): any {
    return {
      sessionManager: {
        getBranch: () => branchEntries,
        // Intentionally omit getMessages — the fix must not call it.
        getMessages: () => {
          throw new Error("getMessages() must not be called");
        },
      },
    };
  }

  it("returns empty string when isolated: true (does not touch sessionManager)", () => {
    let touched = false;
    const ctx = {
      sessionManager: {
        getBranch: () => {
          touched = true;
          return [];
        },
      },
    } as any;
    expect(buildInheritedContext(ctx, { isolated: true })).toBe("");
    expect(touched).toBe(false);
  });

  it("returns empty string when branch is empty", () => {
    expect(buildInheritedContext(fakeCtx([]), {})).toBe("");
  });

  it("returns empty string when sessionManager is missing", () => {
    expect(buildInheritedContext({ sessionManager: undefined } as any, {})).toBe("");
  });

  it("filters to type === 'message' entries and reverses leaf→root to chronological", () => {
    // getBranch returns leaf→root, so the array is [most recent, ..., oldest]
    const branch = [
      { type: "message", message: { role: "assistant", content: "final-assistant" } },
      { type: "message", message: { role: "user", content: "final-user" } },
      { type: "model_change", provider: "anthropic", modelId: "claude" },
      { type: "compaction", summary: "..." },
      { type: "message", message: { role: "assistant", content: "first-assistant" } },
      { type: "message", message: { role: "user", content: "first-user" } },
    ];
    const out = buildInheritedContext(fakeCtx(branch), {});
    expect(out).toContain("first-user");
    expect(out).toContain("final-user");

    // first-user must appear BEFORE final-user in the rendered output
    expect(out.indexOf("first-user")).toBeLessThan(out.indexOf("final-user"));
  });

  it("excludes non user/assistant messages (e.g. toolResult)", () => {
    const branch = [
      { type: "message", message: { role: "toolResult", content: "[tool result]" } },
      { type: "message", message: { role: "assistant", content: "hello" } },
      { type: "message", message: { role: "user", content: "hi" } },
    ];
    const out = buildInheritedContext(fakeCtx(branch), {});
    expect(out).toContain("hi");
    expect(out).toContain("hello");
    expect(out).not.toContain("[tool result]");
  });

  it("does not throw when getBranch is undefined (future SDK refactor safety)", () => {
    const ctx = { sessionManager: {} } as any;
    expect(() => buildInheritedContext(ctx, {})).not.toThrow();
    expect(buildInheritedContext(ctx, {})).toBe("");
  });
});

// ── formatTokens (sanity) ───────────────────────────────────────────────

describe("formatTokens", () => {
  it("formats sub-1k as integer", () => {
    expect(formatTokens(0)).toBe("0");
    expect(formatTokens(999)).toBe("999");
  });
  it("formats thousands with k suffix", () => {
    expect(formatTokens(12_345)).toBe("12.3k");
  });
  it("formats millions with M suffix", () => {
    expect(formatTokens(2_300_000)).toBe("2.3M");
  });
});
