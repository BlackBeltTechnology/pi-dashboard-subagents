/**
 * Unit tests for the per-activation orchestrator: idle pool (TTL + cap),
 * mailbox, asks, AgentWait, push. See change: add-subagent-orchestration.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createBackgroundRegistry } from "../background.js";
import { createOrchestrator } from "../orchestration.js";

function setup(over: Partial<Parameters<typeof createOrchestrator>[0]> = {}) {
  const emitted: Array<{ channel: string; data: any }> = [];
  const pi: any = {
    events: { emit: (channel: string, data: any) => emitted.push({ channel, data }) },
    sendMessage: vi.fn(),
    appendEntry: vi.fn(),
  };
  const registry = createBackgroundRegistry();
  const settings = { idleTtlSec: 600, maxIdle: 4, notifyParent: true };
  const orch = createOrchestrator({
    pi,
    registry,
    idleTtlSec: () => settings.idleTtlSec,
    maxIdle: () => settings.maxIdle,
    notifyParent: () => settings.notifyParent,
    ...over,
  });
  const of = (ch: string) => emitted.filter((e) => e.channel === ch).map((e) => e.data);
  let n = 0;
  /** A record finished run 1 and parked idle with a fake handle. */
  const idleAgent = () => {
    const r = registry.create({ agentId: `agent-${++n}`, subagentType: "t", description: "d" });
    registry.markRunning(r);
    const handle = {
      continueWith: vi.fn(() => "started" as const),
      dispose: vi.fn((reason: string) => orch.idleDisposed(r, reason as any)),
    };
    const res = { content: [{ type: "text", text: `result ${n}` }], details: { status: "completed" as const } };
    orch.runEnded(r, res, handle);
    return { r, handle };
  };
  return { pi, registry, orch, settings, emitted, of, idleAgent };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("idle pool", () => {
  it("runEnded with a handle stores the run idle and emits subagents:idle", () => {
    const { idleAgent, of } = setup();
    const { r } = idleAgent();
    expect(r.status).toBe("idle");
    expect(of("subagents:idle")).toEqual([{ id: r.id, agentId: r.agentId, run: 1 }]);
  });

  it("TTL disposes an idle subagent with reason ttl", () => {
    const { idleAgent, of, settings } = setup();
    settings.idleTtlSec = 10;
    const { r, handle } = idleAgent();
    vi.advanceTimersByTime(9_999);
    expect(handle.dispose).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(handle.dispose).toHaveBeenCalledWith("ttl");
    expect(r.status).toBe("completed");
    expect(of("subagents:disposed")).toEqual([{ id: r.id, agentId: r.agentId, reason: "ttl" }]);
  });

  it("the idle cap evicts the oldest with reason cap", () => {
    const { idleAgent, settings, of } = setup();
    settings.maxIdle = 2;
    const a = idleAgent();
    vi.advanceTimersByTime(1);
    const b = idleAgent();
    vi.advanceTimersByTime(1);
    const c = idleAgent();
    expect(a.handle.dispose).toHaveBeenCalledWith("cap");
    expect(b.handle.dispose).not.toHaveBeenCalled();
    expect(c.r.status).toBe("idle");
    expect(of("subagents:disposed").map((d) => d.reason)).toEqual(["cap"]);
  });

  it("dispose(record, reason) frees through the handle; unknown → false", () => {
    const { idleAgent, orch, registry } = setup();
    const { r, handle } = idleAgent();
    expect(orch.dispose(r, "cancel")).toBe(true);
    expect(handle.dispose).toHaveBeenCalledWith("cancel");
    expect(orch.dispose(r, "cancel")).toBe(false);
    const other = registry.create({ agentId: "x", subagentType: "t", description: "d" });
    expect(orch.dispose(other, "cancel")).toBe(false);
  });

  it("continueRun starts run 2, clears the TTL timer, and reports started/queued", () => {
    const { idleAgent, orch, settings } = setup();
    settings.idleTtlSec = 10;
    const { r, handle } = idleAgent();
    expect(orch.continueRun(r, "next")).toBe("started");
    expect(handle.continueWith).toHaveBeenCalledWith("next");
    expect(r.run).toBe(2);
    expect(r.status).toBe("running");
    vi.advanceTimersByTime(60_000);
    expect(handle.dispose).not.toHaveBeenCalled();
    handle.continueWith.mockReturnValueOnce("queued" as any);
  });

  it("continueRun on a non-idle record returns undefined", () => {
    const { orch, registry } = setup();
    const r = registry.create({ agentId: "x", subagentType: "t", description: "d" });
    expect(orch.continueRun(r, "m")).toBeUndefined();
  });

  it("disposeAll(shutdown) frees every idle subagent", () => {
    const { idleAgent, orch } = setup();
    const a = idleAgent();
    const b = idleAgent();
    orch.disposeAll("shutdown");
    expect(a.handle.dispose).toHaveBeenCalledWith("shutdown");
    expect(b.handle.dispose).toHaveBeenCalledWith("shutdown");
  });

  it("runEnded without a handle stores a terminal result (no idle event)", () => {
    const { orch, registry, of } = setup();
    const r = registry.create({ agentId: "x", subagentType: "t", description: "d" });
    registry.markRunning(r);
    orch.runEnded(r, { content: [{ type: "text", text: "ok" }], details: { status: "completed" } });
    expect(r.status).toBe("completed");
    expect(of("subagents:idle")).toEqual([]);
  });
});

// ── 6. Mailbox, wait, push ──────────────────────────────────────────────────

describe("mailbox + outcomes", () => {
  it("every run end posts one outcome entry (done / failed / stopped) with a bounded summary", () => {
    const { orch, registry, of } = setup();
    const mk = () => {
      const r = registry.create({ agentId: `a${Math.random()}`, subagentType: "t", description: "d", cwd: "/w" });
      registry.markRunning(r);
      return r;
    };
    const a = mk();
    orch.runEnded(a, { content: [{ type: "text", text: "x".repeat(900) }], details: { status: "completed" } });
    const b = mk();
    orch.runEnded(b, { content: [{ type: "text", text: "boom" }], details: { status: "error" }, isError: true });
    const c = mk();
    orch.runEnded(c, { content: [{ type: "text", text: "halt" }], details: { status: "stopped" } });
    const entries = orch.pending();
    expect(entries.map((e) => [e.id, e.kind, e.outcome])).toEqual([
      [a.id, "outcome", "done"],
      [b.id, "outcome", "failed"],
      [c.id, "outcome", "stopped"],
    ]);
    expect(entries[0]!.text.length).toBeLessThanOrEqual(500);
    expect(entries[0]!).toMatchObject({ run: 1, cwd: "/w" });
    expect(of("subagents:mail").map((m) => m.kind)).toEqual(["outcome", "outcome", "outcome"]);
    expect(JSON.stringify(of("subagents:mail"))).not.toContain("boom");
  });

  it("overflow drops the oldest outcome, never a question", () => {
    const { orch, registry, of } = setup({ notifyParent: () => false, maxMailbox: 3 });
    const r = registry.create({ agentId: "q", subagentType: "t", description: "d" });
    registry.markRunning(r);
    orch.ask(r, "keep me?");
    for (let i = 0; i < 3; i++) {
      const o = registry.create({ agentId: `o${i}`, subagentType: "t", description: "d" });
      registry.markRunning(o);
      orch.runEnded(o, { content: [{ type: "text", text: `r${i}` }], details: { status: "completed" } });
    }
    const kinds = orch.pending().map((e) => e.kind);
    expect(kinds).toEqual(["question", "outcome", "outcome"]);
    expect(of("subagents:mail_dropped")).toHaveLength(1);
  });
});

describe("wait", () => {
  const post = (s: ReturnType<typeof setup>, text = "ok") => {
    const r = s.registry.create({ agentId: `a${Math.random()}`, subagentType: "t", description: "d" });
    s.registry.markRunning(r);
    s.orch.runEnded(r, { content: [{ type: "text", text }], details: { status: "completed" } });
    return r;
  };

  it("returns all pending entries immediately and marks them delivered", async () => {
    const s = setup({ notifyParent: () => false });
    post(s);
    post(s);
    const res = await s.orch.wait({});
    expect(res.entries).toHaveLength(2);
    expect(s.orch.pending()).toEqual([]);
    const again = s.orch.wait({ timeoutMs: 1000 });
    vi.advanceTimersByTime(1000);
    expect((await again).entries).toEqual([]);
    expect((await again).timedOut).toBe(true);
  });

  it("wakes on a new entry after a short coalescing window and batches late arrivals", async () => {
    const s = setup({ notifyParent: () => false });
    const p = s.orch.wait({});
    post(s);
    vi.advanceTimersByTime(100);
    post(s);
    vi.advanceTimersByTime(250);
    expect((await p).entries).toHaveLength(2);
  });

  it("filters by ids and leaves other entries pending", async () => {
    const s = setup({ notifyParent: () => false });
    const a = post(s);
    post(s);
    const res = await s.orch.wait({ ids: [a.id] });
    expect(res.entries.map((e) => e.id)).toEqual([a.id]);
    expect(s.orch.pending()).toHaveLength(1);
  });

  it("defaults to a 300 s timeout and never cancels anything", async () => {
    const s = setup({ notifyParent: () => false });
    const p = s.orch.wait({});
    vi.advanceTimersByTime(299_999);
    let done = false;
    void p.then(() => (done = true));
    await Promise.resolve();
    expect(done).toBe(false);
    vi.advanceTimersByTime(1);
    expect((await p).timedOut).toBe(true);
  });

  it("abort ends only the wait; a second concurrent wait is rejected", async () => {
    const s = setup({ notifyParent: () => false });
    const ac = new AbortController();
    const p = s.orch.wait({ signal: ac.signal });
    await expect(s.orch.wait({})).rejects.toThrow(/wait_in_progress/);
    ac.abort();
    expect((await p).interrupted).toBe(true);
    const next = s.orch.wait({ timeoutMs: 1 }).catch((e) => e);
    vi.advanceTimersByTime(1);
    expect(await next).not.toBeInstanceOf(Error); // the slot was freed by the abort
  });

  it("emits subagents:wait start/end with returned count", async () => {
    const s = setup({ notifyParent: () => false });
    post(s);
    await s.orch.wait({});
    expect(s.of("subagents:wait")).toEqual([
      { phase: "start" },
      { phase: "end", returned: 1, timedOut: false },
    ]);
  });
});

describe("push", () => {
  const post = (s: ReturnType<typeof setup>, text = "ok") => {
    const r = s.registry.create({ agentId: `a${Math.random()}`, subagentType: "t", description: "d" });
    s.registry.markRunning(r);
    s.orch.runEnded(r, { content: [{ type: "text", text }], details: { status: "completed" } });
    return r;
  };

  it("batches entries for ~1 s into ONE followUp that triggers a turn when idle", () => {
    const s = setup();
    post(s, "first");
    post(s, "second");
    expect(s.pi.sendMessage).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1000);
    expect(s.pi.sendMessage).toHaveBeenCalledTimes(1);
    const [msg, opts] = s.pi.sendMessage.mock.calls[0];
    expect(msg.customType).toBe("subagents:mail");
    expect(msg.content).toContain("first");
    expect(msg.content).toContain("second");
    expect(opts).toEqual({ deliverAs: "followUp", triggerTurn: true });
    expect(s.orch.pending()).toEqual([]);
    expect(s.of("subagents:push")).toEqual([expect.objectContaining({ count: 2, triggerTurn: true })]);
  });

  it("no push while a wait is active; leftovers flush after the wait ends", async () => {
    const s = setup();
    const a = post(s);
    const p = s.orch.wait({ ids: ["nobody"], timeoutMs: 5_000 });
    vi.advanceTimersByTime(2_000);
    expect(s.pi.sendMessage).not.toHaveBeenCalled();
    vi.advanceTimersByTime(3_000);
    await p;
    vi.advanceTimersByTime(1_000);
    expect(s.pi.sendMessage).toHaveBeenCalledTimes(1);
    expect(s.pi.sendMessage.mock.calls[0][0].content).toContain(a.id);
  });

  it("pushed entries are never returned by a later wait", async () => {
    const s = setup();
    post(s);
    vi.advanceTimersByTime(1000);
    const p = s.orch.wait({ timeoutMs: 10 });
    vi.advanceTimersByTime(10);
    expect((await p).entries).toEqual([]);
  });

  it("notifyParent false → nothing is ever sent", () => {
    const s = setup();
    s.settings.notifyParent = false;
    post(s);
    vi.advanceTimersByTime(5_000);
    expect(s.pi.sendMessage).not.toHaveBeenCalled();
    expect(s.pi.sendUserMessage).toBeUndefined();
  });

  it("shutdown cancels a pending push", () => {
    const s = setup();
    post(s);
    s.orch.shutdown();
    vi.advanceTimersByTime(5_000);
    expect(s.pi.sendMessage).not.toHaveBeenCalled();
  });
});

// ── 7. asks + reply instructions ────────────────────────────────────────────

describe("asks", () => {
  const running = (s: ReturnType<typeof setup>) => {
    const r = s.registry.create({ agentId: `a${Math.random()}`, subagentType: "t", description: "d", cwd: "/w" });
    s.registry.markRunning(r);
    return r;
  };

  it("ask posts a question entry + sets record.asking; reply resolves the promise", async () => {
    const s = setup({ notifyParent: () => false });
    const r = running(s);
    const { questionId, answer } = s.orch.ask(r, "JWT or cookie?");
    expect(r.asking).toMatchObject({ questionId, question: "JWT or cookie?" });
    const [e] = s.orch.pending();
    expect(e).toMatchObject({ kind: "question", questionId, id: r.id });
    expect(s.orch.reply(r.id, questionId, "JWT")).toBe("answered");
    await expect(answer).resolves.toBe("JWT");
    expect(r.asking).toBeUndefined();
    expect(s.orch.reply(r.id, questionId, "again")).toBe("not_pending");
    expect(s.of("subagents:question")).toEqual([{ id: r.id, agentId: r.agentId, question_id: questionId, run: 1 }]);
    expect(s.of("subagents:answer")).toEqual([{ id: r.id, agentId: r.agentId, question_id: questionId, via: "reply" }]);
    expect(JSON.stringify(s.emitted)).not.toContain("JWT");
  });

  it("no ask timeout: a reply an hour later still delivers", async () => {
    const s = setup({ notifyParent: () => false });
    const r = running(s);
    const { questionId, answer } = s.orch.ask(r, "q?");
    vi.advanceTimersByTime(3_600_000);
    expect(s.orch.reply(r.id, questionId, "late")).toBe("answered");
    await expect(answer).resolves.toBe("late");
  });

  it("cancelAsks rejects the pending ask with via cancel", async () => {
    const s = setup({ notifyParent: () => false });
    const r = running(s);
    const { answer } = s.orch.ask(r, "q?");
    s.orch.cancelAsks(r);
    await expect(answer).rejects.toThrow(/cancel/);
    expect(s.of("subagents:answer")[0].via).toBe("cancel");
    expect(r.asking).toBeUndefined();
  });

  it("reply on unknown ids", () => {
    const s = setup();
    expect(s.orch.reply("bg-none", "q1", "x")).toBe("not_found");
    const r = running(s);
    expect(s.orch.reply(r.id, "q-unknown", "x")).toBe("not_pending");
  });

  it("question render: full form with BLOCKED + exact reply call; batch hint when several", () => {
    const s = setup({ notifyParent: () => false });
    const a = running(s);
    const b = running(s);
    const qa = s.orch.ask(a, "JWT or session cookie?").questionId;
    s.orch.ask(b, "keep old API?");
    const text = s.orch.render(s.orch.pending());
    expect(text).toContain(`${a.id} is BLOCKED until you answer`);
    expect(text).toContain("JWT or session cookie?");
    expect(text).toContain(`AgentControl({ action: "reply", id: "${a.id}", question_id: "${qa}"`);
    expect(text).toContain("cwd /w");
    expect(text).toMatch(/answer all at once: AgentControl\(\{ action: "reply", replies:/);
  });

  it("short ask form is cut to 120 chars and names the reply", () => {
    const s = setup({ notifyParent: () => false });
    const a = running(s);
    const q = s.orch.ask(a, "x".repeat(300)).questionId;
    const line = s.orch.askLine(a)!;
    expect(line).toContain(`asking ${q}`);
    expect(line).toContain(`AgentControl(reply ${a.id} ${q})`);
    expect(line.length).toBeLessThan(260);
  });
});
