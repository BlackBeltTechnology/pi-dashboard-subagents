/**
 * End-to-end faux test for the per-step entry stream
 * (change: stream-subagent-entries-per-step).
 *
 * Unlike the unit tests in agent.test.ts (fake session), this drives a REAL
 * child AgentSession — real lean loader, real agent loop, real `read` tool —
 * against pi-ai's scripted faux provider, on pi's REAL event bus. A listener
 * rebuilds the timeline from `subagents:entry` alone and must match the
 * final tool result exactly.
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

/** `AgentStatus {ids, wait?}` → `wait {ids, until}` (see change: agent-control-unified-wait). */
const asAction = (action: string, p: any) => {
  if (action !== "status") return { action, ...p };
  const { wait, ...rest } = p ?? {};
  return { action: "wait", until: wait ?? "none", ...rest };
};


describe("real faux-provider entry stream", () => {
  let root: string;
  let cwd: string;
  let agentDir: string;
  let previousAgentDir: string | undefined;

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "pi-subagents-entry-stream-"));
    cwd = join(root, "project");
    agentDir = join(root, "agent");
    mkdirSync(cwd, { recursive: true });
    mkdirSync(join(agentDir, "extensions", "pi-dashboard-subagents"), { recursive: true });
    writeFileSync(join(cwd, "notes.txt"), "faux file body\n");
    previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = agentDir;
    writeFileSync(
      join(agentDir, "extensions", "pi-dashboard-subagents", "config.json"),
      JSON.stringify({ inheritContext: false, maxConcurrent: 0, backgroundIdleTtlSec: 0 }),
    );
  });

  afterAll(() => {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    if (root && existsSync(root)) rmSync(root, { recursive: true, force: true });
  });

  async function setup(tokensPerSecond?: number) {
    const [piAi, { default: activate }, { invalidateSettingsCache }, sdk] = await Promise.all([
      import("@earendil-works/pi-ai"),
      import("../agent.js"),
      import("../settings.js"),
      import("@earendil-works/pi-coding-agent"),
    ]);
    invalidateSettingsCache();

    const registration = piAi.fauxProvider({
      provider: "entry-faux",
      models: [{ id: "entry-model", reasoning: true }],
      // Small chunks → many thinking/text deltas, exercising the progress throttle.
      tokenSize: { min: 2, max: 4 },
      ...(tokensPerSecond ? { tokensPerSecond } : {}),
    });
    const model = registration.getModel();
    const modelRuntime = await sdk.ModelRuntime.create({
      authPath: join(agentDir, "auth.json"),
      modelsPath: join(agentDir, "models.json"),
    });
    modelRuntime.registerNativeProvider(registration.provider);
    await modelRuntime.setRuntimeApiKey(model.provider, "faux-test-key");
    const modelRegistry = new sdk.ModelRegistry(modelRuntime);

    // pi's real in-process bus, with a recorder + the @role resolver.
    const bus = sdk.createEventBus();
    const log: Array<{ channel: string; data: any; at: number }> = [];
    for (const channel of [
      "subagents:created",
      "subagents:started",
      "subagents:entry",
      "subagents:delta",
      "subagents:completed",
      "subagents:failed",
    ]) {
      bus.on(channel, (data) => {
        log.push({ channel, data, at: Date.now() });
      });
    }
    bus.on("model:resolve", (payload: any) => {
      payload.model = model;
      payload.resolved = `${model.provider}/${model.id}`;
    });

    const tools: any[] = [];
    const pi: any = {
      events: bus,
      modelRegistry,
      registerTool: (t: any) => tools.push(t),
      on: () => {},
    };
    activate(pi);
    const ctx: any = { cwd, modelRegistry };
    const of = (channel: string) => log.filter((e) => e.channel === channel).map((e) => e.data);
    // Old tool names map onto AgentControl actions (add-subagent-orchestration D0),
    // so these behavioural assertions exercise the single tool.
    const ACTIONS: Record<string, string> = {
        AgentStatus: "status",
        AgentMessages: "messages",
        AgentList: "list",
        AgentCancel: "cancel",
    };
    const toolNamed = (name: string) => {
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
    return { piAi, registration, modelRuntime, model, tool: tools[0], toolNamed, ctx, of, log, bus };
  }

  it("rebuilds the exact final timeline from subagents:entry alone; progress stays thin", async () => {
    const { piAi, registration, modelRuntime, model, tool, ctx, of, log } = await setup();
    try {
      registration.setResponses([
        // Turn 1: reason, talk, call a real tool.
        piAi.fauxAssistantMessage(
          [
            piAi.fauxThinking("I should read the notes file first, carefully and completely."),
            piAi.fauxText("Reading the notes now."),
            piAi.fauxToolCall("read", { path: "notes.txt" }, { id: "tc-read-1" }),
          ],
          { stopReason: "toolUse" },
        ),
        // Turn 2: reason again, then answer.
        piAi.fauxAssistantMessage([
          piAi.fauxThinking("The file says faux file body, so I can summarize it now."),
          piAi.fauxText("FINAL: the notes say faux file body."),
        ]),
      ]);

      const result: any = await tool.execute(
        "call-faux-1",
        { subagent_type: "faux-agent", description: "faux e2e", prompt: "summarize notes.txt", model: "@entry-faux" },
        undefined,
        undefined,
        ctx,
      );

      expect(result.details.status).toBe("completed");
      expect(result.content[0].text).toBe("FINAL: the notes say faux file body.");
      expect(registration.getPendingResponseCount()).toBe(0);

      const finalEntries = result.details.entries;
      const steps = of("subagents:entry");

      // Each step once, in order, contiguous, tagged with the parent call id.
      expect(steps.map((s) => s.index)).toEqual([...finalEntries.keys()]);
      expect(steps.map((s) => s.entry.kind)).toEqual(["thinking", "text", "tool", "thinking", "text"]);
      for (const s of steps) {
        expect(s).toMatchObject({ v: 1, agentId: result.details.agentId, toolCallId: "call-faux-1" });
      }

      // A listener that only hears subagents:entry rebuilds the identical timeline.
      const rebuilt: any[] = [];
      for (const s of steps) rebuilt[s.index] = s.entry;
      expect(rebuilt).toEqual(finalEntries);

      // The real `read` tool ran with paired input + real output.
      const toolEntry = finalEntries[2];
      expect(toolEntry).toMatchObject({ kind: "tool", toolName: "read", input: { path: "notes.txt" }, isError: false });
      expect(JSON.stringify(toolEntry.output)).toContain("faux file body");

      // Lifecycle: created + initial started full; progress thin; completed full.
      expect(of("subagents:created")).toHaveLength(1);
      expect(of("subagents:created")[0].details.entries).toEqual([]);
      const started = of("subagents:started");
      expect(started[0].details.entries).toEqual([]);
      const progress = started.slice(1);
      expect(progress.length).toBeGreaterThan(0);
      let last = 0;
      for (const f of progress) {
        expect("entries" in f.details).toBe(false);
        expect(f.details.entryCount).toBeGreaterThanOrEqual(last);
        last = f.details.entryCount;
      }
      expect(last).toBe(finalEntries.length); // flushed before completed
      const completed = of("subagents:completed");
      expect(completed).toHaveLength(1);
      expect(completed[0].details.entries).toEqual(finalEntries);
      expect(completed[0].details.entryCount).toBe(finalEntries.length);
      expect(of("subagents:failed")).toHaveLength(0);

      // Every step is announced BEFORE any progress frame that counts it.
      let announced = 0;
      for (const e of log) {
        if (e.channel === "subagents:entry") announced += 1;
        else if (e.channel === "subagents:started") expect(e.data.details.entryCount).toBeLessThanOrEqual(announced);
      }

      // Block deltas (change: emit-subagent-block-deltas): every streamed
      // block is rebuilt exactly from `subagents:delta` alone, contiguous,
      // closed by exactly one final piece that precedes its linked entry.
      const deltas = of("subagents:delta");
      const blockIds = [...new Set(deltas.map((d) => d.blockId))];
      expect(blockIds).toEqual([0, 1, 2, 3]);
      for (const id of blockIds) {
        const pieces = deltas.filter((d) => d.blockId === id);
        let have = 0;
        for (const p of pieces) {
          expect(p).toMatchObject({ v: 1, agentId: result.details.agentId, toolCallId: "call-faux-1" });
          expect(p.offset).toBe(have);
          have += p.text.length;
        }
        expect(pieces.filter((p) => p.final)).toHaveLength(1);
        expect(pieces.at(-1).final).toBe(true);
        const linked = steps.filter((s) => s.blockId === id);
        expect(linked).toHaveLength(1);
        expect(pieces.map((p) => p.text).join("")).toEqual(linked[0].entry.text);
        const finalAt = log.findIndex((e) => e.channel === "subagents:delta" && e.data.blockId === id && e.data.final);
        const entryAt = log.findIndex((e) => e.channel === "subagents:entry" && e.data.blockId === id);
        expect(finalAt).toBeLessThan(entryAt);
      }
      expect(steps.filter((s) => s.entry.kind === "tool").every((s) => !("blockId" in s))).toBe(true);

      console.info(
        `[entry-stream-faux] steps=${steps.length} deltas=${deltas.length} progressFrames=${progress.length} ` +
          `progressBytes=${progress.reduce((n, f) => n + JSON.stringify(f).length, 0)} ` +
          `entryBytes=${steps.reduce((n, s) => n + JSON.stringify(s).length, 0)}`,
      );
    } finally {
      modelRuntime.unregisterProvider(model.provider);
    }
  }, 30_000);

  // See change: add-background-subagents (task 4.5).
  it("background run: early return, same entry stream and final text as foreground", async () => {
    const { piAi, registration, modelRuntime, model, tool, toolNamed, ctx, of, log } = await setup();
    const script = () => [
      piAi.fauxAssistantMessage(
        [
          piAi.fauxThinking("Reading the notes first."),
          piAi.fauxToolCall("read", { path: "notes.txt" }, { id: "tc-bg-read" }),
        ],
        { stopReason: "toolUse" },
      ),
      piAi.fauxAssistantMessage([piAi.fauxText("FINAL: faux file body.")]),
    ];
    const params = { subagent_type: "faux-agent", description: "bg e2e", prompt: "summarize notes.txt", model: "@entry-faux" };
    const strip = (entries: any[]) => entries.map(({ ts: _ts, ...e }) => e);
    try {
      // Foreground reference run.
      registration.setResponses(script());
      const fg: any = await tool.execute("call-fg", params, undefined, undefined, ctx);
      expect(fg.details.status).toBe("completed");
      const fgSteps = of("subagents:entry").filter((s) => s.agentId === fg.details.agentId);
      log.length = 0;

      // Background run of the same script.
      registration.setResponses(script());
      const spawned: any = await tool.execute("call-bg", { ...params, run_in_background: true }, undefined, undefined, ctx);
      expect(spawned.details).toMatchObject({ background: true, id: expect.stringMatching(/^bg-/) });
      expect(spawned.details.agentId).toBeUndefined();
      // Returned before the run finished.
      expect(of("subagents:completed")).toHaveLength(0);

      const status: any = await toolNamed("AgentStatus").execute(
        "call-status",
        { ids: [spawned.details.id], wait: "all", timeout_s: 20 },
        undefined,
        undefined,
        ctx,
      );
      expect(status.details.agents[0]).toMatchObject({ status: "completed", result: fg.content[0].text });

      const completed = of("subagents:completed");
      expect(completed).toHaveLength(1);
      expect(completed[0].details.background).toBe(true);
      const bgSteps = of("subagents:entry").filter((s) => s.agentId === completed[0].id);
      expect(bgSteps.map((s) => s.index)).toEqual(fgSteps.map((s) => s.index));
      expect(strip(bgSteps.map((s) => s.entry))).toEqual(strip(fgSteps.map((s) => s.entry)));
      expect(bgSteps.every((s) => s.toolCallId === "call-bg")).toBe(true);
    } finally {
      modelRuntime.unregisterProvider(model.provider);
    }
  }, 30_000);

  it("long run: progress frame size stays flat while the timeline grows", async () => {
    const { piAi, registration, modelRuntime, model, tool, ctx, of } = await setup(150);
    const TURNS = 30;
    try {
      const turns = Array.from({ length: TURNS }, (_, i) =>
        piAi.fauxAssistantMessage(
          [piAi.fauxText(`step ${i}`), piAi.fauxToolCall("read", { path: "notes.txt" }, { id: `tc-${i}` })],
          { stopReason: "toolUse" },
        ),
      );
      registration.setResponses([...turns, piAi.fauxAssistantMessage("done")]);

      const t0 = Date.now();
      const result: any = await tool.execute(
        "call-faux-long",
        { subagent_type: "faux-agent", description: "long", prompt: "loop", model: "@entry-faux" },
        undefined,
        undefined,
        ctx,
      );
      expect(result.details.status).toBe("completed");
      const n = result.details.entries.length;
      expect(n).toBe(TURNS * 2 + 1);

      const steps = of("subagents:entry");
      expect(steps).toHaveLength(n);
      const rebuilt: any[] = [];
      for (const s of steps) rebuilt[s.index] = s.entry;
      expect(rebuilt).toEqual(result.details.entries);

      const progress = of("subagents:started").slice(1);
      expect(progress.length).toBeGreaterThanOrEqual(4); // throttle released frames mid-run
      const sizes = progress.map((f) => JSON.stringify(f).length);
      const completedBytes = JSON.stringify(of("subagents:completed")[0]).length;
      for (const f of progress) expect("entries" in f.details).toBe(false);
      // A thin frame is a fixed-size header: never more than ~1 KB, no matter how many steps.
      expect(Math.max(...sizes)).toBeLessThan(1_500);
      expect(completedBytes).toBeGreaterThan(Math.max(...sizes) * 5);
      console.info(
        `[entry-stream-faux long] steps=${n} ms=${Date.now() - t0} progressFrames=${progress.length} ` +
          `maxProgressBytes=${Math.max(...sizes)} completedBytes=${completedBytes}`,
      );
    } finally {
      modelRuntime.unregisterProvider(model.provider);
    }
  }, 30_000);

  it("slow long block: delta pieces are throttled to \u2264 4/s and rebuild the block exactly", async () => {
    const { piAi, registration, modelRuntime, model, tool, ctx, of, log } = await setup(150);
    try {
      const thought = Array.from({ length: 60 }, (_, i) => `thought-${i}`).join(" ");
      registration.setResponses([piAi.fauxAssistantMessage([piAi.fauxThinking(thought), piAi.fauxText("ok")])]);
      const result: any = await tool.execute(
        "call-faux-slow",
        { subagent_type: "faux-agent", description: "slow", prompt: "think", model: "@entry-faux" },
        undefined,
        undefined,
        ctx,
      );
      expect(result.details.status).toBe("completed");
      const pieces = of("subagents:delta").filter((d) => d.blockId === 0);
      expect(pieces.map((p) => p.text).join("")).toBe(thought);
      const times = log
        .filter((e) => e.channel === "subagents:delta" && !e.data.final)
        .map((e) => e.at);
      expect(times.length).toBeGreaterThanOrEqual(4); // streamed mid-block, not only at close
      for (let i = 0; i < times.length; i++) {
        const inWindow = times.filter((t) => t >= times[i] && t < times[i] + 1000).length;
        expect(inWindow).toBeLessThanOrEqual(4);
      }
      const maxTick = Math.max(...of("subagents:started").slice(1).map((f) => JSON.stringify(f).length));
      expect(maxTick).toBeLessThan(1_500);
      console.info(`[entry-stream-faux slow] deltaPieces=${times.length} maxTickBytes=${maxTick}`);
    } finally {
      modelRuntime.unregisterProvider(model.provider);
    }
  }, 30_000);

  it("provider error mid-run: streamed steps still match the terminal timeline", async () => {
    const { piAi, registration, modelRuntime, model, tool, ctx, of } = await setup();
    try {
      registration.setResponses([
        piAi.fauxAssistantMessage(
          [piAi.fauxText("first"), piAi.fauxToolCall("read", { path: "notes.txt" }, { id: "tc-e" })],
          { stopReason: "toolUse" },
        ),
        piAi.fauxAssistantMessage("", { stopReason: "error", errorMessage: "faux upstream 500" }),
      ]);
      const result: any = await tool.execute(
        "call-faux-err",
        { subagent_type: "faux-agent", description: "err", prompt: "go", model: "@entry-faux" },
        undefined,
        undefined,
        ctx,
      );
      const terminal = [...of("subagents:completed"), ...of("subagents:failed")];
      expect(terminal).toHaveLength(1);
      const steps = of("subagents:entry");
      const rebuilt: any[] = [];
      for (const s of steps) rebuilt[s.index] = s.entry;
      expect(rebuilt).toEqual(result.details.entries);
      expect(terminal[0].details.entries).toEqual(result.details.entries);
      expect(result.details.entryCount).toBe(result.details.entries.length);
      expect(steps.slice(0, 2).map((s) => s.entry.kind)).toEqual(["text", "tool"]);
      // "faux upstream 500" is retryable, so pi (default settings) retries it
      // once; the retried call then hits the faux provider's non-retryable
      // "No more faux responses queued" (change: surface-subagent-retries).
      // (The faux "" message carries an empty text block, backfilled before the retry.)
      const retrySteps = steps.filter((s) => s.entry.kind === "retry");
      expect(retrySteps).toHaveLength(1);
      expect(retrySteps[0].entry).toMatchObject({ kind: "retry", attempt: 1, text: "faux upstream 500" });
      expect(retrySteps[0].index).toBeGreaterThan(1);
      expect(result.details.retries).toBe(1);
      expect(result.details.error).toMatch(/ \(after 1 retry\)$/);
      // The errored final reply decides the outcome (change: harden-subagent-lifecycle).
      expect(result.details.status).toBe("error");
      expect(result.isError).toBe(true);
      expect(result.content[0].text).not.toBe("first");
      expect(of("subagents:failed")).toHaveLength(1);
      expect(of("subagents:completed")).toHaveLength(0);
      console.info(
        `[entry-stream-faux error] status=${result.details.status} kinds=${steps.map((s) => s.entry.kind).join(",")}`,
      );
    } finally {
      modelRuntime.unregisterProvider(model.provider);
    }
  }, 30_000);
  // See change: manage-subagent-spawn-queue.
  it("subagents:stop on a real bus: stops a streaming child and a queued one; the parent result is not an error", async () => {
    const configPath = join(agentDir, "extensions", "pi-dashboard-subagents", "config.json");
    writeFileSync(configPath, JSON.stringify({ inheritContext: false, maxConcurrent: 1 }));
    const warn = console.warn;
    console.warn = () => {};
    const { piAi, registration, modelRuntime, model, tool, ctx, of, bus } = await setup(150);
    try {
      const thought = Array.from({ length: 80 }, (_, i) => `slow-${i}`).join(" ");
      registration.setResponses([
        piAi.fauxAssistantMessage([piAi.fauxThinking(thought), piAi.fauxText("never reached")]),
        piAi.fauxAssistantMessage("b finished"),
      ]);
      const call = (id: string, description: string) =>
        tool.execute(id, { subagent_type: "faux-agent", description, prompt: "go", model: "@entry-faux" }, undefined, undefined, ctx);
      const runA = call("call-a", "a");
      const runB = call("call-b", "b");
      const runC = call("call-c", "c");

      const createdIds = () => of("subagents:created").map((d) => d.id as string);
      await new Promise<void>((resolve) => {
        const poll = () => (of("subagents:delta").length > 0 ? resolve() : setTimeout(poll, 10));
        poll();
      });
      const [idA, idB, idC] = createdIds();
      // B and C wait behind A; C sits at position 2.
      const queuedC = of("subagents:created").find((d) => d.id === idC)!;
      expect(queuedC.details).toMatchObject({ status: "queued", queuePosition: 2, maxConcurrent: 1, stoppable: true });

      bus.emit("subagents:stop", { agentId: idC }); // queued
      bus.emit("subagents:stop", { agentId: idA }); // streaming
      const [a, b, c]: any[] = await Promise.all([runA, runB, runC]);

      expect(a.isError).toBeUndefined();
      expect(a.details).toMatchObject({ status: "stopped", stopReason: "running" });
      expect(a.content[0].text.startsWith("Subagent stopped by user.")).toBe(true);
      expect(c.isError).toBeUndefined();
      expect(c.details).toMatchObject({ status: "stopped", stopReason: "queued" });
      expect(c.details.entries).toEqual([]);
      expect(b.details.status).toBe("completed");
      expect(b.content[0].text).toBe("b finished");
      expect(b.details.slotGrantedAt).toBeGreaterThan(0);

      // Exactly one terminal event per subagent, all on subagents:completed.
      for (const id of [idA, idB, idC]) {
        const terminal = [...of("subagents:completed"), ...of("subagents:failed")].filter((d) => d.id === id);
        expect(terminal, id).toHaveLength(1);
      }
      expect(of("subagents:failed")).toHaveLength(0);
      // The streamed timeline of the stopped child still rebuilds exactly.
      const rebuilt: any[] = [];
      for (const s of of("subagents:entry").filter((e) => e.agentId === idA)) rebuilt[s.index] = s.entry;
      expect(rebuilt).toEqual(a.details.entries);
      // The stopped waiter never ran a child: no entries, no deltas.
      expect(of("subagents:delta").filter((d) => d.agentId === idC)).toHaveLength(0);
    } finally {
      console.warn = warn;
      modelRuntime.unregisterProvider(model.provider);
      writeFileSync(configPath, JSON.stringify({ inheritContext: false, maxConcurrent: 0 }));
    }
  }, 30_000);
  // Real pi end to end: ask_parent → wait → reply → idle → steer (run 2) → cancel.
  // See change: add-subagent-orchestration.
  it("orchestration on a real session: ask, reply, idle, steer continues on the same history", async () => {
    const configPath = join(agentDir, "extensions", "pi-dashboard-subagents", "config.json");
    writeFileSync(
      configPath,
      JSON.stringify({ inheritContext: false, maxConcurrent: 0, backgroundIdleTtlSec: 600, notifyParent: false }),
    );
    const { piAi, registration, modelRuntime, model, tool, toolNamed, ctx } = await setup();
    const textOf = (m: any): string =>
      typeof m.content === "string"
        ? m.content
        : (m.content ?? []).map((b: any) => b.text ?? (typeof b.content === "string" ? b.content : JSON.stringify(b.content ?? ""))).join("");
    let run1SawAnswer = false;
    let run2SawHistory = false;
    try {
      registration.setResponses([
        piAi.fauxAssistantMessage([piAi.fauxToolCall("ask_parent", { question: "JWT or cookie?" }, { id: "tc-ask" })], {
          stopReason: "toolUse",
        }),
        (c: any) => {
          run1SawAnswer = c.messages.some((m: any) => m.role === "toolResult" && textOf(m).includes("use JWT"));
          return piAi.fauxAssistantMessage("RUN1: using JWT");
        },
        (c: any) => {
          const all = c.messages.map(textOf).join("|");
          run2SawHistory = all.includes("RUN1: using JWT") && all.includes("now add tests");
          return piAi.fauxAssistantMessage("RUN2: tests added");
        },
      ]);
      const control = toolNamed("AgentControl");
      const act = (params: Record<string, unknown>) => control.execute(`c-${Math.random()}`, params, undefined, undefined, ctx);
      const spawned: any = await tool.execute(
        "call-orch",
        { subagent_type: "faux-agent", description: "orch e2e", prompt: "pick auth", model: "@entry-faux", run_in_background: true },
        undefined,
        undefined,
        ctx,
      );
      const id = spawned.details.id;

      const w: any = await act({ action: "wait", timeout_s: 20 });
      expect(w.details.entries[0]).toMatchObject({ id, kind: "question", question_id: "q1", text: "JWT or cookie?" });
      const r: any = await act({ action: "reply", id, question_id: "q1", answer: "use JWT" });
      expect(r.details.results[0].result).toBe("answered");

      const s1: any = await act({ action: "wait", ids: [id], until: "all", timeout_s: 20 });
      expect(s1.details.agents[0]).toMatchObject({ status: "idle", run: 1, result: "RUN1: using JWT" });
      expect(run1SawAnswer).toBe(true);

      const st: any = await act({ action: "steer", id, message: "now add tests", mode: "followUp" });
      expect(st.details.results[0].result).toBe("started");
      const s2: any = await act({ action: "wait", ids: [id], until: "all", timeout_s: 20 });
      expect(s2.details.agents[0]).toMatchObject({ status: "idle", run: 2, result: "RUN2: tests added" });
      expect(run2SawHistory).toBe(true);
      expect(registration.getPendingResponseCount()).toBe(0);

      const c: any = await act({ action: "cancel", ids: [id] });
      expect(c.details.results[0].outcome).toBe("disposed");
    } finally {
      modelRuntime.unregisterProvider(model.provider);
      writeFileSync(configPath, JSON.stringify({ inheritContext: false, maxConcurrent: 0, backgroundIdleTtlSec: 0 }));
    }
  }, 30_000);
});

