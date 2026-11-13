/**
 * AgentControl: unified `wait`, live progress, progress lines on returns.
 * See change: agent-control-unified-wait.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { makeAgentControlTool } from "../agent-control.js";
import { progressLine } from "../background-tools.js";
import { createBackgroundRegistry } from "../background.js";
import { createOrchestrator } from "../orchestration.js";

function setup() {
  const emitted: Array<{ channel: string; data: any }> = [];
  const pi: any = {
    events: { emit: (channel: string, data: any) => emitted.push({ channel, data }) },
    sendMessage: vi.fn(),
    appendEntry: vi.fn(),
  };
  const registry = createBackgroundRegistry();
  const orch = createOrchestrator({ pi, registry, idleTtlSec: () => 600, maxIdle: () => 4, notifyParent: () => false });
  const tool = makeAgentControlTool({ pi, registry, orchestrator: orch, stopAgent: () => true });
  const run = (params: Record<string, unknown>, onUpdate?: (u: any) => void, signal?: AbortSignal) =>
    tool.execute("call", params, signal, onUpdate as any, {} as any);
  const live = (tokens = "1.2k", turnCount = 3, cwd?: string) => {
    const r = registry.create({
      agentId: `a${Math.random()}`,
      subagentType: "worker",
      description: "do it",
      ...(cwd ? { cwd } : {}),
    });
    registry.markRunning(r);
    registry.sink(r)({ details: { status: "running", tokens, turnCount, activity: "reading" } as any });
    return r;
  };
  const of = (ch: string) => emitted.filter((e) => e.channel === ch).map((e) => e.data);
  return { registry, orch, run, live, of };
}

const text = (res: { content: Array<{ type: string; text?: string }> }) => res.content.map((c) => c.text ?? "").join("\n");

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("progressLine", () => {
  it("shows id, status, run, turn, activity, tokens, cwd and the last text tail while running", () => {
    const { registry, live } = setup();
    const r = live("1.2k", 3, "/repo/wt");
    registry.appendEntry(r, { kind: "text", text: `start ${"y".repeat(400)}\n  the   end`, ts: 1 });
    const line = progressLine(r);
    expect(line).toMatch(new RegExp(`^${r.id}: running`));
    expect(line).toContain("run 1");
    expect(line).toContain("turn 3");
    expect(line).toContain("▸ reading");
    expect(line).toContain("1.2k tokens");
    expect(line).toContain("cwd /repo/wt");
    expect(line).toContain("y the end");
    expect(line).not.toContain("start");
    const tail = /“(.*)”/.exec(line)![1]!;
    expect(tail.length).toBeLessThanOrEqual(200);
  });

  it("omits the last text once finished", () => {
    const { registry, orch, live } = setup();
    const r = live();
    registry.appendEntry(r, { kind: "text", text: "thinking aloud", ts: 1 });
    orch.runEnded(r, { content: [{ type: "text", text: "done" }], details: { status: "completed" } });
    expect(progressLine(r)).not.toContain("thinking aloud");
  });

  it("shows the short ask form while asking", () => {
    const { orch, live } = setup();
    const r = live();
    const { questionId } = orch.ask(r, "JWT?");
    expect(progressLine(r)).toContain(`asking ${questionId}`);
  });
});

describe("AgentControl surface", () => {
  it("unknown action lists the six actions", async () => {
    const { run } = setup();
    const res = await run({ action: "explode" });
    expect(res.isError).toBe(true);
    expect(text(res)).toContain("wait, list, messages, cancel, reply, steer");
  });

  it("former status action errors with the migration hint", async () => {
    const { run } = setup();
    const res = await run({ action: "status", ids: ["bg-a"] });
    expect(res.isError).toBe(true);
    expect(text(res)).toMatch(/until: "none"/);
  });
});

describe("AgentControl wait", () => {
  it("returns at once when nothing can be waited for", async () => {
    const { run } = setup();
    const res = await run({ action: "wait", timeout_s: 3000 });
    expect(text(res)).toMatch(/nothing to wait for/i);
  });

  it("unknown ids are reported not_found at once", async () => {
    const { run, live } = setup();
    live();
    const res = await run({ action: "wait", ids: ["bg-nope"] });
    expect(text(res)).toContain("bg-nope: not_found");
  });

  it("snapshot shows the progress line and an explicit id's stored result even when read", async () => {
    const { run, live, orch, registry } = setup();
    const r = live();
    expect(text(await run({ action: "wait", ids: [r.id], until: "none" }))).toMatch(/running.*1\.2k tokens/);
    orch.runEnded(r, { content: [{ type: "text", text: "the full result" }], details: { status: "completed" } });
    registry.markRead(r);
    expect(text(await run({ action: "wait", ids: [r.id], until: "none" }))).toContain("the full result");
  });

  it("returns per-child blocks with the full result and consumes it (via wait)", async () => {
    const { run, live, orch, of } = setup();
    const r = live();
    orch.runEnded(r, { content: [{ type: "text", text: "R".repeat(800) }], details: { status: "completed" } });
    const out = text(await run({ action: "wait" }));
    expect(out).toContain(`${r.id}: completed`);
    expect(out).toContain("R".repeat(800));
    expect(of("subagents:result_read")).toEqual([{ id: r.id, agentId: r.agentId, via: "wait" }]);
    expect(orch.pending()).toEqual([]);
  });

  it("a pending question returns its full reply form", async () => {
    const { run, live, orch } = setup();
    const r = live();
    const { questionId } = orch.ask(r, "JWT or cookie?");
    const out = text(await run({ action: "wait" }));
    expect(out).toContain(`${r.id} is BLOCKED until you answer`);
    expect(out).toContain(`question_id: "${questionId}"`);
  });

  it("clamps timeout_s to 600 and says so", async () => {
    const { run, live } = setup();
    live();
    const p = run({ action: "wait", timeout_s: 3000 });
    vi.advanceTimersByTime(600_000);
    const out = text(await p);
    expect(out).toMatch(/timeout_s clamped to 600/);
    expect(out).toMatch(/no news within 600s/);
  });

  it("streams per-child progress immediately and on change, throttled to ~1/s", async () => {
    const { run, live, registry } = setup();
    const r = live();
    const updates: string[] = [];
    const ac = new AbortController();
    const p = run({ action: "wait", timeout_s: 60 }, (u) => updates.push(text(u)), ac.signal);
    expect(updates).toHaveLength(1);
    expect(updates[0]).toMatch(new RegExp(`${r.id}: running.*turn 3.*reading.*1\\.2k tokens`));
    for (let i = 4; i < 24; i++) {
      registry.sink(r)({ details: { status: "running", tokens: "2.0k", turnCount: i, activity: "writing" } as any });
    }
    expect(updates.length).toBeLessThanOrEqual(2);
    vi.advanceTimersByTime(1000);
    expect(updates.at(-1)).toMatch(/turn 23.*writing.*2\.0k tokens/);
    expect(updates.length).toBeLessThanOrEqual(3);
    ac.abort();
    await p;
    const n = updates.length;
    registry.sink(r)({ details: { status: "running", tokens: "3.0k", turnCount: 30 } as any });
    vi.advanceTimersByTime(2000);
    expect(updates).toHaveLength(n); // no updates after the wait ended
  });
});

describe("AgentControl steer / reply / cancel carry progress lines", () => {
  it("cancel", async () => {
    const { run, live } = setup();
    const r = live();
    const out = text(await run({ action: "cancel", ids: [r.id] }));
    expect(out).toContain(`${r.id}: stopped`);
    expect(out).toMatch(/1\.2k tokens/);
  });

  it("steer", async () => {
    const { run, live } = setup();
    const r = live();
    expect(text(await run({ action: "steer", id: r.id, message: "go" }))).toMatch(/1\.2k tokens/);
  });

  it("reply", async () => {
    const { run, live, orch } = setup();
    const r = live();
    const { questionId, answer } = orch.ask(r, "which?");
    expect(text(await run({ action: "reply", id: r.id, question_id: questionId, answer: "a" }))).toMatch(/1\.2k tokens/);
    await answer;
  });
});
