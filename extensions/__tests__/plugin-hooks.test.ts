/**
 * Plugin hooks on pi.events: before_spawn, before_store, result_read,
 * the background flag, and the subagents:list / subagents:get query channels.
 * Own file so the process-wide semaphore state is isolated.
 *
 * See change: add-background-subagents (section 6).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import activate from "../agent.js";
import {
  getBackgroundAgent,
  listBackgroundAgents,
  onSubagentEvent,
  stopSubagent,
} from "../index.js";
import { invalidateSettingsCache } from "../settings.js";
import { createAgentSession } from "@earendil-works/pi-coding-agent";

let tmpAgentDir: string;
let tmpCwd: string;

vi.mock("@earendil-works/pi-coding-agent", () => ({
  getAgentDir: () => tmpAgentDir,
  defineTool: <T,>(t: T) => t,
  createAgentSession: vi.fn(),
  DefaultResourceLoader: class {
    reload = async () => {};
  },
  DefaultPackageManager: class {
    list() {
      return [];
    }
  },
  SettingsManager: { create: () => ({}) },
  SessionManager: { inMemory: vi.fn() },
  parseFrontmatter: () => ({ frontmatter: {}, body: "" }),
}));

beforeEach(() => {
  tmpAgentDir = mkdtempSync(join(tmpdir(), "pi-subagents-hooks-agentdir-"));
  tmpCwd = mkdtempSync(join(tmpdir(), "pi-subagents-hooks-cwd-"));
  invalidateSettingsCache();
  writeConfig({});
});

afterEach(() => {
  vi.restoreAllMocks();
  if (existsSync(tmpAgentDir)) rmSync(tmpAgentDir, { recursive: true, force: true });
  if (existsSync(tmpCwd)) rmSync(tmpCwd, { recursive: true, force: true });
});

type Emitted = { channel: string; data: any };

/** A shared bus, so several activations can be wired to the same one. */
function makeBus() {
  const emitted: Emitted[] = [];
  const handlers = new Map<string, Array<(d: unknown) => void>>();
  return {
    emitted,
    emit: vi.fn((channel: string, data: any) => {
      emitted.push({ channel, data });
      for (const h of [...(handlers.get(channel) ?? [])]) h(data);
    }),
    on: vi.fn((channel: string, h: (d: unknown) => void) => {
      handlers.set(channel, [...(handlers.get(channel) ?? []), h]);
      return () => handlers.set(channel, (handlers.get(channel) ?? []).filter((x) => x !== h));
    }),
  };
}

function fakePi(bus = makeBus()) {
  const tools: any[] = [];
  const pi: any = { events: bus, registerTool: (t: any) => tools.push(t), on: () => {} };
  // Old tool names map onto AgentControl actions (add-subagent-orchestration D0).
  const ACTIONS: Record<string, string> = { AgentStatus: "status", AgentMessages: "messages", AgentList: "list", AgentCancel: "cancel" };
  const tool = (n: string) => {
    const action = ACTIONS[n];
    if (!action) return tools.find((t) => t.name === n);
    const control = tools.find((t) => t.name === "AgentControl");
    return control && { name: n, execute: (id: string, p: any, ...rest: any[]) => control.execute(id, { action, ...p }, ...rest) };
  };
  return { pi, bus, emitted: bus.emitted, tool };
}

function installSessions() {
  const created: Array<{ session: any; finish(text?: string): void }> = [];
  (createAgentSession as any).mockReset();
  (createAgentSession as any).mockImplementation(async () => {
    let listener: ((e: any) => void) | undefined;
    let resolve: (() => void) | undefined;
    const session: any = {
      model: { id: "m" },
      getActiveToolNames: () => ["Read"],
      setActiveToolsByName: vi.fn(),
      subscribe: (fn: any) => ((listener = fn), () => (listener = undefined)),
      prompt: vi.fn((text: string) => new Promise<void>((res) => ((session.lastPrompt = text), (resolve = res)))),
      dispose: vi.fn(),
      abort: vi.fn(async () => {
        listener?.({ type: "message_end", message: { role: "assistant", stopReason: "aborted", content: [] } });
        resolve?.();
      }),
    };
    created.push({
      session,
      finish: (text = "done") => {
        listener?.({ type: "message_end", message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text }] } });
        resolve?.();
      },
    });
    return { session };
  });
  return created;
}

function writeConfig(patch: Record<string, unknown>): void {
  const dir = join(tmpAgentDir, "extensions", "pi-dashboard-subagents");
  mkdirSync(dir, { recursive: true });
  // This suite pins the pre-orchestration contract: a finished background run
  // is disposed at once and nothing is pushed (backgroundIdleTtlSec: 0, notifyParent: false). See change: add-subagent-orchestration.
  writeFileSync(join(dir, "config.json"), JSON.stringify({ backgroundIdleTtlSec: 0, notifyParent: false, ...patch }), "utf-8");
  invalidateSettingsCache();
}

async function tick(n = 40) {
  for (let i = 0; i < n; i++) await Promise.resolve();
}

const ctx = () => ({ cwd: tmpCwd }) as any;
const call = (tool: any, params: Record<string, unknown> = {}) =>
  tool.execute("tc", { subagent_type: "t", description: "d", prompt: "p", ...params }, undefined, undefined, ctx());
const of = (emitted: Emitted[], ch: string) => emitted.filter((e) => e.channel === ch).map((e) => e.data);

// ─── 6.1 before_spawn ────────────────────────────────────────────────────

describe("subagents:before_spawn", () => {
  it.each([false, true])("veto returns an error with the reason and creates nothing (background=%s)", async (bg) => {
    const created = installSessions();
    const { pi, bus, tool, emitted } = fakePi();
    activate(pi);
    const seen: any[] = [];
    bus.on("subagents:before_spawn", (p: any) => {
      seen.push({ ...p, args: { ...p.args } });
      p.veto = true;
      p.reason = "budget exceeded";
    });
    const res = await call(tool("Agent"), bg ? { run_in_background: true } : {});
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain("budget exceeded");
    expect(seen[0]).toMatchObject({ background: bg, args: { subagent_type: "t", prompt: "p" } });
    expect(of(emitted, "subagents:created")).toHaveLength(0);
    expect(created).toHaveLength(0);
    const list = await tool("AgentList").execute("tc", {}, undefined, undefined, ctx());
    expect(list.details.agents).toHaveLength(0);
  });

  it("patch overrides prompt, description and model", async () => {
    const created = installSessions();
    const { pi, bus, tool, emitted } = fakePi();
    activate(pi);
    bus.on("model:resolve", (p: any) => {
      p.model = { provider: "x", id: p.ref ?? "patched" };
      p.resolved = "x/patched";
    });
    bus.on("subagents:before_spawn", (p: any) => {
      p.patch = { prompt: "X", description: "patched desc", model: "x/patched" };
    });
    const run = call(tool("Agent"));
    await tick();
    expect(created[0].session.lastPrompt).toContain("<task>\nX\n</task>");
    expect(of(emitted, "subagents:created")[0].description).toBe("patched desc");
    expect((createAgentSession as any).mock.calls[0][0].model).toMatchObject({ provider: "x" });
    created[0].finish();
    await run;
  });

  it("a throwing handler is ignored and the spawn proceeds", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const created = installSessions();
    const { pi, bus, tool } = fakePi();
    activate(pi);
    bus.on("subagents:before_spawn", () => {
      throw new Error("plugin bug");
    });
    const run = call(tool("Agent"));
    await tick();
    expect(created).toHaveLength(1);
    created[0].finish();
    expect((await run).isError).toBeFalsy();
  });

  it("values set after emit returns are ignored", async () => {
    const created = installSessions();
    const { pi, bus, tool } = fakePi();
    activate(pi);
    let held: any;
    bus.on("subagents:before_spawn", (p: any) => (held = p));
    const run = call(tool("Agent"));
    held.veto = true;
    await tick();
    expect(created).toHaveLength(1);
    created[0].finish();
    expect((await run).isError).toBeFalsy();
  });
});

// ─── 6.2 before_store ────────────────────────────────────────────────────

describe("subagents:before_store", () => {
  it("patch replaces the foreground result that is returned", async () => {
    const created = installSessions();
    const { pi, bus, tool } = fakePi();
    activate(pi);
    const seen: any[] = [];
    bus.on("subagents:before_store", (p: any) => {
      seen.push({ ...p });
      p.patch = { result: "[redacted]" };
    });
    const run = call(tool("Agent"));
    await tick();
    created[0].finish("secret");
    const res = await run;
    expect(res.content[0].text).toBe("[redacted]");
    expect(seen[0]).toMatchObject({ background: false, status: "completed", result: "secret", agentId: expect.any(String) });
    expect(seen[0].id).toBeUndefined();
  });

  it("patch replaces the stored background result", async () => {
    const created = installSessions();
    const { pi, bus, tool } = fakePi();
    activate(pi);
    const seen: any[] = [];
    bus.on("subagents:before_store", (p: any) => {
      seen.push({ ...p });
      p.patch = { result: "[redacted]" };
    });
    const id = (await call(tool("Agent"), { run_in_background: true })).details.id;
    await tick();
    created[0].finish("secret");
    await tick();
    const st = await tool("AgentStatus").execute("tc", { ids: [id] }, undefined, undefined, ctx());
    expect(st.details.agents[0].result).toBe("[redacted]");
    expect(seen[0]).toMatchObject({ id, background: true, status: "completed", result: "secret" });
  });

  it("a throwing handler leaves the result unchanged", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const created = installSessions();
    const { pi, bus, tool } = fakePi();
    activate(pi);
    bus.on("subagents:before_store", () => {
      throw new Error("plugin bug");
    });
    const run = call(tool("Agent"));
    await tick();
    created[0].finish("kept");
    expect((await run).content[0].text).toBe("kept");
  });

  it("a non-string patch.result is ignored", async () => {
    const created = installSessions();
    const { pi, bus, tool } = fakePi();
    activate(pi);
    bus.on("subagents:before_store", (p: any) => (p.patch = { result: 42 }));
    const run = call(tool("Agent"));
    await tick();
    created[0].finish("kept");
    expect((await run).content[0].text).toBe("kept");
  });
});

// ─── 6.3 result_read + background flag ───────────────────────────────────

describe("observation events", () => {
  it("background flag on every lifecycle event, both kinds", async () => {
    const created = installSessions();
    const { pi, tool, emitted } = fakePi();
    activate(pi);
    const fg = call(tool("Agent"));
    await tick();
    created[0].finish();
    await fg;
    await call(tool("Agent"), { run_in_background: true });
    await tick();
    created[1].finish();
    await tick();
    const lifecycle = emitted.filter((e) =>
      ["subagents:created", "subagents:started", "subagents:completed", "subagents:failed"].includes(e.channel),
    );
    expect(lifecycle.length).toBeGreaterThan(4);
    const ids = [...new Set(of(emitted, "subagents:created").map((d) => d.id))];
    for (const e of lifecycle) expect(e.data.details.background).toBe(e.data.id === ids[1]);
  });

  it("result_read fires only when a terminal result is returned by AgentStatus", async () => {
    const created = installSessions();
    const { pi, tool, emitted } = fakePi();
    activate(pi);
    const id = (await call(tool("Agent"), { run_in_background: true })).details.id;
    await tick();
    await tool("AgentStatus").execute("tc", { ids: [id] }, undefined, undefined, ctx());
    expect(of(emitted, "subagents:result_read")).toHaveLength(0);
    created[0].finish();
    await tick();
    await tool("AgentStatus").execute("tc", { ids: [id] }, undefined, undefined, ctx());
    expect(of(emitted, "subagents:result_read")).toEqual([
      { id, agentId: of(emitted, "subagents:created")[0].id, via: "status" },
    ]);
  });
});

// ─── 6.4 query channels ──────────────────────────────────────────────────

describe("subagents:list / subagents:get", () => {
  async function twoAgents() {
    const created = installSessions();
    const h = fakePi();
    activate(h.pi);
    const a = (await call(h.tool("Agent"), { run_in_background: true, description: "a" })).details.id;
    const b = (await call(h.tool("Agent"), { run_in_background: true, description: "b" })).details.id;
    await tick();
    return { ...h, created, a, b };
  }

  it("list returns the same rows as AgentList", async () => {
    const { bus, tool, created, a, b } = await twoAgents();
    const payload: any = {};
    bus.emit("subagents:list", payload);
    const viaTool = (await tool("AgentList").execute("tc", {}, undefined, undefined, ctx())).details.agents;
    expect(payload.out.map((r: any) => r.id)).toEqual([a, b]);
    expect(payload.out.map(({ ageMs: _a, ...r }: any) => r)).toEqual(viaTool.map(({ ageMs: _a, ...r }: any) => r));
    created.forEach((c) => c.finish());
    await tick();
  });

  it("list honours a status filter", async () => {
    const { bus, created, a, b } = await twoAgents();
    created[0].finish();
    await tick();
    const payload: any = { filter: { status: "running" } };
    bus.emit("subagents:list", payload);
    expect(payload.out.map((r: any) => r.id)).toEqual([b]);
    expect(a).toBeDefined();
    created[1].finish();
    await tick();
  });

  it("get returns status plus a page of messages, without marking the result read", async () => {
    const { bus, tool, created, a } = await twoAgents();
    created[0].finish("answer");
    await tick();
    const payload: any = { id: a, limit: 5 };
    bus.emit("subagents:get", payload);
    expect(payload.out.status).toMatchObject({ id: a, status: "completed", result: "answer" });
    // The final reply is backfilled into the timeline from message_end.
    expect(payload.out.messages).toMatchObject({ id: a, total: 1, entries: [{ kind: "text", text: "answer" }] });
    const list = (await tool("AgentList").execute("tc", {}, undefined, undefined, ctx())).details;
    expect(list.counts.finishedUnread).toBe(1);
    created[1].finish();
    await tick();
  });

  it("get leaves out unset for an unknown id", async () => {
    const { bus, created } = await twoAgents();
    const payload: any = { id: "bg-nope00" };
    bus.emit("subagents:get", payload);
    expect(payload.out).toBeUndefined();
    created.forEach((c) => c.finish());
    await tick();
  });

  it("an already-set out is never overwritten (another activation answered first)", async () => {
    const { bus, created } = await twoAgents();
    const payload: any = { out: ["first answer"] };
    bus.emit("subagents:list", payload);
    expect(payload.out).toEqual(["first answer"]);
    created.forEach((c) => c.finish());
    await tick();
  });

  it("an activation answers only from its own registry", async () => {
    const created = installSessions();
    const bus = makeBus();
    const one = fakePi(bus);
    const two = fakePi(bus);
    activate(one.pi);
    activate(two.pi);
    const id = (await call(two.tool("Agent"), { run_in_background: true })).details.id;
    await tick();
    const payload: any = { id };
    bus.emit("subagents:get", payload);
    expect(payload.out.status.id).toBe(id);
    created.forEach((c) => c.finish());
    await tick();
  });

  it("not registered when background is off", async () => {
    writeConfig({ allowBackground: false });
    const { bus, pi } = fakePi();
    activate(pi);
    const payload: any = {};
    bus.emit("subagents:list", payload);
    expect(payload.out).toBeUndefined();
  });
});

// ─── 6.5 typed helpers ───────────────────────────────────────────────────

describe("exported helpers", () => {
  it("round-trip through the bus", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const created = installSessions();
    const { pi, tool } = fakePi();
    activate(pi);
    const seen: string[] = [];
    const off = onSubagentEvent(pi, "subagents:created", (e: { id: string }) => seen.push(e.id));
    const id = (await call(tool("Agent"), { run_in_background: true })).details.id;
    await tick();
    expect(seen).toHaveLength(1);
    off();

    const raw: any = {};
    pi.events.emit("subagents:list", raw);
    expect(listBackgroundAgents(pi)).toEqual(raw.out.map((r: any) => ({ ...r, ageMs: expect.any(Number) })));
    expect(getBackgroundAgent(pi, id)?.status.id).toBe(id);
    expect(getBackgroundAgent(pi, "bg-nope00")).toBeUndefined();

    stopSubagent(pi, getBackgroundAgent(pi, id)!.status.agentId!);
    await tick();
    expect(getBackgroundAgent(pi, id)?.status).toMatchObject({ status: "stopped", stoppedBy: "event" });
    expect(created).toHaveLength(1);
  });

  it("helpers return empty results without a bus", () => {
    const pi: any = {};
    expect(listBackgroundAgents(pi)).toEqual([]);
    expect(getBackgroundAgent(pi, "bg-x")).toBeUndefined();
    expect(() => stopSubagent(pi, "x")).not.toThrow();
    expect(onSubagentEvent(pi, "subagents:created", () => {})).toBeTypeOf("function");
  });
});

describe("orchestration channels are part of the typed surface (add-subagent-orchestration)", () => {
  it("SUBAGENT_CHANNELS names every orchestration event", async () => {
    const { SUBAGENT_CHANNELS } = await import("../index.js");
    expect(SUBAGENT_CHANNELS).toMatchObject({
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
    });
  });
});
