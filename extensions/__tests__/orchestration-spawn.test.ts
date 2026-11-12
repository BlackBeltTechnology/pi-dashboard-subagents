/**
 * Orchestration through the real `activate()` surface with fake child
 * sessions: `Agent.cwd`, idle lifecycle, mailbox, ask_parent, AgentWait,
 * AgentReply, AgentSteer, push, persistence and events. Own file so the
 * process-wide semaphore state is isolated.
 *
 * See change: add-subagent-orchestration.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import activate from "../agent.js";
import { invalidateSettingsCache } from "../settings.js";
import { createAgentSession, SettingsManager } from "@earendil-works/pi-coding-agent";

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
  SettingsManager: { create: vi.fn(() => ({ getDefaultProjectTrust: () => "ask" })) },
  SessionManager: { inMemory: vi.fn() },
  ProjectTrustStore: class {
    get() {
      return null;
    }
  },
  hasTrustRequiringProjectResources: () => false,
  parseFrontmatter: () => ({ frontmatter: {}, body: "" }),
}));

beforeEach(() => {
  tmpAgentDir = mkdtempSync(join(tmpdir(), "pi-subagents-orch-agentdir-"));
  tmpCwd = realpathSync(mkdtempSync(join(tmpdir(), "pi-subagents-orch-cwd-")));
  invalidateSettingsCache();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  if (existsSync(tmpAgentDir)) rmSync(tmpAgentDir, { recursive: true, force: true });
  if (existsSync(tmpCwd)) rmSync(tmpCwd, { recursive: true, force: true });
});

// ─── Harness ─────────────────────────────────────────────────────────────

type Emitted = { channel: string; data: any };

function fakePi() {
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
    appendEntry: vi.fn(),
  };
  const ACTIONS: Record<string, string> = {
    AgentStatus: "status",
    AgentMessages: "messages",
    AgentList: "list",
    AgentCancel: "cancel",
    AgentWait: "wait",
    AgentReply: "reply",
    AgentSteer: "steer",
  };
  const tool = (name: string) => {
    const action = ACTIONS[name];
    if (!action) return tools.find((t) => t.name === name);
    const control = tools.find((t) => t.name === "AgentControl");
    return control && {
      name,
      execute: (id: string, params: any, ...rest: any[]) => control.execute(id, { action, ...params }, ...rest),
    };
  };
  const fire = async (event: string, payload: unknown = {}) => {
    for (const h of lifecycle.get(event) ?? []) await h(payload, {});
  };
  return { pi, emitted, tools, tool, fire };
}

export interface FakeHandle {
  session: any;
  opts: any;
  emit(e: any): void;
  /** End the current run with a final assistant message. */
  finish(final?: any): void;
  /** Number of prompt() runs started. */
  runs(): number;
}

const ALL_TOOLS = ["Read", "Agent", "AgentControl"];

function makeFakeSession(opts: any): FakeHandle {
  let listener: ((e: any) => void) | undefined;
  let resolve: (() => void) | undefined;
  let runs = 0;
  const emit = (e: any) => listener?.(e);
  const finish = (final?: any) => {
    if (!resolve) return;
    const r = resolve;
    resolve = undefined;
    emit({
      type: "message_end",
      message: final
        ? { role: "assistant", ...final }
        : { role: "assistant", stopReason: "stop", content: [{ type: "text", text: `done ${runs}` }] },
    });
    r();
  };
  const custom = (opts?.customTools ?? []).map((t: any) => t.name);
  const session: any = {
    model: { id: "mock-model" },
    getActiveToolNames: () => [...ALL_TOOLS, ...custom],
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
          runs += 1;
          session.lastPrompt = text;
          resolve = res;
        }),
    ),
    steer: vi.fn(async () => "queued"),
    followUp: vi.fn(async () => "queued"),
    dispose: vi.fn(),
    abort: vi.fn(async () => finish({ stopReason: "aborted", content: [] })),
  };
  return { session, opts, emit, finish, runs: () => runs };
}

function installSessions() {
  const created: FakeHandle[] = [];
  (createAgentSession as any).mockReset();
  (createAgentSession as any).mockImplementation(async (opts: any) => {
    const h = makeFakeSession(opts);
    created.push(h);
    return { session: h.session };
  });
  return created;
}

function writeConfig(patch: Record<string, unknown>): void {
  const dir = join(tmpAgentDir, "extensions", "pi-dashboard-subagents");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "config.json"), JSON.stringify(patch), "utf-8");
  invalidateSettingsCache();
}

async function tick(n = 40): Promise<void> {
  for (let i = 0; i < n; i++) await Promise.resolve();
}

const ctx = () => ({ cwd: tmpCwd, isIdle: () => true }) as any;
const call = (tool: any, params: Record<string, unknown>, signal?: AbortSignal, onUpdate?: any) =>
  tool.execute(`tc-${Math.random()}`, { subagent_type: "t", description: "d", prompt: "p", ...params }, signal, onUpdate, ctx());
const exec = (tool: any, params: Record<string, unknown>, signal?: AbortSignal) =>
  tool.execute(`tc-${Math.random()}`, params, signal, undefined, ctx());
const ofChannel = (emitted: Emitted[], ch: string) => emitted.filter((e) => e.channel === ch).map((e) => e.data);
const text = (res: any): string => res.content.map((c: any) => c.text).join("\n");

// ─── 3. Agent.cwd ────────────────────────────────────────────────────────

describe("Agent.cwd (subagent-cwd)", () => {
  it("schema exposes an optional cwd", () => {
    const { pi, tool } = fakePi();
    activate(pi);
    const params = tool("Agent").parameters;
    expect(params.properties.cwd.type).toBe("string");
    expect(params.required).not.toContain("cwd");
  });

  it("a rejected cwd creates no record, event or session", async () => {
    installSessions();
    const { pi, tool, emitted } = fakePi();
    activate(pi);
    const res = await call(tool("Agent"), { cwd: "does-not-exist" });
    expect(res.isError).toBe(true);
    expect(text(res)).toContain("cwd_not_found");
    expect(emitted.filter((e) => e.channel.startsWith("subagents:"))).toEqual([]);
    expect(createAgentSession).not.toHaveBeenCalled();
    const list = await exec(tool("AgentList"), {});
    expect(list.details.agents).toEqual([]);
  });

  it("a relative cwd drives the session, loader and every lifecycle payload", async () => {
    const created = installSessions();
    mkdirSync(join(tmpCwd, "wt"));
    const child = join(tmpCwd, "wt");
    const { pi, tool, emitted } = fakePi();
    activate(pi);
    const p = call(tool("Agent"), { cwd: "wt" });
    await tick();
    expect(created).toHaveLength(1);
    expect(created[0]!.opts.cwd).toBe(child);
    expect(created[0]!.opts.resourceLoader.opts.cwd).toBe(child);
    created[0]!.finish();
    const res = await p;
    expect(res.details.cwd).toBe(child);
    for (const ch of ["subagents:created", "subagents:started", "subagents:completed"]) {
      for (const d of ofChannel(emitted, ch)) expect(d.details.cwd).toBe(child);
    }
  });

  it("one trust-resolved SettingsManager is shared by the loader and the session (D3)", async () => {
    const created = installSessions();
    const { pi, tool } = fakePi();
    activate(pi);
    const p = call(tool("Agent"), {});
    await tick();
    expect(SettingsManager.create).toHaveBeenCalledWith(tmpCwd, tmpAgentDir, { projectTrusted: true });
    const sm = created[0]!.opts.settingsManager;
    expect(sm).toBeDefined();
    expect(created[0]!.opts.resourceLoader.opts.settingsManager).toBe(sm);
    created[0]!.finish();
    await p;
  });

  it("background status and list report the cwd", async () => {
    const created = installSessions();
    mkdirSync(join(tmpCwd, "wt"));
    const { pi, tool } = fakePi();
    activate(pi);
    const bg = await call(tool("Agent"), { cwd: "wt", run_in_background: true });
    await tick();
    const st = await exec(tool("AgentStatus"), { ids: [bg.details.id] });
    expect(st.details.agents[0].cwd).toBe(join(tmpCwd, "wt"));
    expect(text(st)).toContain(join(tmpCwd, "wt"));
    const list = await exec(tool("AgentList"), {});
    expect(list.details.agents[0].cwd).toBe(join(tmpCwd, "wt"));
    created[0]!.finish();
    await tick();
  });
});

// ─── 5. Idle lifecycle ───────────────────────────────────────────────────

describe("idle lifecycle (D5)", () => {
  async function spawnBg(tool: any, params: Record<string, unknown> = {}) {
    const res = await call(tool("Agent"), { run_in_background: true, ...params });
    await tick();
    return res.details.id as string;
  }

  it("a finished background run parks idle: result readable, session alive, idle event", async () => {
    const created = installSessions();
    const { pi, tool, emitted } = fakePi();
    activate(pi);
    const id = await spawnBg(tool);
    created[0]!.finish();
    await tick();
    const st = await exec(tool("AgentStatus"), { ids: [id] });
    expect(st.details.agents[0]).toMatchObject({ status: "idle", result: "done 1" });
    expect(created[0]!.session.dispose).not.toHaveBeenCalled();
    expect(ofChannel(emitted, "subagents:idle")).toEqual([expect.objectContaining({ id, run: 1 })]);
  });

  it("idle releases the concurrency slot", async () => {
    writeConfig({ maxConcurrent: 1 });
    const created = installSessions();
    const { pi, tool } = fakePi();
    activate(pi);
    await spawnBg(tool);
    const b = await spawnBg(tool);
    expect(created).toHaveLength(1);
    created[0]!.finish();
    await tick();
    expect(created).toHaveLength(2);
    const st = await exec(tool("AgentStatus"), { ids: [b] });
    expect(st.details.agents[0].status).toBe("running");
    created[1]!.finish();
    await tick();
  });

  it("idle satisfies AgentStatus wait: all", async () => {
    const created = installSessions();
    const { pi, tool } = fakePi();
    activate(pi);
    const id = await spawnBg(tool);
    const waiting = exec(tool("AgentStatus"), { ids: [id], wait: "all", timeout_s: 30 });
    created[0]!.finish();
    const st = await waiting;
    expect(st.details.timedOut).toBeUndefined();
    expect(st.details.agents[0]).toMatchObject({ status: "idle", result: "done 1" });
  });

  it("idle subagents do not count toward maxBackgroundPending", async () => {
    writeConfig({ maxBackgroundPending: 1 });
    const created = installSessions();
    const { pi, tool } = fakePi();
    activate(pi);
    await spawnBg(tool);
    created[0]!.finish();
    await tick();
    const res = await call(tool("Agent"), { run_in_background: true });
    expect(res.isError).toBeFalsy();
    await tick();
    created[1]!.finish();
    await tick();
  });

  it("idle TTL disposes the session with reason ttl; result stays readable", async () => {
    writeConfig({ backgroundIdleTtlSec: 5 });
    vi.useFakeTimers();
    const created = installSessions();
    const { pi, tool, emitted } = fakePi();
    activate(pi);
    const id = await spawnBg(tool);
    created[0]!.finish();
    await tick();
    vi.advanceTimersByTime(5_000);
    await tick();
    expect(created[0]!.session.dispose).toHaveBeenCalled();
    expect(ofChannel(emitted, "subagents:disposed")).toEqual([expect.objectContaining({ id, reason: "ttl" })]);
    vi.useRealTimers();
    const st = await exec(tool("AgentStatus"), { ids: [id] });
    expect(st.details.agents[0]).toMatchObject({ status: "completed", result: "done 1" });
  });

  it("maxIdleBackground evicts the oldest idle subagent", async () => {
    writeConfig({ maxIdleBackground: 1 });
    const created = installSessions();
    const { pi, tool, emitted } = fakePi();
    activate(pi);
    const a = await spawnBg(tool);
    const b = await spawnBg(tool);
    created[0]!.finish();
    await tick();
    created[1]!.finish();
    await tick();
    expect(created[0]!.session.dispose).toHaveBeenCalled();
    expect(created[1]!.session.dispose).not.toHaveBeenCalled();
    expect(ofChannel(emitted, "subagents:disposed")).toEqual([expect.objectContaining({ id: a, reason: "cap" })]);
    const list = await exec(tool("AgentList"), {});
    expect(list.details.agents.find((x: any) => x.id === b).status).toBe("idle");
  });

  it("backgroundIdleTtlSec: 0 keeps dispose-on-finish", async () => {
    writeConfig({ backgroundIdleTtlSec: 0 });
    const created = installSessions();
    const { pi, tool, emitted } = fakePi();
    activate(pi);
    const id = await spawnBg(tool);
    created[0]!.finish();
    await tick();
    expect(created[0]!.session.dispose).toHaveBeenCalled();
    expect(ofChannel(emitted, "subagents:idle")).toEqual([]);
    const st = await exec(tool("AgentStatus"), { ids: [id] });
    expect(st.details.agents[0]).toMatchObject({ status: "completed", result: "done 1" });
  });

  it("AgentCancel disposes an idle subagent (outcome disposed) and filters by status idle", async () => {
    const created = installSessions();
    const { pi, tool, emitted } = fakePi();
    activate(pi);
    const a = await spawnBg(tool);
    const b = await spawnBg(tool);
    created[0]!.finish();
    await tick();
    const res = await exec(tool("AgentCancel"), { ids: "all", status: "idle" });
    expect(res.details.results).toEqual([{ id: a, outcome: "disposed" }]);
    await tick();
    expect(created[0]!.session.dispose).toHaveBeenCalled();
    expect(ofChannel(emitted, "subagents:disposed")).toEqual([expect.objectContaining({ id: a, reason: "cancel" })]);
    const st = await exec(tool("AgentStatus"), { ids: [a, b] });
    expect(st.details.agents[0]).toMatchObject({ status: "completed", result: "done 1" });
    expect(st.details.agents[1].status).toBe("running");
    const again = await exec(tool("AgentCancel"), { ids: [a] });
    expect(again.details.results[0].outcome).toBe("already_finished");
    created[1]!.finish();
    await tick();
  });

  it("subagents:stop on an idle subagent disposes it", async () => {
    const created = installSessions();
    const { pi, tool, emitted } = fakePi();
    activate(pi);
    const id = await spawnBg(tool);
    created[0]!.finish();
    await tick();
    const agentId = (await exec(tool("AgentStatus"), { ids: [id] })).details.agents[0].agentId;
    pi.events.emit("subagents:stop", { agentId });
    await tick();
    expect(created[0]!.session.dispose).toHaveBeenCalled();
    expect(ofChannel(emitted, "subagents:disposed")).toEqual([expect.objectContaining({ id, reason: "cancel" })]);
  });

  it("session_shutdown disposes idle subagents with reason shutdown", async () => {
    const created = installSessions();
    const { pi, tool, emitted, fire } = fakePi();
    activate(pi);
    const id = await spawnBg(tool);
    created[0]!.finish();
    await tick();
    await fire("session_shutdown");
    await tick();
    expect(created[0]!.session.dispose).toHaveBeenCalled();
    expect(ofChannel(emitted, "subagents:disposed")).toEqual([expect.objectContaining({ id, reason: "shutdown" })]);
  });
});

describe("liveness line (5.3)", () => {
  it("AgentStatus and AgentList carry run, turns and cwd", async () => {
    const created = installSessions();
    const { pi, tool } = fakePi();
    activate(pi);
    const res = await call(tool("Agent"), { run_in_background: true });
    await tick();
    const id = res.details.id;
    created[0]!.emit({ type: "message_end", message: { role: "assistant", stopReason: "toolUse", content: [] } });
    await new Promise((r) => setTimeout(r, 300)); // progress throttle
    const st = await exec(tool("AgentStatus"), { ids: [id] });
    expect(st.details.agents[0]).toMatchObject({ run: 1, turns: 1, cwd: tmpCwd });
    expect(text(st)).toMatch(/run 1/);
    expect(text(st)).toMatch(/turn 1/);
    const list = await exec(tool("AgentList"), {});
    expect(list.details.agents[0]).toMatchObject({ run: 1 });
    expect(text(list)).toMatch(/run 1/);
    created[0]!.finish();
    await tick();
    expect(text(await exec(tool("AgentList"), {}))).toMatch(/1 idle/);
  });
});

// ─── 5.4 One AgentControl tool (D0) ──────────────────────────────────────

describe("AgentControl (D0)", () => {
  it("registers exactly Agent + AgentControl", () => {
    const { pi, tools } = fakePi();
    activate(pi);
    expect(tools.map((t) => t.name)).toEqual(["Agent", "AgentControl"]);
    const p = tools[1].parameters;
    expect(p.required).toEqual(["action"]);
    expect(p.properties.action.enum ?? p.properties.action.anyOf?.map((x: any) => x.const)).toEqual([
      "status",
      "list",
      "messages",
      "cancel",
      "wait",
      "reply",
      "steer",
    ]);
  });

  it("unknown action → error listing the valid actions", async () => {
    const { pi, tools } = fakePi();
    activate(pi);
    const res = await exec(tools[1], { action: "explode" });
    expect(res.isError).toBe(true);
    expect(text(res)).toMatch(/status, list, messages, cancel, wait, reply, steer/);
  });

  it("missing parameters → error naming them", async () => {
    const { pi, tools } = fakePi();
    activate(pi);
    const st = await exec(tools[1], { action: "status" });
    expect(st.isError).toBe(true);
    expect(text(st)).toMatch(/ids/);
    const msg = await exec(tools[1], { action: "messages" });
    expect(text(msg)).toMatch(/\bid\b/);
    const cancel = await exec(tools[1], { action: "cancel" });
    expect(text(cancel)).toMatch(/ids/);
    const reply = await exec(tools[1], { action: "reply" });
    expect(text(reply)).toMatch(/question_id/);
    const steer = await exec(tools[1], { action: "steer", id: "bg-x" });
    expect(text(steer)).toMatch(/message/);
  });

  it("the description marks messages as debug-only and steer as background-only", () => {
    const { pi, tools } = fakePi();
    activate(pi);
    const d: string = tools[1].description;
    expect(d).toMatch(/messages.*debug/i);
    expect(d).toMatch(/only background/i);
  });

  it("children exclude Agent and AgentControl", async () => {
    const created = installSessions();
    const { pi, tool } = fakePi();
    activate(pi);
    const p = call(tool("Agent"), {});
    await tick();
    const active = created[0]!.session.setActiveToolsByName.mock.calls[0][0];
    expect(active).not.toContain("Agent");
    expect(active).not.toContain("AgentControl");
    created[0]!.finish();
    await p;
  });
});

// ─── 6–8. Mailbox, ask_parent, reply, steer (spawn level) ────────────────

const askTool = (h: FakeHandle) => h.opts.customTools?.find((t: any) => t.name === "ask_parent");
const ask = (h: FakeHandle, question: string, signal?: AbortSignal) =>
  askTool(h).execute(`ask-${Math.random()}`, { question }, signal);
async function bg(tool: any, params: Record<string, unknown> = {}) {
  const res = await call(tool("Agent"), { run_in_background: true, ...params });
  await tick();
  return res.details.id as string;
}

describe("push to the parent (6.3)", () => {
  it("a finished run is pushed once as a followUp that may trigger a turn", async () => {
    vi.useFakeTimers();
    const created = installSessions();
    const { pi, tool, emitted } = fakePi();
    activate(pi);
    const id = await bg(tool);
    created[0]!.finish({ role: "assistant", stopReason: "stop", content: [{ type: "text", text: "ALL DONE" }] });
    await tick();
    expect(pi.sendMessage).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1_000);
    expect(pi.sendMessage).toHaveBeenCalledTimes(1);
    const [msg, opts] = pi.sendMessage.mock.calls[0];
    expect(opts).toEqual({ deliverAs: "followUp", triggerTurn: true });
    expect(msg.content).toContain(id);
    expect(msg.content).toContain("ALL DONE");
    expect(ofChannel(emitted, "subagents:push")).toHaveLength(1);
  });

  it("notifyParent: false never sends", async () => {
    writeConfig({ notifyParent: false });
    vi.useFakeTimers();
    const created = installSessions();
    const { pi, tool } = fakePi();
    activate(pi);
    await bg(tool);
    created[0]!.finish();
    await tick();
    vi.advanceTimersByTime(10_000);
    expect(pi.sendMessage).not.toHaveBeenCalled();
    expect(pi.sendUserMessage).not.toHaveBeenCalled();
  });
});

describe("ask_parent + wait + reply (7)", () => {
  it("only background children get ask_parent; it stays active", async () => {
    const created = installSessions();
    const { pi, tool } = fakePi();
    activate(pi);
    const fg = call(tool("Agent"), {});
    await tick();
    expect(askTool(created[0]!)).toBeUndefined();
    created[0]!.finish();
    await fg;
    await bg(tool);
    expect(askTool(created[1]!)).toBeDefined();
    const active = created[1]!.session.setActiveToolsByName.mock.calls[0][0];
    expect(active).toContain("ask_parent");
    created[1]!.finish();
    await tick();
  });

  it("round trip: ask blocks, wait returns it with reply instructions, reply unblocks with the answer", async () => {
    writeConfig({ notifyParent: false });
    const created = installSessions();
    const { pi, tool, emitted } = fakePi();
    activate(pi);
    const id = await bg(tool, { cwd: "." });
    let settled = false;
    const pending = ask(created[0]!, "JWT or session cookie?").then((r: any) => {
      settled = true;
      return r;
    });
    await tick();
    expect(settled).toBe(false);
    const w = await exec(tool("AgentWait"), {});
    expect(w.details.entries).toEqual([
      expect.objectContaining({ id, kind: "question", question_id: "q1", text: "JWT or session cookie?" }),
    ]);
    expect(text(w)).toContain("BLOCKED");
    expect(text(w)).toContain(`AgentControl({ action: "reply", id: "${id}", question_id: "q1"`);
    const st = await exec(tool("AgentStatus"), { ids: [id] });
    expect(text(st)).toContain(`⏸asking q1`);
    expect(text(st)).toContain(`AgentControl(reply ${id} q1)`);
    const r = await exec(tool("AgentReply"), { id, question_id: "q1", answer: "JWT" });
    expect(r.details.results).toEqual([{ id, question_id: "q1", result: "answered" }]);
    const res = await pending;
    expect(res.content[0].text).toBe("JWT");
    // event order for one ask (9.2)
    const order = emitted
      .filter((e) => ["subagents:question", "subagents:mail", "subagents:slot", "subagents:answer"].includes(e.channel))
      .filter((e) => e.data.kind !== "outcome")
      .map((e) => (e.channel === "subagents:slot" ? `slot:${e.data.action}` : e.channel));
    expect(order).toEqual([
      "subagents:question",
      "subagents:mail",
      "slot:released",
      "subagents:answer",
      "slot:reacquired",
    ]);
    expect(JSON.stringify(emitted.filter((e) => e.channel !== "subagents:entry"))).not.toContain("session cookie");
    created[0]!.finish();
    await tick();
  });

  it("batch reply answers parallel askers independently; a bad entry does not fail the batch", async () => {
    writeConfig({ notifyParent: false });
    const created = installSessions();
    const { pi, tool } = fakePi();
    activate(pi);
    const a = await bg(tool);
    const b = await bg(tool);
    const pa = ask(created[0]!, "qa?");
    const pb = ask(created[1]!, "qb?");
    await tick();
    const w = await exec(tool("AgentWait"), {});
    expect(w.details.entries.map((e: any) => e.question_id)).toEqual(["q1", "q2"]);
    expect(text(w)).toContain("answer all at once");
    const r = await exec(tool("AgentReply"), {
      replies: [
        { id: a, question_id: "q1", answer: "A" },
        { id: b, question_id: "q2", answer: "B" },
        { id: a, question_id: "q9", answer: "?" },
      ],
    });
    expect(r.details.results.map((x: any) => x.result)).toEqual(["answered", "answered", "not_pending"]);
    expect((await pa).content[0].text).toBe("A");
    expect((await pb).content[0].text).toBe("B");
    created.forEach((c) => c.finish());
    await tick();
  });

  it("parallel askers release their slots: queued work starts (D12)", async () => {
    writeConfig({ maxConcurrent: 1, notifyParent: false });
    const created = installSessions();
    const { pi, tool, emitted } = fakePi();
    activate(pi);
    const a = await bg(tool);
    const b = await bg(tool);
    expect(created).toHaveLength(1);
    const pa = ask(created[0]!, "blocked?");
    await tick();
    expect(created).toHaveLength(2); // bg-b got the slot
    const c = await bg(tool); // queued behind bg-b
    // answer bg-a: it re-queues on the resume lane ahead of bg-c
    await exec(tool("AgentReply"), { id: a, question_id: "q1", answer: "go" });
    await tick();
    expect(ofChannel(emitted, "subagents:slot").map((s) => s.action)).toEqual(["released", "reacquire_queued"]);
    created[1]!.finish(); // bg-b ends → slot to bg-a (not bg-c)
    await tick();
    expect((await pa).content[0].text).toBe("go");
    expect(created).toHaveLength(2);
    const st = await exec(tool("AgentStatus"), { ids: [b, c] });
    expect(st.details.agents.map((x: any) => x.status)).toEqual(["idle", "queued"]);
    created[0]!.finish(); // bg-a ends → bg-c starts
    await tick();
    expect(created).toHaveLength(3);
    created[2]!.finish();
    await tick();
  });

  for (const how of ["AgentControl cancel", "subagents:stop"] as const) {
    it(`manual kill while asking (${how}) settles the ask, stops the child, leaks no slot`, async () => {
      writeConfig({ maxConcurrent: 1, notifyParent: false });
      const created = installSessions();
      const { pi, tool, emitted } = fakePi();
      activate(pi);
      const a = await bg(tool);
      const pending = ask(created[0]!, "never answered?").catch((e: unknown) => e);
      await tick();
      if (how === "AgentControl cancel") {
        const res = await exec(tool("AgentCancel"), { ids: [a] });
        expect(res.details.results).toEqual([{ id: a, outcome: "stopped" }]);
      } else {
        const agentId = (await exec(tool("AgentStatus"), { ids: [a] })).details.agents[0].agentId;
        pi.events.emit("subagents:stop", { agentId });
      }
      await tick();
      expect(await pending).toBeInstanceOf(Error);
      expect(ofChannel(emitted, "subagents:answer")).toEqual([expect.objectContaining({ via: "cancel" })]);
      const st = await exec(tool("AgentStatus"), { ids: [a] });
      expect(st.details.agents[0].status).toBe("stopped");
      // the slot is free: a new spawn starts at once
      await bg(tool);
      expect(created).toHaveLength(2);
      created[1]!.finish();
      await tick();
    });
  }
});

describe("steer (8)", () => {
  it("running child: steer / followUp go to the live session", async () => {
    const created = installSessions();
    const { pi, tool, emitted } = fakePi();
    activate(pi);
    const id = await bg(tool);
    const s1 = await exec(tool("AgentSteer"), { id, message: "skip e2e", mode: "steer" });
    expect(s1.details.results).toEqual([{ id, result: "queued" }]);
    expect(created[0]!.session.steer).toHaveBeenCalledWith("skip e2e");
    const s2 = await exec(tool("AgentSteer"), { id, message: "then summarize", mode: "followUp" });
    expect(s2.details.results[0].result).toBe("queued");
    expect(created[0]!.session.followUp).toHaveBeenCalledWith("then summarize");
    expect(ofChannel(emitted, "subagents:steer").map((e) => [e.mode, e.result])).toEqual([
      ["steer", "queued"],
      ["followUp", "queued"],
    ]);
    expect(JSON.stringify(ofChannel(emitted, "subagents:steer"))).not.toContain("skip e2e");
    created[0]!.finish();
    await tick();
  });

  it("idle child: continues on the same session as run 2 with a new outcome", async () => {
    writeConfig({ notifyParent: false });
    const created = installSessions();
    const { pi, tool } = fakePi();
    activate(pi);
    const id = await bg(tool);
    created[0]!.finish();
    await tick();
    const s = await exec(tool("AgentSteer"), { id, message: "now add tests", mode: "followUp" });
    expect(s.details.results).toEqual([{ id, result: "started" }]);
    await tick();
    expect(created).toHaveLength(1);
    expect(created[0]!.session.prompt).toHaveBeenLastCalledWith("now add tests");
    const mid = await exec(tool("AgentStatus"), { ids: [id] });
    expect(mid.details.agents[0]).toMatchObject({ status: "running", run: 2 });
    created[0]!.finish();
    await tick();
    const w = await exec(tool("AgentWait"), {});
    expect(w.details.entries.map((e: any) => [e.kind, e.run])).toEqual([
      ["outcome", 1],
      ["outcome", 2],
    ]);
    const end = await exec(tool("AgentStatus"), { ids: [id] });
    expect(end.details.agents[0]).toMatchObject({ status: "idle", run: 2, result: "done 2" });
  });

  it("idle child with no free slot → queued, starts when one frees", async () => {
    writeConfig({ maxConcurrent: 1, notifyParent: false });
    const created = installSessions();
    const { pi, tool } = fakePi();
    activate(pi);
    const a = await bg(tool);
    created[0]!.finish();
    await tick();
    await bg(tool); // takes the only slot
    const s = await exec(tool("AgentSteer"), { id: a, message: "more", mode: "steer" });
    expect(s.details.results[0].result).toBe("queued");
    created[1]!.finish();
    await tick();
    expect(created[0]!.session.prompt).toHaveBeenLastCalledWith("more");
    created[0]!.finish();
    await tick();
  });

  it("broadcast routes each id: running → queued, idle → started, disposed → not_alive, unknown → not_found", async () => {
    const created = installSessions();
    const { pi, tool } = fakePi();
    activate(pi);
    const run = await bg(tool);
    const idle = await bg(tool);
    const gone = await bg(tool);
    created[1]!.finish();
    created[2]!.finish();
    await tick();
    await exec(tool("AgentCancel"), { ids: [gone] });
    await tick();
    const s = await exec(tool("AgentSteer"), { ids: [run, idle, gone, "bg-nope"], message: "use JWT", mode: "steer" });
    expect(s.details.results).toEqual([
      { id: run, result: "queued" },
      { id: idle, result: "started" },
      { id: gone, result: "not_alive" },
      { id: "bg-nope", result: "not_found" },
    ]);
    created.forEach((c) => c.finish());
    await tick();
  });

  it("queued (not started) → not_started; foreground → foreground", async () => {
    writeConfig({ maxConcurrent: 1 });
    const created = installSessions();
    const { pi, tool, emitted } = fakePi();
    activate(pi);
    const fg = call(tool("Agent"), {});
    await tick();
    const fgId = ofChannel(emitted, "subagents:created")[0].id;
    const q = await bg(tool);
    const s = await exec(tool("AgentSteer"), { ids: [q, fgId], message: "x" });
    expect(s.details.results).toEqual([
      { id: q, result: "not_started" },
      { id: fgId, result: "foreground" },
    ]);
    expect(text(s)).toMatch(/Only background subagents can be steered/);
    created[0]!.finish();
    await fg;
    await tick();
    created[1]!.finish();
    await tick();
  });

  it("the run-time limit applies to run 2 as well (8.2)", async () => {
    writeConfig({ notifyParent: false });
    const created = installSessions();
    const { pi, tool } = fakePi();
    activate(pi);
    const id = await bg(tool, { timeout_s: 5 });
    created[0]!.finish();
    await tick();
    vi.useFakeTimers();
    await exec(tool("AgentSteer"), { id, message: "again" });
    await tick();
    vi.advanceTimersByTime(5_000);
    await tick();
    vi.useRealTimers();
    await tick();
    const st = await exec(tool("AgentStatus"), { ids: [id] });
    expect(st.details.agents[0]).toMatchObject({ status: "stopped", stoppedBy: "timeout", run: 2 });
  });
});

// ─── 9.1 Persistence ─────────────────────────────────────────────────────

describe("persistence (9.1)", () => {
  it("each finished background run appends one subagents:run entry; after a reload the id is not_alive", async () => {
    writeConfig({ notifyParent: false });
    const created = installSessions();
    const { pi, tool } = fakePi();
    activate(pi);
    const id = await bg(tool, { cwd: "." });
    created[0]!.finish();
    await tick();
    await exec(tool("AgentSteer"), { id, message: "again" });
    await tick();
    created[0]!.finish();
    await tick();
    const runs = pi.appendEntry.mock.calls.filter((c: any[]) => c[0] === "subagents:run").map((c: any[]) => c[1]);
    expect(runs.map((r: any) => [r.id, r.run, r.status, r.cwd])).toEqual([
      [id, 1, "completed", tmpCwd],
      [id, 2, "completed", tmpCwd],
    ]);
    expect(runs[1].result).toBe("done 2");

    // Reload: a fresh activation sees only the parent JSONL.
    const entries = runs.map((data: any) => ({ type: "custom", customType: "subagents:run", data }));
    const reloaded = fakePi();
    activate(reloaded.pi);
    const rctx = { cwd: tmpCwd, sessionManager: { getEntries: () => entries } } as any;
    const control = reloaded.tools.find((t: any) => t.name === "AgentControl");
    const steer = await control.execute("t", { action: "steer", id, message: "x" }, undefined, undefined, rctx);
    expect(steer.details.results).toEqual([{ id, result: "not_alive" }]);
    expect(text(steer)).toMatch(/not alive|reload/i);
    const reply = await control.execute(
      "t",
      { action: "reply", id, question_id: "q1", answer: "x" },
      undefined,
      undefined,
      rctx,
    );
    expect(reply.details.results[0].result).toBe("not_alive");
    const unknown = await control.execute("t", { action: "steer", id: "bg-zzzzzz", message: "x" }, undefined, undefined, rctx);
    expect(unknown.details.results[0].result).toBe("not_found");
  });
});
