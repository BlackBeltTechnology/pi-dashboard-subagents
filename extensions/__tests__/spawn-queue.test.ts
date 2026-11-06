/**
 * Spawn-queue control: per-subagent stop (`subagents:stop`), queue info on
 * snapshots, batched position pushes, live `maxConcurrent` re-check and fair
 * granting. Own file so the process-wide semaphore state is isolated.
 *
 * See change: manage-subagent-spawn-queue.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import activate, { createAgentControlRegistry, runAgentTool } from "../agent.js";
import { invalidateSettingsCache } from "../settings.js";
import { createAgentSession } from "@earendil-works/pi-coding-agent";

let tmpAgentDir: string;
let tmpCwd: string;

const MockResourceLoader = vi.hoisted(() => {
  class MockResourceLoader {
    static instances: MockResourceLoader[] = [];
    /** Awaited inside reload() when set — lets a test hold reload open. */
    static reloadGate: Promise<void> | undefined;
    opts: Record<string, unknown>;
    reload: ReturnType<typeof vi.fn>;
    constructor(opts: Record<string, unknown>) {
      this.opts = opts;
      this.reload = vi.fn(async () => {
        if (MockResourceLoader.reloadGate) await MockResourceLoader.reloadGate;
      });
      MockResourceLoader.instances.push(this);
    }
  }
  return MockResourceLoader;
});

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
  tmpAgentDir = mkdtempSync(join(tmpdir(), "pi-subagents-queue-agentdir-"));
  tmpCwd = mkdtempSync(join(tmpdir(), "pi-subagents-queue-cwd-"));
  MockResourceLoader.instances = [];
  MockResourceLoader.reloadGate = undefined;
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

/** pi handle with a minimal working event bus (emit + on). */
function fakePi() {
  const emitted: Emitted[] = [];
  const handlers = new Map<string, Array<(d: unknown) => void>>();
  const tools: any[] = [];
  const pi: any = {
    events: {
      emit: vi.fn((channel: string, data: any) => {
        emitted.push({ channel, data });
        for (const h of handlers.get(channel) ?? []) h(data);
      }),
      on: vi.fn((channel: string, h: (d: unknown) => void) => {
        const list = handlers.get(channel) ?? [];
        list.push(h);
        handlers.set(channel, list);
        return () => handlers.set(channel, (handlers.get(channel) ?? []).filter((x) => x !== h));
      }),
    },
    registerTool: (t: any) => tools.push(t),
    on: () => {},
  };
  return { pi, emitted, tools };
}

const ctx = () => ({ cwd: tmpCwd }) as any;
const args = (prompt: string) => ({ subagent_type: "t", description: "d", prompt });

interface FakeHandle {
  session: any;
  opts?: any;
  emit(e: any): void;
  finish(final?: any): void;
}

/** A fake child session whose `abort()` ends the run like pi does. */
function makeFakeSession(partialOnAbort?: string): FakeHandle {
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
    getActiveToolNames: () => ["Read", "Agent"],
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
    abort: vi.fn(async () => {
      finish({
        stopReason: "aborted",
        content: partialOnAbort ? [{ type: "text", text: partialOnAbort }] : [],
      });
    }),
  };
  return { session, emit, finish };
}

function installSessions(opts: { partialOnAbort?: string; gate?: Promise<void> } = {}) {
  const created: FakeHandle[] = [];
  (createAgentSession as any).mockReset();
  (createAgentSession as any).mockImplementation(async (o: any) => {
    const h = makeFakeSession(opts.partialOnAbort);
    h.opts = o;
    created.push(h);
    if (opts.gate) await opts.gate;
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

/** Drain microtasks (works under real and fake timers). */
async function tick(n = 40): Promise<void> {
  for (let i = 0; i < n; i++) await Promise.resolve();
}

const ofChannel = (emitted: Emitted[], ch: string) => emitted.filter((e) => e.channel === ch).map((e) => e.data);
const terminalFor = (emitted: Emitted[], id: string) =>
  emitted.filter(
    (e) => (e.channel === "subagents:completed" || e.channel === "subagents:failed") && e.data.id === id,
  );
const createdIds = (emitted: Emitted[]) => ofChannel(emitted, "subagents:created").map((d) => d.id as string);

/** Start a run with its own onUpdate spy. */
function start(
  pi: any,
  controls: ReturnType<typeof createAgentControlRegistry> | undefined,
  prompt: string,
  signal?: AbortSignal,
) {
  const onUpdate = vi.fn();
  const promise = runAgentTool(tmpCwd, args(prompt), signal, onUpdate, ctx(), pi, `tc-${prompt}`, controls) as Promise<any>;
  return { promise, onUpdate };
}

const lastQueued = (onUpdate: ReturnType<typeof vi.fn>) =>
  onUpdate.mock.calls.map((c) => c[0].details).filter((d: any) => d.status === "queued").at(-1);

// ─── 2. Per-agent controller linked to the parent ────────────────────────

describe("per-agent abort linked to the parent signal", () => {
  it("a parent abort still ends running and queued subagents as aborted", async () => {
    writeConfig({ maxConcurrent: 1 });
    const created = installSessions();
    const { pi, emitted } = fakePi();
    const controls = createAgentControlRegistry();
    const ac = new AbortController();
    const r = start(pi, controls, "r", ac.signal);
    const q = start(pi, controls, "q", ac.signal);
    await tick();
    expect(created.length).toBe(1);

    ac.abort();
    const [rr, qr] = await Promise.all([r.promise, q.promise]);
    expect(rr.details.status).toBe("aborted");
    expect(qr.details.status).toBe("aborted");
    expect(rr.isError).toBe(true);
    expect(qr.isError).toBe(true);
    expect(created.length).toBe(1);
    expect(ofChannel(emitted, "subagents:failed")).toHaveLength(2);
    expect(ofChannel(emitted, "subagents:completed")).toHaveLength(0);
  });

  it("an already-aborted parent yields aborted without a session and without using a slot", async () => {
    writeConfig({ maxConcurrent: 1 });
    const created = installSessions();
    const { pi } = fakePi();
    const ac = new AbortController();
    ac.abort();
    const res = await start(pi, createAgentControlRegistry(), "x", ac.signal).promise;
    expect(res.details.status).toBe("aborted");
    expect(created.length).toBe(0);

    const next = start(pi, undefined, "y");
    await tick();
    expect(created.length).toBe(1); // slot was free
    created[0].finish();
    await next.promise;
  });

  it("removes its parent abort listener after every run (no leak)", async () => {
    writeConfig({ maxConcurrent: 0 });
    const created = installSessions();
    const { pi } = fakePi();
    const ac = new AbortController();
    const add = vi.spyOn(ac.signal, "addEventListener");
    const remove = vi.spyOn(ac.signal, "removeEventListener");
    for (let i = 0; i < 20; i++) {
      const r = start(pi, undefined, `p${i}`, ac.signal);
      await tick();
      created[i].finish();
      await r.promise;
    }
    const added = add.mock.calls.filter((c) => c[0] === "abort").length;
    const removed = remove.mock.calls.filter((c) => c[0] === "abort").length;
    expect(added).toBeGreaterThan(0);
    expect(removed).toBe(added);
  });

  it("leaves outcomes unchanged when nobody stops and marks every snapshot stoppable", async () => {
    writeConfig({ maxConcurrent: 0 });
    const created = installSessions();
    const { pi, emitted } = fakePi();
    const r = start(pi, createAgentControlRegistry(), "p");
    await tick();
    created[0].emit({ type: "turn_start" });
    created[0].finish();
    const res = await r.promise;
    expect(res.details.status).toBe("completed");
    expect(res.isError).toBeUndefined();
    for (const e of emitted) {
      // Only lifecycle snapshots carry details (not steps, pieces or plugin hooks).
      if (e.channel === "subagents:entry" || e.channel === "subagents:delta" || e.channel.startsWith("subagents:before_")) continue;
      expect(e.data.details?.stoppable, e.channel).toBe(true);
    }
    for (const [u] of r.onUpdate.mock.calls) expect(u.details.stoppable).toBe(true);
    expect(res.details.stoppable).toBe(true);
  });

  it("works without a control registry (direct callers) — nothing is stoppable but runs complete", async () => {
    writeConfig({ maxConcurrent: 0 });
    const created = installSessions();
    const { pi } = fakePi();
    const r = start(pi, undefined, "p");
    await tick();
    created[0].finish();
    expect((await r.promise).details.status).toBe("completed");
  });
});

// ─── 3. Registry + subagents:stop semantics ──────────────────────────────

describe("createAgentControlRegistry.stop", () => {
  it("ignores and logs an unknown agentId", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const controls = createAgentControlRegistry();
    expect(controls.stop("nope")).toEqual({ agentId: "nope", phase: "unknown", outcome: "ignored" });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain("subagents:stop");
    expect(warn.mock.calls[0][1]).toMatchObject({ agentId: "nope", phase: "unknown", outcome: "ignored" });
  });

  it.each([undefined, null, 42, {}, ""])("ignores a non-string or empty agentId (%p) without throwing", (bad) => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const controls = createAgentControlRegistry();
    expect(() => controls.stop(bad as any)).not.toThrow();
    expect(controls.stop(bad as any).outcome).toBe("ignored");
  });

  it("ignores a finished subagent and leaves its result untouched", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    writeConfig({ maxConcurrent: 0 });
    const created = installSessions();
    const { pi, emitted } = fakePi();
    const controls = createAgentControlRegistry();
    const r = start(pi, controls, "p");
    await tick();
    created[0].finish();
    const res = await r.promise;
    const id = createdIds(emitted)[0];

    expect(controls.stop(id).outcome).toBe("ignored");
    expect(res.details.status).toBe("completed");
    expect(terminalFor(emitted, id)).toHaveLength(1);
    expect(warn).toHaveBeenCalled();
  });

  it("logs every stop request with agentId, phase and outcome", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    writeConfig({ maxConcurrent: 1 });
    const created = installSessions();
    const { pi, emitted } = fakePi();
    const controls = createAgentControlRegistry();
    const r = start(pi, controls, "r");
    const q = start(pi, controls, "q");
    await tick();
    const [rid, qid] = createdIds(emitted);

    controls.stop(qid);
    controls.stop(rid);
    await Promise.all([r.promise, q.promise]);

    const logs = warn.mock.calls.filter((c) => String(c[0]).includes("subagents:stop")).map((c) => c[1]);
    expect(logs).toEqual([
      { agentId: qid, phase: "queued", outcome: "stopped" },
      { agentId: rid, phase: "running", outcome: "stopped" },
    ]);
    expect(created.length).toBe(1);
  });

  it("removes finished subagents from the registry", async () => {
    writeConfig({ maxConcurrent: 0 });
    const created = installSessions();
    const { pi } = fakePi();
    const controls = createAgentControlRegistry();
    const runs = [start(pi, controls, "a"), start(pi, controls, "b")];
    await tick();
    expect(controls.size()).toBe(2);
    created.forEach((c) => c.finish());
    await Promise.all(runs.map((r) => r.promise));
    expect(controls.size()).toBe(0);
  });
});

// ─── 3. Stopping a queued subagent ───────────────────────────────────────

describe("stopping a queued subagent", () => {
  async function queueOf(n: number) {
    writeConfig({ maxConcurrent: 1 });
    const created = installSessions();
    const { pi, emitted } = fakePi();
    const controls = createAgentControlRegistry();
    const runs = Array.from({ length: n }, (_, i) => start(pi, controls, `p${i}`));
    await tick();
    return { created, pi, emitted, controls, runs, ids: createdIds(emitted) };
  }

  it("removes it without a slot or session and completes it as stopped", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { created, emitted, controls, runs, ids } = await queueOf(4); // R, W1, W2, W3
    expect(created.length).toBe(1);

    expect(controls.stop(ids[2])).toEqual({ agentId: ids[2], phase: "queued", outcome: "stopped" });
    const res = await runs[2].promise;

    expect(res.isError).toBeUndefined();
    expect(res.content[0].text).toBe("Subagent removed from queue before starting.");
    expect(res.details.status).toBe("stopped");
    expect(res.details.stopReason).toBe("queued");
    expect(res.details.queuePosition).toBeUndefined();
    expect(created.length).toBe(1);

    const completed = ofChannel(emitted, "subagents:completed").filter((d) => d.id === ids[2]);
    expect(completed).toHaveLength(1);
    expect(completed[0].details).toMatchObject({ status: "stopped", stopReason: "queued" });
    expect(completed[0].result).toBe("Subagent removed from queue before starting.");
    expect(ofChannel(emitted, "subagents:failed").filter((d) => d.id === ids[2])).toHaveLength(0);

    // The stopped waiter never takes a slot: R → W1 → W3.
    created[0].finish();
    await tick();
    expect(created.length).toBe(2);
    expect(created[1].session.lastPrompt).toContain("p1");
    created[1].finish();
    await tick();
    expect(created.length).toBe(3);
    expect(created[2].session.lastPrompt).toContain("p3");
    created[2].finish();
    await Promise.all(runs.map((r) => r.promise));
    expect(created.length).toBe(3);
  });

  it("renumbers the waiters behind it", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { created, controls, runs, ids } = await queueOf(4);
    expect(lastQueued(runs[3].onUpdate).queuePosition).toBe(3);

    controls.stop(ids[2]);
    await tick();
    expect(lastQueued(runs[1].onUpdate).queuePosition).toBe(1);
    expect(lastQueued(runs[3].onUpdate).queuePosition).toBe(2);

    controls.stop(ids[1]);
    await tick();
    expect(lastQueued(runs[3].onUpdate).queuePosition).toBe(1);

    created[0].finish();
    await tick();
    created[1].finish();
    await Promise.all(runs.map((r) => r.promise));
  });

  it("keeps the first reason when the parent aborts after a queued stop", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    writeConfig({ maxConcurrent: 1 });
    const created = installSessions();
    const { pi, emitted } = fakePi();
    const controls = createAgentControlRegistry();
    const ac = new AbortController();
    const r = start(pi, controls, "r", ac.signal);
    const q = start(pi, controls, "q", ac.signal);
    await tick();
    const [rid, qid] = createdIds(emitted);

    controls.stop(qid);
    ac.abort();
    const [rr, qr] = await Promise.all([r.promise, q.promise]);
    expect(qr.details.status).toBe("stopped");
    expect(rr.details.status).toBe("aborted");
    expect(terminalFor(emitted, qid)).toHaveLength(1);
    expect(terminalFor(emitted, rid)).toHaveLength(1);
    expect(created.length).toBe(1);
  });

  it("can drain a whole forgotten queue one stop at a time", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { created, controls, runs, ids } = await queueOf(20);
    for (const id of ids.slice(1)) controls.stop(id);
    const results = await Promise.all(runs.slice(1).map((r) => r.promise));
    expect(results.every((r) => r.details.status === "stopped" && r.details.stopReason === "queued")).toBe(true);
    expect(created.length).toBe(1);
    created[0].finish();
    expect((await runs[0].promise).details.status).toBe("completed");
    expect(created.length).toBe(1);
  });
});

// ─── 3. Stopping a running subagent ──────────────────────────────────────

describe("stopping a running subagent", () => {
  it("aborts only that child, frees its slot and starts the next waiter", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    writeConfig({ maxConcurrent: 2 });
    const created = installSessions({ partialOnAbort: "partial work" });
    const { pi, emitted } = fakePi();
    const controls = createAgentControlRegistry();
    const r1 = start(pi, controls, "r1");
    const r2 = start(pi, controls, "r2");
    const w1 = start(pi, controls, "w1");
    await tick();
    expect(created.length).toBe(2);
    const [id1] = createdIds(emitted);

    expect(controls.stop(id1)).toEqual({ agentId: id1, phase: "running", outcome: "stopped" });
    const res = await r1.promise;
    await tick();

    expect(created[0].session.abort).toHaveBeenCalledTimes(1);
    expect(created[1].session.abort).not.toHaveBeenCalled();
    expect(created.length).toBe(3);
    expect(created[2].session.lastPrompt).toContain("w1");

    expect(res.isError).toBeUndefined();
    expect(res.details).toMatchObject({ status: "stopped", stopReason: "running" });
    expect(res.content[0].text.startsWith("Subagent stopped by user.")).toBe(true);
    expect(res.content[0].text).toContain("partial work");
    const done = ofChannel(emitted, "subagents:completed").filter((d) => d.id === id1);
    expect(done).toHaveLength(1);
    expect(done[0].details).toMatchObject({ status: "stopped", stopReason: "running" });
    expect(ofChannel(emitted, "subagents:failed")).toHaveLength(0);

    created[1].finish();
    created[2].finish();
    expect((await r2.promise).details.status).toBe("completed");
    expect((await w1.promise).details.status).toBe("completed");
  });

  it("says only 'Subagent stopped by user.' when nothing was produced", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    writeConfig({ maxConcurrent: 0 });
    installSessions();
    const { pi, emitted } = fakePi();
    const controls = createAgentControlRegistry();
    const r = start(pi, controls, "p");
    await tick();
    controls.stop(createdIds(emitted)[0]);
    const res = await r.promise;
    expect(res.content[0].text).toBe("Subagent stopped by user.");
    expect(res.details.status).toBe("stopped");
  });

  it("sends a terminal onUpdate with the stopped status", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    writeConfig({ maxConcurrent: 0 });
    installSessions();
    const { pi, emitted } = fakePi();
    const controls = createAgentControlRegistry();
    const r = start(pi, controls, "p");
    await tick();
    controls.stop(createdIds(emitted)[0]);
    await r.promise;
    expect(r.onUpdate.mock.calls.at(-1)![0].details).toMatchObject({ status: "stopped", stopReason: "running" });
  });

  it("stop after the slot is granted but before the child exists: no prompt, slot released", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    writeConfig({ maxConcurrent: 1 });
    const created = installSessions();
    let open!: () => void;
    MockResourceLoader.reloadGate = new Promise<void>((r) => (open = r));
    const { pi, emitted } = fakePi();
    const controls = createAgentControlRegistry();
    const r = start(pi, controls, "held");
    await tick();
    expect(MockResourceLoader.instances.length).toBe(1); // slot granted, loader reloading

    expect(controls.stop(createdIds(emitted)[0]).phase).toBe("running");
    MockResourceLoader.reloadGate = undefined;
    open();
    const res = await r.promise;
    expect(res.details).toMatchObject({ status: "stopped", stopReason: "running" });
    expect(createAgentSession).not.toHaveBeenCalled();

    const next = start(pi, controls, "next");
    await tick();
    expect(created.length).toBe(1); // slot was released
    created[0].finish();
    await next.promise;
  });

  it("stop while the session is being created: disposed, never prompted, slot released", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    writeConfig({ maxConcurrent: 1 });
    let open!: () => void;
    const created = installSessions({ gate: new Promise<void>((r) => (open = r)) });
    const { pi, emitted } = fakePi();
    const controls = createAgentControlRegistry();
    const r = start(pi, controls, "held");
    await tick();
    expect(created.length).toBe(1);

    controls.stop(createdIds(emitted)[0]);
    open();
    const res = await r.promise;
    expect(res.details.status).toBe("stopped");
    expect(created[0].session.prompt).not.toHaveBeenCalled();
    expect(created[0].session.dispose).toHaveBeenCalled();

    const created2 = installSessions();
    const next = start(pi, controls, "next");
    await tick();
    expect(created2.length).toBe(1);
    created2[0].finish();
    await next.promise;
  });

  it("stop then parent abort: the stopped one stays stopped, the rest end aborted", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    writeConfig({ maxConcurrent: 0 });
    const created = installSessions();
    const { pi, emitted } = fakePi();
    const controls = createAgentControlRegistry();
    const ac = new AbortController();
    const runs = [0, 1, 2].map((i) => start(pi, controls, `p${i}`, ac.signal));
    await tick();
    const ids = createdIds(emitted);

    // Hold the stopped child's abort open so the parent abort lands mid-stop.
    created[0].session.abort = vi.fn(() => new Promise<void>(() => {}));
    controls.stop(ids[0]);
    ac.abort();
    created[0].finish({ stopReason: "aborted", content: [] });
    const res = await Promise.all(runs.map((r) => r.promise));

    expect(res.map((r) => r.details.status)).toEqual(["stopped", "aborted", "aborted"]);
    for (const id of ids) expect(terminalFor(emitted, id)).toHaveLength(1);
  });

  it("parent abort then stop: aborted wins and the stop is ignored", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    writeConfig({ maxConcurrent: 0 });
    const created = installSessions();
    const { pi, emitted } = fakePi();
    const controls = createAgentControlRegistry();
    const ac = new AbortController();
    const r = start(pi, controls, "p", ac.signal);
    await tick();
    created[0].session.abort = vi.fn(() => new Promise<void>(() => {}));
    ac.abort();
    expect(controls.stop(createdIds(emitted)[0]).outcome).toBe("ignored");
    created[0].finish({ stopReason: "aborted", content: [] });
    const res = await r.promise;
    expect(res.details.status).toBe("aborted");
    expect(terminalFor(emitted, createdIds(emitted)[0])).toHaveLength(1);
  });

  it("a second stop for the same subagent is ignored", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    writeConfig({ maxConcurrent: 0 });
    const created = installSessions();
    const { pi, emitted } = fakePi();
    const controls = createAgentControlRegistry();
    const r = start(pi, controls, "p");
    await tick();
    created[0].session.abort = vi.fn(() => new Promise<void>(() => {}));
    const id = createdIds(emitted)[0];
    expect(controls.stop(id).outcome).toBe("stopped");
    expect(controls.stop(id).outcome).toBe("ignored");
    created[0].finish({ stopReason: "aborted", content: [] });
    await r.promise;
    expect(created[0].session.abort).toHaveBeenCalledTimes(1);
    expect(terminalFor(emitted, id)).toHaveLength(1);
  });

  it("does not affect sibling subagents of the same parent turn", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    writeConfig({ maxConcurrent: 0 });
    const created = installSessions();
    const { pi, emitted } = fakePi();
    const controls = createAgentControlRegistry();
    const ac = new AbortController();
    const runs = [0, 1, 2].map((i) => start(pi, controls, `p${i}`, ac.signal));
    await tick();
    controls.stop(createdIds(emitted)[1]);
    created[0].finish();
    created[2].finish();
    const res = await Promise.all(runs.map((r) => r.promise));
    expect(res.map((r) => r.details.status)).toEqual(["completed", "stopped", "completed"]);
    expect(ac.signal.aborted).toBe(false);
  });
});

// ─── 3. Activation wiring ────────────────────────────────────────────────

describe("subagents:stop listener wiring", () => {
  it("activate() listens on subagents:stop and stops the named subagent", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    writeConfig({ maxConcurrent: 0 });
    installSessions();
    const a = fakePi();
    activate(a.pi);
    expect(a.pi.events.on).toHaveBeenCalledWith("subagents:stop", expect.any(Function));

    const run = a.tools[0].execute("call-1", args("p"), undefined, undefined, ctx());
    await tick();
    a.pi.events.emit("subagents:stop", { agentId: createdIds(a.emitted)[0] });
    const res = await run;
    expect(res.details.status).toBe("stopped");
  });

  it("a stop on one session's bus never reaches another session's subagent", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    writeConfig({ maxConcurrent: 0 });
    const created = installSessions();
    const a = fakePi();
    const b = fakePi();
    activate(a.pi);
    activate(b.pi);

    const runB = b.tools[0].execute("call-b", args("b"), undefined, undefined, ctx());
    await tick();
    const bId = createdIds(b.emitted)[0];
    a.pi.events.emit("subagents:stop", { agentId: bId });
    await tick();

    expect(created[0].session.abort).not.toHaveBeenCalled();
    expect(warn.mock.calls.find((c) => String(c[0]).includes("subagents:stop"))?.[1]).toMatchObject({
      agentId: bId,
      outcome: "ignored",
    });
    created[0].finish();
    expect((await runB).details.status).toBe("completed");
  });

  it("tolerates a pi.events without on() (older hosts)", () => {
    const pi: any = { events: { emit: () => {} }, registerTool: () => {}, on: () => {} };
    expect(() => activate(pi)).not.toThrow();
    expect(() => activate({ registerTool: () => {}, on: () => {} } as any)).not.toThrow();
  });

  it("a malformed stop payload does not throw out of the bus", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const a = fakePi();
    activate(a.pi);
    expect(() => a.pi.events.emit("subagents:stop", undefined)).not.toThrow();
    expect(() => a.pi.events.emit("subagents:stop", { agentId: 7 })).not.toThrow();
  });
});

// ─── 4. Queue info + batched pushes ──────────────────────────────────────

describe("queue info on snapshots", () => {
  it("queued snapshots carry queuePosition, activeSlots and maxConcurrent", async () => {
    writeConfig({ maxConcurrent: 2 });
    const created = installSessions();
    const { pi, emitted } = fakePi();
    const runs = [0, 1, 2, 3].map((i) => start(pi, undefined, `p${i}`));
    await tick();

    const createdDetails = ofChannel(emitted, "subagents:created").map((d) => d.details);
    // Granted at once: queued status but no position.
    expect(createdDetails[0].queuePosition).toBeUndefined();
    expect(createdDetails[1].queuePosition).toBeUndefined();
    expect(createdDetails[2]).toMatchObject({ queuePosition: 1, maxConcurrent: 2 });
    expect(createdDetails[3]).toMatchObject({ queuePosition: 2, maxConcurrent: 2 });

    expect(lastQueued(runs[2].onUpdate)).toMatchObject({ queuePosition: 1, activeSlots: 2, maxConcurrent: 2 });
    expect(lastQueued(runs[3].onUpdate)).toMatchObject({ queuePosition: 2, activeSlots: 2, maxConcurrent: 2 });

    created[0].finish();
    created[1].finish();
    await tick();
    created[2].finish();
    created[3].finish();
    await Promise.all(runs.map((r) => r.promise));
  });

  it("positions are 1-based with no gaps", async () => {
    writeConfig({ maxConcurrent: 1 });
    const created = installSessions();
    const { pi } = fakePi();
    const runs = Array.from({ length: 6 }, (_, i) => start(pi, undefined, `p${i}`));
    await tick();
    expect(runs.slice(1).map((r) => lastQueued(r.onUpdate).queuePosition)).toEqual([1, 2, 3, 4, 5]);
    for (let i = 0; i < 6; i++) {
      created[i].finish();
      await tick();
    }
    await Promise.all(runs.map((r) => r.promise));
  });

  it("running snapshots carry slotGrantedAt and drop the queue fields", async () => {
    writeConfig({ maxConcurrent: 1 });
    const created = installSessions();
    const { pi, emitted } = fakePi();
    const before = Date.now();
    const a = start(pi, undefined, "a");
    const b = start(pi, undefined, "b");
    await tick();
    created[0].finish();
    await a.promise;
    await tick();

    const started = ofChannel(emitted, "subagents:started").filter((d) => d.id === createdIds(emitted)[1]);
    const running = started.map((d) => d.details).filter((d) => d.status === "running");
    expect(running.length).toBeGreaterThan(0);
    for (const d of running) {
      expect(d.slotGrantedAt).toBeGreaterThanOrEqual(before);
      expect(d.queuePosition).toBeUndefined();
      expect(d.activeSlots).toBeUndefined();
      expect(d.maxConcurrent).toBeUndefined();
    }
    created[1].finish();
    const res = await b.promise;
    expect(res.details.slotGrantedAt).toBeGreaterThanOrEqual(before);
    expect(res.details.queuePosition).toBeUndefined();
  });

  it("durationMs still counts from call creation, including queue time", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    writeConfig({ maxConcurrent: 1 });
    const created = installSessions();
    const { pi } = fakePi();
    const a = start(pi, undefined, "a");
    const b = start(pi, undefined, "b");
    await tick();
    vi.setSystemTime(Date.now() + 5_000);
    created[0].finish();
    await a.promise;
    await tick();
    created[1].finish();
    const res = await b.promise;
    expect(res.details.durationMs).toBeGreaterThanOrEqual(5_000);
    expect(res.details.slotGrantedAt - (Date.now() - res.details.durationMs)).toBeGreaterThanOrEqual(5_000);
  });

  it("re-pushes positions to remaining waiters after a slot grant", async () => {
    writeConfig({ maxConcurrent: 1 });
    const created = installSessions();
    const { pi } = fakePi();
    const runs = [0, 1, 2, 3].map((i) => start(pi, undefined, `p${i}`));
    await tick();
    expect(lastQueued(runs[3].onUpdate).queuePosition).toBe(3);
    created[0].finish();
    await tick();
    expect(lastQueued(runs[2].onUpdate).queuePosition).toBe(1);
    expect(lastQueued(runs[3].onUpdate).queuePosition).toBe(2);
    for (let i = 1; i < 4; i++) {
      created[i].finish();
      await tick();
    }
    await Promise.all(runs.map((r) => r.promise));
  });

  it("several queue changes in one task send exactly one frame per remaining waiter", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    writeConfig({ maxConcurrent: 1 });
    const created = installSessions();
    const { pi, emitted } = fakePi();
    const controls = createAgentControlRegistry();
    const runs = [0, 1, 2, 3, 4].map((i) => start(pi, controls, `p${i}`));
    await tick();
    const ids = createdIds(emitted);
    const queuedFrames = (i: number) =>
      runs[i].onUpdate.mock.calls.filter((c) => c[0].details.status === "queued").length;
    const before3 = queuedFrames(3);
    const before4 = queuedFrames(4);

    // Two removals in the same synchronous task.
    controls.stop(ids[1]);
    controls.stop(ids[2]);
    await tick();

    expect(queuedFrames(3) - before3).toBe(1);
    expect(queuedFrames(4) - before4).toBe(1);
    expect(lastQueued(runs[3].onUpdate).queuePosition).toBe(1);
    expect(lastQueued(runs[4].onUpdate).queuePosition).toBe(2);

    created[0].finish();
    await tick();
    created[1].finish();
    await tick();
    created[2].finish();
    await Promise.all(runs.map((r) => r.promise));
  });

  it("queue frames go to onUpdate only, never the bus (bus volume stays O(runs))", async () => {
    writeConfig({ maxConcurrent: 1 });
    const created = installSessions();
    const { pi, emitted } = fakePi();
    const runs = [0, 1, 2].map((i) => start(pi, undefined, `p${i}`));
    await tick();
    const ids = createdIds(emitted);
    created[0].finish();
    await tick();
    expect(lastQueued(runs[2].onUpdate).queuePosition).toBe(1);
    const queuedOnBus = ofChannel(emitted, "subagents:started").filter((d) => d.details.status === "queued");
    expect(queuedOnBus).toHaveLength(0);
    // The bus still learns the initial place from subagents:created.
    expect(ofChannel(emitted, "subagents:created").find((d) => d.id === ids[2])!.details.queuePosition).toBe(2);
    created[1].finish();
    await tick();
    created[2].finish();
    await Promise.all(runs.map((r) => r.promise));
  });

  it("an unlimited queue never waits and never reports a position", async () => {
    writeConfig({ maxConcurrent: 0 });
    const created = installSessions();
    const { pi, emitted } = fakePi();
    const runs = [0, 1, 2].map((i) => start(pi, undefined, `p${i}`));
    await tick();
    expect(created.length).toBe(3);
    for (const d of ofChannel(emitted, "subagents:created")) {
      expect(d.details.queuePosition).toBeUndefined();
      expect(d.details.maxConcurrent).toBe(0);
    }
    created.forEach((c) => c.finish());
    await Promise.all(runs.map((r) => r.promise));
  });
});

// ─── 5. Live limit + fairness ────────────────────────────────────────────

describe("live maxConcurrent re-check and fair granting", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "setTimeout", "clearTimeout"] });
  });

  /** Edit the config and make sure the mtime moves so the cache refreshes. */
  function retune(maxConcurrent: number): void {
    const dir = join(tmpAgentDir, "extensions", "pi-dashboard-subagents");
    const path = join(dir, "config.json");
    writeFileSync(path, JSON.stringify({ maxConcurrent }), "utf-8");
    // Force a distinct mtime so the settings cache refreshes.
    const t = new Date(Date.now() + 10_000 + Math.random() * 1000);
    utimesSync(path, t, t);
  }

  async function fill(limit: number, waiting: number) {
    writeConfig({ maxConcurrent: limit });
    const created = installSessions();
    const { pi, emitted } = fakePi();
    const controls = createAgentControlRegistry();
    const runs = Array.from({ length: limit + waiting }, (_, i) => start(pi, controls, `p${i}`));
    await tick();
    expect(created.length).toBe(limit);
    return { created, pi, emitted, controls, runs };
  }

  async function finishAll(created: FakeHandle[], runs: Array<{ promise: Promise<any> }>) {
    for (let guard = 0; guard < 50; guard++) {
      created.forEach((c) => c.finish());
      await tick();
      await vi.advanceTimersByTimeAsync(1_000);
      if (created.length === runs.length) break;
    }
    created.forEach((c) => c.finish());
    await Promise.all(runs.map((r) => r.promise));
  }

  it("raising 4 → 6 with 3 waiting starts 2 of them within about 2 s, in order", async () => {
    const { created, runs } = await fill(4, 3);
    retune(6);
    await vi.advanceTimersByTimeAsync(2_000);
    await tick();
    expect(created.length).toBe(6);
    expect(created[4].session.lastPrompt).toContain("p4");
    expect(created[5].session.lastPrompt).toContain("p5");
    expect(lastQueued(runs[6].onUpdate)).toMatchObject({ queuePosition: 1, maxConcurrent: 6 });
    await finishAll(created, runs);
  });

  it("a limit change pushes fresh queued frames with the new maxConcurrent", async () => {
    const { created, runs } = await fill(1, 2);
    retune(2);
    await vi.advanceTimersByTimeAsync(1_000);
    await tick();
    expect(created.length).toBe(2);
    expect(lastQueued(runs[2].onUpdate)).toMatchObject({ queuePosition: 1, maxConcurrent: 2, activeSlots: 2 });
    await finishAll(created, runs);
  });

  it("a call arriving after a raise waits behind earlier waiters", async () => {
    const { created, pi, controls, runs } = await fill(4, 3);
    retune(6);
    const late = start(pi, controls, "late");
    await tick();
    expect(created.length).toBe(4); // no queue jump before the re-check
    expect(lastQueued(late.onUpdate).queuePosition).toBe(4);

    await vi.advanceTimersByTimeAsync(1_000);
    await tick();
    expect(created.map((c) => c.session.lastPrompt).slice(4)).toEqual([
      expect.stringContaining("p4"),
      expect.stringContaining("p5"),
    ]);
    expect(lastQueued(late.onUpdate).queuePosition).toBe(2);
    await finishAll(created, [...runs, late]);
  });

  it("a fresh call never jumps the queue even when a slot is momentarily free", async () => {
    const { created, pi, controls, runs } = await fill(1, 1);
    // Free the slot; the waiter is granted on release, a same-task newcomer waits.
    created[0].finish();
    const late = start(pi, controls, "late");
    await tick();
    expect(created[1].session.lastPrompt).toContain("p1");
    expect(created.length).toBe(2);
    expect(lastQueued(late.onUpdate).queuePosition).toBe(1);
    await finishAll(created, [...runs, late]);
  });

  it("lowering the limit stops nobody and holds new starts until below it", async () => {
    const { created, runs } = await fill(4, 2);
    retune(2);
    await vi.advanceTimersByTimeAsync(2_000);
    await tick();
    for (const c of created) expect(c.session.abort).not.toHaveBeenCalled();
    expect(created.length).toBe(4);

    created[0].finish();
    created[1].finish();
    await tick();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(created.length).toBe(4); // 2 still running = limit
    created[2].finish();
    await tick();
    expect(created.length).toBe(5);
    await finishAll(created, runs);
  });

  it("clamps an out-of-range limit to 64", async () => {
    writeConfig({ maxConcurrent: 10_000 });
    const created = installSessions();
    const { pi, emitted } = fakePi();
    const runs = Array.from({ length: 66 }, (_, i) => start(pi, undefined, `p${i}`));
    await tick(80);
    expect(created.length).toBe(64);
    expect(ofChannel(emitted, "subagents:created").at(-1)!.details.maxConcurrent).toBe(64);
    await finishAll(created, runs);
  });

  it("runs the re-check only while something waits", async () => {
    const setI = vi.spyOn(globalThis, "setInterval");
    const clearI = vi.spyOn(globalThis, "clearInterval");
    writeConfig({ maxConcurrent: 0 });
    const created = installSessions();
    const { pi } = fakePi();
    const r = start(pi, undefined, "p");
    await tick();
    expect(setI).not.toHaveBeenCalled();
    created[0].finish();
    await r.promise;

    const { created: c2, runs } = await fill(1, 2);
    expect(setI).toHaveBeenCalledTimes(1);
    await finishAll(c2, runs);
    expect(clearI).toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("clears the re-check when the queue empties by stopping every waiter", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { created, emitted, controls, runs } = await fill(1, 3);
    expect(vi.getTimerCount()).toBeGreaterThan(0);
    for (const id of createdIds(emitted).slice(1)) controls.stop(id);
    await Promise.all(runs.slice(1).map((r) => r.promise));
    await tick();
    created[0].finish();
    await runs[0].promise;
    expect(vi.getTimerCount()).toBe(0);
  });
});

// ─── Foreground-first lanes (change: add-background-subagents) ──────────────

describe("foreground-first lanes", () => {
  function startBg(pi: any, controls: ReturnType<typeof createAgentControlRegistry> | undefined, prompt: string) {
    const onUpdate = vi.fn();
    const promise = runAgentTool(tmpCwd, args(prompt), undefined, onUpdate, ctx(), pi, `tc-${prompt}`, controls, {
      background: true,
    }) as Promise<any>;
    return { promise, onUpdate };
  }

  it("a foreground call jumps queued background calls; background order is kept", async () => {
    writeConfig({ maxConcurrent: 1 });
    const created = installSessions();
    const { pi } = fakePi();
    const controls = createAgentControlRegistry();
    const holder = start(pi, controls, "holder");
    const bg = [0, 1, 2].map((i) => startBg(pi, controls, `bg${i}`));
    await tick();
    expect(created.length).toBe(1);
    expect(bg.map((r) => lastQueued(r.onUpdate).queuePosition)).toEqual([1, 2, 3]);
    const framesBefore = bg.map((r) => r.onUpdate.mock.calls.length);

    const fg = start(pi, controls, "fg");
    await tick();
    // The foreground call is next in dispatch order…
    expect(lastQueued(fg.onUpdate).queuePosition).toBe(1);
    // …and every background waiter was renumbered in exactly one batched frame.
    expect(bg.map((r) => lastQueued(r.onUpdate).queuePosition)).toEqual([2, 3, 4]);
    expect(bg.map((r, i) => r.onUpdate.mock.calls.length - framesBefore[i])).toEqual([1, 1, 1]);

    const order: string[] = [];
    for (let i = 0; i < 4; i++) {
      created.at(-1)!.finish();
      await tick();
      order.push(created.at(-1)!.session.lastPrompt);
    }
    expect(order.map((p) => p.match(/<task>\n(\w+)/)![1])).toEqual(["fg", "bg0", "bg1", "bg2"]);
    created.at(-1)!.finish();
    await Promise.all([holder, fg, ...bg].map((r) => r.promise));
  });

  it("a later foreground call queues behind an earlier foreground waiter but ahead of background", async () => {
    writeConfig({ maxConcurrent: 1 });
    const created = installSessions();
    const { pi } = fakePi();
    const holder = start(pi, undefined, "holder");
    const b = startBg(pi, undefined, "b");
    const f1 = start(pi, undefined, "f1");
    const f2 = start(pi, undefined, "f2");
    await tick();
    expect(lastQueued(f1.onUpdate).queuePosition).toBe(1);
    expect(lastQueued(f2.onUpdate).queuePosition).toBe(2);
    expect(lastQueued(b.onUpdate).queuePosition).toBe(3);
    for (let i = 0; i < 4; i++) {
      created.at(-1)!.finish();
      await tick();
    }
    expect(created.map((c) => c.session.lastPrompt.match(/<task>\n(\w+)/)![1])).toEqual(["holder", "f1", "f2", "b"]);
    await Promise.all([holder, b, f1, f2].map((r) => r.promise));
  });

  it("a background call is granted at once only when nobody waits in either lane", async () => {
    writeConfig({ maxConcurrent: 2 });
    const created = installSessions();
    const { pi } = fakePi();
    const a = startBg(pi, undefined, "a");
    await tick();
    expect(created.length).toBe(1); // free slot, empty queue → immediate
    const h = start(pi, undefined, "h");
    const w = start(pi, undefined, "w"); // waits (limit 2 reached)
    const late = startBg(pi, undefined, "late");
    await tick();
    expect(created.length).toBe(2);
    expect(lastQueued(late.onUpdate).queuePosition).toBe(2);
    for (let i = 0; i < 4; i++) {
      created.forEach((c) => c.finish());
      await tick();
    }
    await Promise.all([a, h, w, late].map((r) => r.promise));
  });
});
