/**
 * Background spawning through the real `activate()` surface with a fake child
 * session. Own file so the process-wide semaphore state is isolated.
 *
 * See change: add-background-subagents.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import activate, { buildAgentParametersSchema } from "../agent.js";
import { invalidateSettingsCache } from "../settings.js";
import { createAgentSession } from "@earendil-works/pi-coding-agent";

/** `AgentStatus {ids, wait?}` → `wait {ids, until}` (see change: agent-control-unified-wait). */
const asAction = (action: string, p: any) => {
  if (action !== "status") return { action, ...p };
  const { wait, ...rest } = p ?? {};
  return { action: "wait", until: wait ?? "none", ...rest };
};


let tmpAgentDir: string;
let tmpCwd: string;

const MockResourceLoader = vi.hoisted(
  () =>
    class MockResourceLoader {
      constructor(public opts: Record<string, unknown>) {}
      reload = async () => {};
    },
);

vi.mock("@earendil-works/pi-coding-agent", () => ({
  getAgentDir: () => tmpAgentDir,
  defineTool: <T,>(t: T) => t,
  createAgentSession: vi.fn(),
  DefaultResourceLoader: MockResourceLoader,
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
  tmpAgentDir = mkdtempSync(join(tmpdir(), "pi-subagents-bg-agentdir-"));
  tmpCwd = mkdtempSync(join(tmpdir(), "pi-subagents-bg-cwd-"));
  invalidateSettingsCache();
  writeConfig({});
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  if (existsSync(tmpAgentDir)) rmSync(tmpAgentDir, { recursive: true, force: true });
  if (existsSync(tmpCwd)) rmSync(tmpCwd, { recursive: true, force: true });
});

// ─── Harness ─────────────────────────────────────────────────────────────

type Emitted = { channel: string; data: any };

export function fakePi() {
  const emitted: Emitted[] = [];
  const handlers = new Map<string, Array<(d: unknown) => void>>();
  const lifecycle = new Map<string, Array<(e: unknown, c: unknown) => unknown>>();
  const tools: any[] = [];
  const pi: any = {
    events: {
      emit: vi.fn((channel: string, data: any) => {
        emitted.push({ channel, data });
        for (const h of handlers.get(channel) ?? []) h(data);
      }),
      on: vi.fn((channel: string, h: (d: unknown) => void) => {
        handlers.set(channel, [...(handlers.get(channel) ?? []), h]);
        return () => handlers.set(channel, (handlers.get(channel) ?? []).filter((x) => x !== h));
      }),
    },
    registerTool: (t: any) => tools.push(t),
    on: (event: string, h: (e: unknown, c: unknown) => unknown) => {
      lifecycle.set(event, [...(lifecycle.get(event) ?? []), h]);
    },
    sendMessage: vi.fn(),
    sendUserMessage: vi.fn(),
  };
  // Old tool names map onto AgentControl actions (add-subagent-orchestration D0),
  // so these behavioural assertions exercise the single tool.
  const ACTIONS: Record<string, string> = {
    AgentStatus: "status",
    AgentMessages: "messages",
    AgentList: "list",
    AgentCancel: "cancel",
  };
  const tool = (name: string) => {
    const action = ACTIONS[name];
    if (!action) return tools.find((t) => t.name === name);
    const control = tools.find((t) => t.name === "AgentControl");
    return (
      control && {
        name,
        execute: (id: string, params: any, ...rest: any[]) => control.execute(id, asAction(action, params), ...rest),
      }
    );
  };
  const fire = async (event: string, payload: unknown = {}) => {
    for (const h of lifecycle.get(event) ?? []) await h(payload, {});
  };
  return { pi, emitted, tools, tool, fire };
}

interface FakeHandle {
  session: any;
  emit(e: any): void;
  finish(final?: any): void;
}

const ALL_TOOLS = ["Read", "Agent", "AgentControl"];

function makeFakeSession(): FakeHandle {
  let listener: ((e: any) => void) | undefined;
  let resolve: (() => void) | undefined;
  let done = false;
  const emit = (e: any) => listener?.(e);
  const finish = (final?: any) => {
    if (done) return;
    done = true;
    emit({
      type: "message_end",
      message: final
        ? { role: "assistant", ...final }
        : { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "done" }] },
    });
    resolve?.();
  };
  const session: any = {
    model: { id: "mock-model" },
    getActiveToolNames: () => [...ALL_TOOLS],
    setActiveToolsByName: vi.fn(),
    subscribe: (fn: any) => {
      listener = fn;
      return () => {
        listener = undefined;
      };
    },
    prompt: vi.fn(
      (text: string) =>
        new Promise<void>((res) => {
          session.lastPrompt = text;
          resolve = res;
        }),
    ),
    dispose: vi.fn(),
    abort: vi.fn(async () => finish({ stopReason: "aborted", content: [] })),
  };
  return { session, emit, finish };
}

export function installSessions() {
  const created: FakeHandle[] = [];
  (createAgentSession as any).mockReset();
  (createAgentSession as any).mockImplementation(async () => {
    const h = makeFakeSession();
    created.push(h);
    return { session: h.session };
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

async function tick(n = 40): Promise<void> {
  for (let i = 0; i < n; i++) await Promise.resolve();
}

const ctx = () => ({ cwd: tmpCwd }) as any;
const call = (tool: any, params: Record<string, unknown>, signal?: AbortSignal, onUpdate?: any) =>
  tool.execute(`tc-${Math.random()}`, { subagent_type: "t", description: "d", prompt: "p", ...params }, signal, onUpdate, ctx());
const ofChannel = (emitted: Emitted[], ch: string) => emitted.filter((e) => e.channel === ch).map((e) => e.data);
const bgId = (res: any): string => res.details.id;

// ─── 3.3 Schema / registration ──────────────────────────────────────────

describe("schema and tool surface (allowBackground)", () => {
  it("buildAgentParametersSchema adds optional run_in_background and timeout_s only when enabled", () => {
    const off: any = buildAgentParametersSchema(false, false);
    const on: any = buildAgentParametersSchema(false, true);
    expect(off.properties.run_in_background).toBeUndefined();
    expect(off.properties.timeout_s).toBeUndefined();
    expect(on.properties.run_in_background.type).toBe("boolean");
    expect(on.properties.timeout_s.type).toBe("number");
    expect(on.required).not.toContain("run_in_background");
    expect(on.required).not.toContain("timeout_s");
    // Default argument keeps the pre-change schema.
    expect(buildAgentParametersSchema(false)).toEqual(off);
  });

  it("allowBackground: false registers only Agent with today's schema", () => {
    writeConfig({ allowBackground: false });
    const { pi, tools } = fakePi();
    activate(pi);
    expect(tools.map((t) => t.name)).toEqual(["Agent"]);
    expect(tools[0].parameters).toEqual(buildAgentParametersSchema(false));
  });

  it("allowBackground: true (default) exposes the background parameters on Agent", () => {
    const { pi, tool } = fakePi();
    activate(pi);
    expect(tool("Agent").parameters.properties.run_in_background).toBeDefined();
    expect(tool("Agent").parameters.properties.timeout_s).toBeDefined();
  });

  it("run_in_background is ignored when the feature is off (runs in the foreground)", async () => {
    writeConfig({ allowBackground: false });
    const created = installSessions();
    const { pi, tool } = fakePi();
    activate(pi);
    const p = call(tool("Agent"), { run_in_background: true });
    await tick();
    created[0].finish();
    const res = await p;
    expect(res.details.agentId).toBeDefined();
    expect(res.details.background).toBe(false);
    expect(res.content[0].text).toBe("done");
  });
});

// ─── 3.4 Background branch of execute ────────────────────────────────────

describe("Agent with run_in_background: true", () => {
  it("returns immediately with a bg- id while the run continues", async () => {
    const created = installSessions();
    const { pi, tool, emitted } = fakePi();
    activate(pi);
    const res = await call(tool("Agent"), { run_in_background: true });
    expect(res.isError).toBeFalsy();
    expect(res.content[0].text).toMatch(/\bbg-[0-9a-f]{6}\b/);
    expect(res.details).toMatchObject({ background: true, id: expect.stringMatching(/^bg-/) });
    // Must not finalize the dashboard card early.
    expect(res.details.agentId).toBeUndefined();

    await tick();
    expect(created).toHaveLength(1);
    expect(ofChannel(emitted, "subagents:completed")).toHaveLength(0);
    created[0].finish();
    await tick();
    const done = ofChannel(emitted, "subagents:completed");
    expect(done).toHaveLength(1);
    expect(done[0].result).toBe("done");
  });

  it("emits the full lifecycle with details.background === true", async () => {
    const created = installSessions();
    const { pi, tool, emitted } = fakePi();
    activate(pi);
    await call(tool("Agent"), { run_in_background: true });
    await tick();
    created[0].emit({ type: "message_update", assistantMessageEvent: { type: "text_start" } });
    created[0].emit({ type: "message_update", assistantMessageEvent: { type: "text_end", content: "hi" } });
    created[0].finish();
    await tick();
    for (const ch of ["subagents:created", "subagents:started", "subagents:completed"]) {
      const evs = ofChannel(emitted, ch);
      expect(evs.length, ch).toBeGreaterThan(0);
      for (const e of evs) expect(e.details.background, ch).toBe(true);
    }
    expect(ofChannel(emitted, "subagents:entry").length).toBeGreaterThan(0);
  });

  it("foreground snapshots carry background: false", async () => {
    const created = installSessions();
    const { pi, tool, emitted } = fakePi();
    activate(pi);
    const p = call(tool("Agent"), {});
    await tick();
    created[0].finish();
    await p;
    expect(ofChannel(emitted, "subagents:created")[0].details.background).toBe(false);
    expect(ofChannel(emitted, "subagents:completed")[0].details.background).toBe(false);
  });

  it("a parent turn abort does not stop background work", async () => {
    const created = installSessions();
    const { pi, tool, emitted } = fakePi();
    activate(pi);
    const ac = new AbortController();
    await call(tool("Agent"), { run_in_background: true }, ac.signal);
    await tick();
    ac.abort();
    await tick();
    expect(created[0].session.abort).not.toHaveBeenCalled();
    created[0].finish();
    await tick();
    expect(ofChannel(emitted, "subagents:completed")).toHaveLength(1);
    expect(ofChannel(emitted, "subagents:failed")).toHaveLength(0);
  });

  it("never sends anything into the parent conversation", async () => {
    const created = installSessions();
    const { pi, tool } = fakePi();
    activate(pi);
    await call(tool("Agent"), { run_in_background: true });
    await tick();
    created[0].finish();
    await tick();
    expect(pi.sendMessage).not.toHaveBeenCalled();
    expect(pi.sendUserMessage).not.toHaveBeenCalled();
  });

  it("several at once: all return ids, the third reports queued under maxConcurrent: 2", async () => {
    writeConfig({ maxConcurrent: 2 });
    const created = installSessions();
    const { pi, tool } = fakePi();
    activate(pi);
    const results = [];
    for (let i = 0; i < 3; i++) results.push(await call(tool("Agent"), { run_in_background: true }));
    await tick();
    expect(new Set(results.map(bgId)).size).toBe(3);
    expect(results.map((r) => r.details.status)).toEqual(["running", "running", "queued"]);
    expect(results[2].details.queuePosition).toBe(1);
    expect(results[2].content[0].text).toMatch(/queued/);
    expect(created).toHaveLength(2);
    created.forEach((c) => c.finish());
    await tick();
    created[2]!.finish();
    await tick();
  });

  it("the spawn result reports running / queued / finished-unread counts", async () => {
    writeConfig({ maxConcurrent: 1 });
    const created = installSessions();
    const { pi, tool } = fakePi();
    activate(pi);
    await call(tool("Agent"), { run_in_background: true });
    await tick();
    created[0].finish();
    await tick();
    await call(tool("Agent"), { run_in_background: true });
    const third = await call(tool("Agent"), { run_in_background: true });
    expect(third.details.counts).toEqual({ running: 1, queued: 1, idle: 0, finishedUnread: 1 });
    expect(third.content[0].text).toMatch(/1 running, 1 queued, 0 idle, 1 finished-unread/);
    await tick();
    created[1].finish();
    await tick();
    created[2].finish();
    await tick();
  });
});

// ─── Pending cap (maxBackgroundPending) ──────────────────────────────────

describe("maxBackgroundPending", () => {
  it("rejects a spawn at the cap with the outstanding ids and creates nothing", async () => {
    writeConfig({ maxBackgroundPending: 2 });
    const created = installSessions();
    const { pi, tool, emitted } = fakePi();
    activate(pi);
    const a = await call(tool("Agent"), { run_in_background: true });
    const b = await call(tool("Agent"), { run_in_background: true });
    await tick();
    const createdBefore = ofChannel(emitted, "subagents:created").length;
    const rejected = await call(tool("Agent"), { run_in_background: true });
    expect(rejected.isError).toBe(true);
    expect(rejected.content[0].text).toContain(bgId(a));
    expect(rejected.content[0].text).toContain(bgId(b));
    expect(rejected.content[0].text).toMatch(/AgentControl/);
    expect(ofChannel(emitted, "subagents:created")).toHaveLength(createdBefore);
    created.forEach((c) => c.finish());
    await tick();

    // Finished runs no longer count.
    const again = await call(tool("Agent"), { run_in_background: true });
    expect(again.isError).toBeFalsy();
    await tick();
    created.at(-1)!.finish();
    await tick();
  });

  it("does not count or block foreground calls", async () => {
    writeConfig({ maxBackgroundPending: 1 });
    const created = installSessions();
    const { pi, tool } = fakePi();
    activate(pi);
    await call(tool("Agent"), { run_in_background: true });
    const fg = call(tool("Agent"), {});
    await tick();
    expect(created).toHaveLength(2);
    created[1].finish();
    const res = await fg;
    expect(res.isError).toBeFalsy();
    created[0].finish();
    await tick();
  });

  it("0 means unlimited", async () => {
    writeConfig({ maxBackgroundPending: 0, maxConcurrent: 0 });
    const created = installSessions();
    const { pi, tool } = fakePi();
    activate(pi);
    for (let i = 0; i < 12; i++) expect((await call(tool("Agent"), { run_in_background: true })).isError).toBeFalsy();
    await tick();
    created.forEach((c) => c.finish());
    await tick();
  });
});

// ─── 3.5 Child tool filter ───────────────────────────────────────────────

describe("children never manage subagents", () => {
  it("strips Agent and every background tool from the child's active tools", async () => {
    const created = installSessions();
    const { pi, tool } = fakePi();
    activate(pi);
    const p = call(tool("Agent"), {});
    await tick();
    expect(created[0].session.setActiveToolsByName).toHaveBeenCalledWith(["Read"]);
    created[0].finish();
    await p;
  });
});

// ─── 4. Read tools ───────────────────────────────────────────────────────

/** Activate, spawn `n` background runs, and return handles. */
async function withBackground(n: number, config: Record<string, unknown> = {}) {
  writeConfig({ maxConcurrent: 0, ...config });
  const created = installSessions();
  const h = fakePi();
  activate(h.pi);
  const ids: string[] = [];
  for (let i = 0; i < n; i++) ids.push(bgId(await call(h.tool("Agent"), { run_in_background: true, prompt: `p${i}` })));
  await tick();
  return { ...h, created, ids };
}

const statusCall = (tool: any, params: Record<string, unknown>, signal?: AbortSignal, onUpdate?: any) =>
  tool.execute("tc-status", params, signal, onUpdate, ctx());
const parse = (res: any) => res.details;

describe("AgentStatus", () => {
  it("is registered only when background is on", () => {
    const { pi, tool } = fakePi();
    activate(pi);
    for (const n of ["AgentStatus", "AgentMessages", "AgentList", "AgentCancel"]) expect(tool(n), n).toBeDefined();
  });

  it("returns a snapshot immediately without waiting", async () => {
    const { tool, created, ids } = await withBackground(1);
    const res = await statusCall(tool("AgentStatus"), { ids: [ids[0]] });
    expect(parse(res).agents).toEqual([expect.objectContaining({ id: ids[0], status: "running" })]);
    expect(res.content[0].text).toContain(ids[0]);
    created[0].finish();
    await tick();
  });

  it("returns the stored result of a finished subagent and marks it read", async () => {
    const { tool, created, ids, emitted } = await withBackground(1);
    created[0].finish({ stopReason: "stop", content: [{ type: "text", text: "the answer" }] });
    await tick();
    const res = await statusCall(tool("AgentStatus"), { ids: [ids[0]] });
    expect(parse(res).agents[0]).toMatchObject({ id: ids[0], status: "completed", result: "the answer" });
    expect(res.content[0].text).toContain("the answer");
    expect(ofChannel(emitted, "subagents:result_read")).toEqual([
      expect.objectContaining({ id: ids[0], via: "wait" }),
    ]);
    const list = await statusCall(tool("AgentList"), {});
    expect(parse(list).counts.finishedUnread).toBe(0);
  });

  it("wait: all resolves only after every id is terminal", async () => {
    const { tool, created, ids } = await withBackground(2);
    let settled = false;
    const p = statusCall(tool("AgentStatus"), { ids, wait: "all" }).then((r: any) => ((settled = true), r));
    await tick();
    created[0].finish();
    await tick();
    expect(settled).toBe(false);
    created[1].finish({ stopReason: "stop", content: [{ type: "text", text: "second" }] });
    const res = await p;
    expect(parse(res).agents.map((a: any) => a.status)).toEqual(["completed", "completed"]);
    expect(parse(res).agents[1].result).toBe("second");
  });

  it("wait: any returns once one is terminal with the others' current status", async () => {
    const { tool, created, ids } = await withBackground(2);
    const p = statusCall(tool("AgentStatus"), { ids, wait: "any" });
    await tick();
    created[1].finish({ stopReason: "stop", content: [{ type: "text", text: "b first" }] });
    const res = await p;
    const byId = Object.fromEntries(parse(res).agents.map((a: any) => [a.id, a]));
    expect(byId[ids[1]]).toMatchObject({ status: "completed", result: "b first" });
    expect(byId[ids[0]]).toMatchObject({ status: "running" });
    created[0].finish();
    await tick();
  });

  it("timeout_s returns the current state and cancels nothing", async () => {
    const { tool, created, ids } = await withBackground(1);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const p = statusCall(tool("AgentStatus"), { ids, wait: "all", timeout_s: 5 });
    await vi.advanceTimersByTimeAsync(5_000);
    const res = await p;
    expect(parse(res).agents[0].status).toBe("running");
    expect(parse(res).timedOut).toBe(true);
    expect(created[0].session.abort).not.toHaveBeenCalled();
    vi.useRealTimers();
    created[0].finish();
    await tick();
  });

  it("aborting the call ends only the wait", async () => {
    const { tool, created, ids } = await withBackground(1);
    const ac = new AbortController();
    const p = statusCall(tool("AgentStatus"), { ids, wait: "all" }, ac.signal);
    await tick();
    ac.abort();
    const res = await p;
    expect(parse(res).agents[0].status).toBe("running");
    expect(created[0].session.abort).not.toHaveBeenCalled();
    created[0].finish();
    await tick();
  });

  it("reports unknown ids as not_found without failing the others", async () => {
    const { tool, created, ids } = await withBackground(1);
    const res = await statusCall(tool("AgentStatus"), { ids: [ids[0], "bg-nope00"] });
    expect(res.isError).toBeFalsy();
    expect(parse(res).agents).toEqual([
      expect.objectContaining({ id: ids[0], status: "running" }),
      expect.objectContaining({ id: "bg-nope00", status: "not_found" }),
    ]);
    created[0].finish();
    await tick();
  });

  it("accepts the full agentId and a unique prefix", async () => {
    const { tool, created, ids, emitted } = await withBackground(1);
    const agentId = ofChannel(emitted, "subagents:created")[0].id;
    const res = await statusCall(tool("AgentStatus"), { ids: [agentId, ids[0].slice(0, 6)] });
    expect(parse(res).agents.map((a: any) => a.id)).toEqual([ids[0], ids[0]]);
    created[0].finish();
    await tick();
  });

  it("bounds the combined output by resultMaxChars", async () => {
    const { tool, created, ids } = await withBackground(2, { resultMaxChars: 400 });
    const big = "x".repeat(5_000);
    created[0].finish({ stopReason: "stop", content: [{ type: "text", text: big }] });
    created[1].finish({ stopReason: "stop", content: [{ type: "text", text: big }] });
    await tick();
    const res = await statusCall(tool("AgentStatus"), { ids });
    expect(res.content[0].text.length).toBeLessThanOrEqual(400 + 80);
  });

  it("forwards snapshots through onUpdate while waiting", async () => {
    const { tool, created, ids } = await withBackground(1);
    const onUpdate = vi.fn();
    const p = statusCall(tool("AgentStatus"), { ids, wait: "all" }, undefined, onUpdate);
    await tick();
    created[0].emit({ type: "tool_execution_start", toolCallId: "t1", toolName: "read", args: {} });
    await new Promise((r) => setTimeout(r, 300));
    expect(onUpdate).toHaveBeenCalled();
    created[0].finish();
    await p;
  });
});

describe("AgentMessages", () => {
  async function withEntries(count: number, config: Record<string, unknown> = {}) {
    const h = await withBackground(1, config);
    for (let i = 0; i < count; i++) {
      h.created[0].emit({
        type: "message_update",
        assistantMessageEvent: { type: i % 2 ? "thinking_end" : "text_end", content: `m${i}` },
      });
    }
    return h;
  }
  const msgs = (tool: any, params: Record<string, unknown>) => tool.execute("tc-m", params, undefined, undefined, ctx());

  it("returns the last 20 entries by default with total and next_from", async () => {
    const { tool, created, ids } = await withEntries(50);
    const res = await msgs(tool("AgentMessages"), { id: ids[0] });
    const d = parse(res);
    expect(d.total).toBe(50);
    expect(d.from).toBe(30);
    expect(d.next_from).toBe(50);
    expect(d.entries.map((e: any) => e.text)).toEqual(Array.from({ length: 20 }, (_, i) => `m${30 + i}`));
    created[0].finish();
    await tick();
  });

  it("reads incrementally from `from` while running", async () => {
    const { tool, created, ids } = await withEntries(12);
    const first = parse(await msgs(tool("AgentMessages"), { id: ids[0] }));
    expect(first.next_from).toBe(12);
    created[0].emit({ type: "message_update", assistantMessageEvent: { type: "text_end", content: "late" } });
    const next = parse(await msgs(tool("AgentMessages"), { id: ids[0], from: first.next_from }));
    expect(next.entries.map((e: any) => e.text)).toEqual(["late"]);
    expect(next.next_from).toBe(13);
    created[0].finish();
    await tick();
  });

  it("filters kinds before paging", async () => {
    const { tool, created, ids } = await withEntries(10);
    const d = parse(await msgs(tool("AgentMessages"), { id: ids[0], kinds: ["text"], limit: 3 }));
    expect(d.total).toBe(5);
    expect(d.entries.map((e: any) => e.text)).toEqual(["m4", "m6", "m8"]);
    created[0].finish();
    await tick();
  });

  it("cuts each field and bounds the whole response", async () => {
    const h = await withBackground(1, { entryFieldMaxChars: 50, resultMaxChars: 600 });
    for (let i = 0; i < 30; i++) {
      h.created[0].emit({ type: "message_update", assistantMessageEvent: { type: "text_end", content: "y".repeat(500) } });
    }
    const res = await msgs(h.tool("AgentMessages"), { id: h.ids[0], limit: 30 });
    for (const e of parse(res).entries) expect(e.text.length).toBeLessThan(500);
    expect(res.content[0].text.length).toBeLessThanOrEqual(600 + 80);
    h.created[0].finish();
    await tick();
  });

  it("a queued subagent returns no entries with total 0", async () => {
    writeConfig({ maxConcurrent: 1 });
    const created = installSessions();
    const { pi, tool } = fakePi();
    activate(pi);
    await call(tool("Agent"), { run_in_background: true });
    const queued = bgId(await call(tool("Agent"), { run_in_background: true }));
    await tick();
    const d = parse(await msgs(tool("AgentMessages"), { id: queued }));
    expect(d).toMatchObject({ total: 0, entries: [], status: "queued" });
    created[0].finish();
    await tick();
    created[1].finish();
    await tick();
  });

  it("emits subagents:result_read with via: messages when entries are returned", async () => {
    const { tool, created, ids, emitted } = await withEntries(2);
    await msgs(tool("AgentMessages"), { id: ids[0] });
    expect(ofChannel(emitted, "subagents:result_read")).toEqual([expect.objectContaining({ id: ids[0], via: "messages" })]);
    created[0].finish();
    await tick();
  });

  it("unknown id is an error result", async () => {
    const { tool, created } = await withEntries(0);
    const res = await msgs(tool("AgentMessages"), { id: "bg-nope00" });
    expect(res.isError).toBe(true);
    created[0].finish();
    await tick();
  });
});

describe("AgentList", () => {
  it("lists mixed states with a counts line and the unread flag", async () => {
    writeConfig({ maxConcurrent: 1 });
    const created = installSessions();
    const { pi, tool } = fakePi();
    activate(pi);
    const done = bgId(await call(tool("Agent"), { run_in_background: true, description: "first" }));
    await tick();
    created[0].finish();
    await tick();
    const running = bgId(await call(tool("Agent"), { run_in_background: true, description: "second" }));
    const queued = bgId(await call(tool("Agent"), { run_in_background: true, description: "third" }));
    await tick();

    const res = await tool("AgentList").execute("tc-l", {}, undefined, undefined, ctx());
    const d = parse(res);
    const byId = Object.fromEntries(d.agents.map((a: any) => [a.id, a]));
    expect(byId[done]).toMatchObject({ status: "completed", unread: true, description: "first", subagent_type: "t" });
    expect(byId[running]).toMatchObject({ status: "running", unread: false });
    expect(byId[queued]).toMatchObject({ status: "queued" });
    for (const a of d.agents) {
      expect(typeof a.ageMs).toBe("number");
      expect(typeof a.tokens).toBe("string");
    }
    expect(d.counts).toEqual({ running: 1, queued: 1, idle: 0, finishedUnread: 1 });
    expect(res.content[0].text).toMatch(/1 running, 1 queued, 0 idle, 1 finished-unread/);

    created[1].finish();
    await tick();
    created[2].finish();
    await tick();
  });

  it("is empty when nothing was spawned", async () => {
    const { pi, tool } = fakePi();
    activate(pi);
    const res = await tool("AgentList").execute("tc-l", {}, undefined, undefined, ctx());
    expect(parse(res).agents).toEqual([]);
    expect(res.content[0].text).toMatch(/No background subagents/);
  });
});

// ─── 5. Cancellation, timeout, shutdown ──────────────────────────────────

const cancel = (tool: any, params: Record<string, unknown>) => tool.execute("tc-c", params, undefined, undefined, ctx());
const completedFor = (emitted: Emitted[], agentId: string) =>
  ofChannel(emitted, "subagents:completed").find((d) => d.id === agentId);

describe("AgentCancel", () => {
  it("stops a running subagent: stopped / running / tool, entries still readable", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { tool, created, ids, emitted } = await withBackground(1);
    created[0].emit({ type: "message_update", assistantMessageEvent: { type: "text_end", content: "partial" } });
    const res = await cancel(tool("AgentCancel"), { ids: [ids[0]] });
    expect(parse(res).results).toEqual([{ id: ids[0], outcome: "stopped" }]);
    await tick();
    const st = parse(await statusCall(tool("AgentStatus"), { ids }));
    const done = completedFor(emitted, st.agents[0].agentId);
    expect(done.details).toMatchObject({ status: "stopped", stopReason: "running", stoppedBy: "tool", background: true });
    expect(st.agents[0]).toMatchObject({ status: "stopped", stopReason: "running", stoppedBy: "tool" });
    const msgs = parse(await tool("AgentMessages").execute("tc", { id: ids[0] }, undefined, undefined, ctx()));
    expect(msgs.entries.map((e: any) => e.text)).toEqual(["partial"]);
  });

  it("removes a queued subagent without it ever taking a slot", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    writeConfig({ maxConcurrent: 1 });
    const created = installSessions();
    const { pi, tool, emitted } = fakePi();
    activate(pi);
    await call(tool("Agent"), { run_in_background: true });
    const queued = bgId(await call(tool("Agent"), { run_in_background: true }));
    await tick();
    expect(parse(await cancel(tool("AgentCancel"), { ids: [queued] })).results[0].outcome).toBe("stopped");
    await tick();
    const st = parse(await statusCall(tool("AgentStatus"), { ids: [queued] })).agents[0];
    expect(st).toMatchObject({ status: "stopped", stopReason: "queued", stoppedBy: "tool" });
    expect(completedFor(emitted, st.agentId).details.stoppedBy).toBe("tool");
    created[0].finish();
    await tick();
    expect(created).toHaveLength(1);
  });

  it('ids: "all" with status: "queued" bulk-cancels the queue and leaves running ones', async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    writeConfig({ maxConcurrent: 2, maxBackgroundPending: 0 });
    const created = installSessions();
    const { pi, tool } = fakePi();
    activate(pi);
    for (let i = 0; i < 7; i++) await call(tool("Agent"), { run_in_background: true });
    await tick();
    const res = parse(await cancel(tool("AgentCancel"), { ids: "all", status: "queued" }));
    expect(res.results).toHaveLength(5);
    expect(res.results.every((r: any) => r.outcome === "stopped")).toBe(true);
    await tick();
    const list = parse(await tool("AgentList").execute("tc", {}, undefined, undefined, ctx()));
    expect(list.agents.filter((a: any) => a.status === "running")).toHaveLength(2);
    expect(list.agents.filter((a: any) => a.status === "stopped")).toHaveLength(5);
    expect(created).toHaveLength(2);
    created.forEach((c) => c.finish());
    await tick();
  });

  it("finished → already_finished (result unchanged); unknown → not_found", async () => {
    const { tool, created, ids } = await withBackground(1);
    created[0].finish({ stopReason: "stop", content: [{ type: "text", text: "kept" }] });
    await tick();
    const res = parse(await cancel(tool("AgentCancel"), { ids: [ids[0], "bg-nope00"] }));
    expect(res.results).toEqual([
      { id: ids[0], outcome: "already_finished" },
      { id: "bg-nope00", outcome: "not_found" },
    ]);
    expect(parse(await statusCall(tool("AgentStatus"), { ids })).agents[0].result).toBe("kept");
  });

  it("a dashboard subagents:stop on a background subagent is recorded as stoppedBy: event", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { pi, tool, ids, emitted } = await withBackground(1);
    const agentId = ofChannel(emitted, "subagents:created")[0].id;
    pi.events.emit("subagents:stop", { agentId });
    await tick();
    expect(completedFor(emitted, agentId).details.stoppedBy).toBe("event");
    expect(parse(await statusCall(tool("AgentStatus"), { ids })).agents[0]).toMatchObject({
      status: "stopped",
      stoppedBy: "event",
    });
  });

  it("foreground subagents stopped from the bus also carry stoppedBy: event", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    installSessions();
    const { pi, tool, emitted } = fakePi();
    activate(pi);
    const p = call(tool("Agent"), {});
    await tick();
    pi.events.emit("subagents:stop", { agentId: ofChannel(emitted, "subagents:created")[0].id });
    const res = await p;
    expect(res.details).toMatchObject({ status: "stopped", stoppedBy: "event" });
  });
});

describe("run-time limit", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
  });

  it("timeout_s stops a long run with stoppedBy: timeout", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { tool, ids, emitted } = await withBackground(0);
    const id = bgId(await call(tool("Agent"), { run_in_background: true, timeout_s: 60 }));
    await tick();
    await vi.advanceTimersByTimeAsync(59_000);
    expect(ofChannel(emitted, "subagents:completed")).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1_000);
    await tick();
    const st = parse(await statusCall(tool("AgentStatus"), { ids: [id, ...ids] })).agents[0];
    expect(st).toMatchObject({ status: "stopped", stopReason: "running", stoppedBy: "timeout" });
  });

  it("queue time is not counted", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    writeConfig({ maxConcurrent: 1 });
    const created = installSessions();
    const { pi, tool } = fakePi();
    activate(pi);
    await call(tool("Agent"), { run_in_background: true });
    const waiter = bgId(await call(tool("Agent"), { run_in_background: true, timeout_s: 60 }));
    await tick();
    await vi.advanceTimersByTimeAsync(120_000); // queued the whole time
    created[0].finish();
    await tick();
    expect(created).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(59_000);
    let st = parse(await statusCall(tool("AgentStatus"), { ids: [waiter] })).agents[0];
    expect(st.status).toBe("running");
    await vi.advanceTimersByTimeAsync(1_000);
    await tick();
    st = parse(await statusCall(tool("AgentStatus"), { ids: [waiter] })).agents[0];
    expect(st).toMatchObject({ status: "stopped", stoppedBy: "timeout" });
  });

  it("the timer is cleared when the run finishes first", async () => {
    const { tool, created } = await withBackground(0);
    await call(tool("Agent"), { run_in_background: true, timeout_s: 60 });
    await tick();
    expect(vi.getTimerCount()).toBeGreaterThan(0);
    created[0].finish();
    await tick();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("backgroundTimeoutSec is the default; timeout_s: 0 disables it per call", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { tool, created } = await withBackground(0, { backgroundTimeoutSec: 30 });
    const limited = bgId(await call(tool("Agent"), { run_in_background: true }));
    const unlimited = bgId(await call(tool("Agent"), { run_in_background: true, timeout_s: 0 }));
    await tick();
    await vi.advanceTimersByTimeAsync(30_000);
    await tick();
    const st = parse(await statusCall(tool("AgentStatus"), { ids: [limited, unlimited] })).agents;
    expect(st[0]).toMatchObject({ status: "stopped", stoppedBy: "timeout" });
    expect(st[1].status).toBe("running");
    created[1].finish();
    await tick();
  });
});

describe("session_shutdown", () => {
  it("stops queued and running background subagents with stoppedBy: shutdown; idempotent; no slot held", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    writeConfig({ maxConcurrent: 1 });
    const created = installSessions();
    const { pi, tool, fire } = fakePi();
    activate(pi);
    const running = bgId(await call(tool("Agent"), { run_in_background: true }));
    const queued = bgId(await call(tool("Agent"), { run_in_background: true }));
    await tick();
    await fire("session_shutdown");
    await fire("session_shutdown");
    await tick();
    const st = parse(await statusCall(tool("AgentStatus"), { ids: [running, queued] })).agents;
    expect(st[0]).toMatchObject({ status: "stopped", stopReason: "running", stoppedBy: "shutdown" });
    expect(st[1]).toMatchObject({ status: "stopped", stopReason: "queued", stoppedBy: "shutdown" });
    expect(created).toHaveLength(1);

    // The slot is free: a new foreground run starts at once.
    const fg = call(tool("Agent"), {});
    await tick();
    expect(created).toHaveLength(2);
    created[1].finish();
    await fg;
  });

  it("leaves foreground runs alone", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const created = installSessions();
    const { pi, tool, fire } = fakePi();
    activate(pi);
    const fg = call(tool("Agent"), {});
    await tick();
    await fire("session_shutdown");
    expect(created[0].session.abort).not.toHaveBeenCalled();
    created[0].finish();
    expect((await fg).details.status).toBe("completed");
  });
});

// See change: surface-subagent-retries (task 5.1).
describe("AgentMessages with retry entries", () => {
  it("returns and filters retry entries like any other kind", async () => {
    const h = await withBackground(1);
    h.created[0].emit({ type: "auto_retry_start", attempt: 1, maxAttempts: 3, delayMs: 2_000, errorMessage: "503" });
    h.created[0].emit({ type: "message_update", assistantMessageEvent: { type: "text_end", content: "ok" } });
    const all = parse(await h.tool("AgentMessages").execute("tc", { id: h.ids[0] }, undefined, undefined, ctx()));
    expect(all.entries.map((e: any) => e.kind)).toEqual(["retry", "text"]);
    const res = await h.tool("AgentMessages").execute("tc", { id: h.ids[0], kinds: ["retry"] }, undefined, undefined, ctx());
    expect(parse(res).entries).toEqual([expect.objectContaining({ kind: "retry", attempt: 1, text: "503" })]);
    expect(res.content[0].text).toContain("retry 1/3 after 2s: 503");
    h.created[0].finish();
    await tick();
  });
});
