/**
 * Background registry (change: add-background-subagents, task 3.1).
 */
import { describe, expect, it } from "vitest";

import { createBackgroundRegistry, isTerminalStatus } from "../background.js";

const init = (agentId: string) => ({ agentId, subagentType: "t", description: "d" });

function seqHex(...values: string[]) {
  let i = 0;
  return () => values[Math.min(i++, values.length - 1)]!;
}

describe("short ids", () => {
  it("are bg- plus 6 hex characters", () => {
    const reg = createBackgroundRegistry();
    for (let i = 0; i < 20; i++) expect(reg.create(init(`agent-${i}`)).id).toMatch(/^bg-[0-9a-f]{6}$/);
  });

  it("are collision-checked", () => {
    const reg = createBackgroundRegistry({ randomHex: seqHex("aaaaaa", "aaaaaa", "aaaaaa", "bbbbbb") });
    const a = reg.create(init("x1"));
    const b = reg.create(init("x2"));
    expect(a.id).toBe("bg-aaaaaa");
    expect(b.id).toBe("bg-bbbbbb");
  });

  it("widen instead of looping forever when the source keeps colliding", () => {
    const reg = createBackgroundRegistry({ randomHex: () => "cccccc" });
    const a = reg.create(init("x1"));
    const b = reg.create(init("x2"));
    expect(a.id).toBe("bg-cccccc");
    expect(b.id).toMatch(/^bg-[0-9a-f]{12}$/);
  });
});

describe("lookup", () => {
  const reg = createBackgroundRegistry({ randomHex: seqHex("abc123", "abd456") });
  const a = reg.create(init("11111111-aaaa"));
  const b = reg.create(init("22222222-bbbb"));

  it("by short id and by full agentId", () => {
    expect(reg.lookup("bg-abc123")).toBe(a);
    expect(reg.lookup("22222222-bbbb")).toBe(b);
  });

  it("by unique prefix of either", () => {
    expect(reg.lookup("bg-abc")).toBe(a);
    expect(reg.lookup("2222")).toBe(b);
  });

  it("reports ambiguous and not_found", () => {
    expect(reg.lookup("bg-ab")).toBe("ambiguous");
    expect(reg.lookup("bg-zzz")).toBe("not_found");
    expect(reg.lookup("")).toBe("not_found");
    expect(reg.lookup(undefined as unknown as string)).toBe("not_found");
  });
});

describe("status transitions from the onUpdate sink", () => {
  it("queued → running → terminal; finish stores the result once", () => {
    let t = 1_000;
    const reg = createBackgroundRegistry({ now: () => t });
    const r = reg.create(init("a"));
    const sink = reg.sink(r);
    expect(r.status).toBe("queued");
    sink({ details: { status: "queued", queuePosition: 2 } as any });
    expect(r.status).toBe("queued");
    sink({ details: { status: "running", activity: "thinking" } as any });
    expect(r.status).toBe("running");
    expect(r.latest?.activity).toBe("thinking");

    // A terminal onUpdate alone does not store a result (no text yet).
    sink({ details: { status: "completed" } as any });
    expect(r.result).toBeUndefined();
    expect(r.status).toBe("running");

    t = 4_000;
    reg.finish(r, {
      content: [{ type: "text", text: "done" }],
      details: { agentId: "a", status: "completed", durationMs: 3_000, tokensUsage: { input: 1, output: 2, total: 3 } },
    });
    expect(r.status).toBe("completed");
    expect(r.result).toMatchObject({ status: "completed", result: "done", isError: false, durationMs: 3_000, finishedAt: 4_000 });
    expect(r.result!.tokens).toEqual({ input: 1, output: 2, total: 3 });

    reg.finish(r, { content: [{ type: "text", text: "second" }], details: { status: "error" }, isError: true });
    expect(r.result!.result).toBe("done");
    sink({ details: { status: "running" } as any });
    expect(r.status).toBe("completed");
  });

  it("stores failures and stops with their reason and source", () => {
    const reg = createBackgroundRegistry();
    const e = reg.create(init("e"));
    reg.finish(e, { content: [{ type: "text", text: "Subagent failed: boom" }], details: { status: "error", error: "boom" }, isError: true });
    expect(e.result).toMatchObject({ status: "error", error: "boom", isError: true });

    const s = reg.create(init("s"));
    s.stoppedBy = "tool";
    reg.finish(s, { content: [{ type: "text", text: "Subagent stopped by user." }], details: { status: "stopped", stopReason: "running" } });
    expect(s.result).toMatchObject({ status: "stopped", stopReason: "running", stoppedBy: "tool", isError: false });
  });

  it("isTerminalStatus", () => {
    expect(["completed", "aborted", "stopped", "error"].every((s) => isTerminalStatus(s as any))).toBe(true);
    expect(["queued", "running"].some((s) => isTerminalStatus(s as any))).toBe(false);
  });
});

describe("entries", () => {
  it("are cut with the configured field cut as they are appended", () => {
    const reg = createBackgroundRegistry({
      cutEntry: (e) => (e.kind === "tool" ? e : { ...e, text: e.text.slice(0, 3) }),
    });
    const r = reg.create(init("a"));
    reg.appendEntry(r, { kind: "text", text: "abcdefgh", ts: 1 });
    reg.appendEntry(r, { kind: "thinking", text: "xy", ts: 2 });
    expect(r.entries).toEqual([
      { kind: "text", text: "abc", ts: 1 },
      { kind: "thinking", text: "xy", ts: 2 },
    ]);
  });
});

describe("readAt and counts", () => {
  it("tracks the first read and counts running / queued / finished-unread", () => {
    let t = 0;
    const reg = createBackgroundRegistry({ now: () => t });
    const running = reg.create(init("r"));
    reg.markRunning(running);
    reg.create(init("q"));
    const done = reg.create(init("d"));
    reg.finish(done, { content: [{ type: "text", text: "ok" }], details: { status: "completed" } });
    expect(reg.counts()).toEqual({ running: 1, queued: 1, finishedUnread: 1 });
    expect(reg.outstanding().map((r) => r.agentId)).toEqual(["r", "q"]);

    // Reading a non-terminal record does not mark it.
    reg.markRead(running);
    expect(running.readAt).toBeUndefined();

    t = 50;
    reg.markRead(done);
    t = 90;
    reg.markRead(done);
    expect(done.readAt).toBe(50);
    expect(reg.counts()).toEqual({ running: 1, queued: 1, finishedUnread: 0 });
  });
});

describe("change notifications", () => {
  it("fire on create, status change, finish and first read; a throwing listener is isolated", () => {
    const reg = createBackgroundRegistry();
    const seen: string[] = [];
    reg.subscribe(() => {
      throw new Error("bad listener");
    });
    const off = reg.subscribe((r) => seen.push(r.status));
    const r = reg.create(init("a"));
    reg.markRunning(r);
    reg.finish(r, { content: [], details: { status: "completed" } });
    reg.markRead(r);
    off();
    reg.create(init("b"));
    expect(seen).toEqual(["queued", "running", "completed", "completed"]);
  });
});

describe("isolation", () => {
  it("two registries never see each other's records", () => {
    const a = createBackgroundRegistry({ randomHex: () => "111111" });
    const b = createBackgroundRegistry({ randomHex: () => "111111" });
    const ra = a.create(init("shared-agent"));
    expect(b.lookup(ra.id)).toBe("not_found");
    expect(b.list()).toHaveLength(0);
    expect(b.create(init("other")).id).toBe("bg-111111");
  });
});
