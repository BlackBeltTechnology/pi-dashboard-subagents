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
      JSON.stringify({ inheritContext: false, maxConcurrent: 0 }),
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
    const log: Array<{ channel: string; data: any }> = [];
    for (const channel of [
      "subagents:created",
      "subagents:started",
      "subagents:entry",
      "subagents:completed",
      "subagents:failed",
    ]) {
      bus.on(channel, (data) => {
        log.push({ channel, data });
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
    return { piAi, registration, modelRuntime, model, tool: tools[0], ctx, of, log };
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

      console.info(
        `[entry-stream-faux] steps=${steps.length} progressFrames=${progress.length} ` +
          `progressBytes=${progress.reduce((n, f) => n + JSON.stringify(f).length, 0)} ` +
          `entryBytes=${steps.reduce((n, s) => n + JSON.stringify(s).length, 0)}`,
      );
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
      console.info(
        `[entry-stream-faux error] status=${result.details.status} kinds=${steps.map((s) => s.entry.kind).join(",")}`,
      );
    } finally {
      modelRuntime.unregisterProvider(model.provider);
    }
  }, 30_000);
});
