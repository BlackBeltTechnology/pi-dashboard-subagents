import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Context, FauxResponseFactory } from "@earendil-works/pi-ai";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const RUNS_PER_BATCH = 10;
const MAX_CONCURRENT = 4;
const MAX_RETAINED_HEAP_GROWTH = 16 * 1024 * 1024;

function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

function userText(context: Context): string {
  const message = [...context.messages].reverse().find((candidate) => candidate.role === "user");
  if (!message) return "";
  if (typeof message.content === "string") return message.content;
  return message.content
    .filter((block): block is { type: "text"; text: string } => block.type === "text")
    .map((block) => block.text)
    .join("\n");
}

function forceGc(): number {
  global.gc?.();
  global.gc?.();
  return process.memoryUsage().heapUsed;
}

describe.skipIf(typeof global.gc !== "function")("real faux-provider fan-out", () => {
  let root: string;
  let cwd: string;
  let agentDir: string;
  let previousAgentDir: string | undefined;

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "pi-subagents-fanout-"));
    cwd = join(root, "project");
    agentDir = join(root, "agent");
    mkdirSync(join(cwd, ".pi", "agents"), { recursive: true });
    mkdirSync(join(agentDir, "extensions", "pi-dashboard-subagents"), { recursive: true });
    previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = agentDir;
    writeFileSync(
      join(agentDir, "extensions", "pi-dashboard-subagents", "config.json"),
      JSON.stringify({
        inheritContext: false,
        exposeInheritanceInTool: true,
        maxConcurrent: MAX_CONCURRENT,
      }),
    );
  });

  afterAll(() => {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    if (root && existsSync(root)) rmSync(root, { recursive: true, force: true });
  });

  it("streams many filtered sessions without retaining per-spawn memory", async () => {
    const codingAgentEntry = import.meta.resolve("@earendil-works/pi-coding-agent");
    const nestedPiAiUrl = new URL(
      "../node_modules/@earendil-works/pi-ai/dist/index.js",
      codingAgentEntry,
    ).href;
    let runtimePiAi: typeof import("@earendil-works/pi-ai");
    try {
      runtimePiAi = await import(nestedPiAiUrl) as typeof import("@earendil-works/pi-ai");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ERR_MODULE_NOT_FOUND") throw error;
      runtimePiAi = await import("@earendil-works/pi-ai");
    }
    const [{ runAgentTool }, { invalidateSettingsCache }, { AuthStorage, ModelRegistry }] =
      await Promise.all([
        import("../agent.js"),
        import("../settings.js"),
        import("@earendil-works/pi-coding-agent"),
      ]);
    invalidateSettingsCache();

    const registration = runtimePiAi.registerFauxProvider({
      provider: "fanout-faux",
      models: [{ id: "fanout-model", reasoning: false }],
    });
    const model = registration.getModel();
    const authStorage = AuthStorage.inMemory();
    authStorage.setRuntimeApiKey(model.provider, "faux-test-key");
    const modelRegistry = ModelRegistry.inMemory(authStorage);
    const observedTools = new Map<string, string[]>();
    const eventCounts = new Map<string, number>();

    const response: FauxResponseFactory = (context) => {
      const prompt = userText(context);
      const id = prompt.match(/<(?:task)>\s*([^<]+)\s*<\/(?:task)>/)?.[1]?.trim() ?? prompt.trim();
      observedTools.set(id, (context.tools ?? []).map((tool) => tool.name).sort());
      return runtimePiAi.fauxAssistantMessage(`completed:${id}`);
    };

    const pi = {
      events: {
        emit(name: string, payload: any) {
          eventCounts.set(name, (eventCounts.get(name) ?? 0) + 1);
          if (name === "model:resolve") {
            payload.model = model;
            payload.resolved = `${model.provider}/${model.id}`;
          }
        },
      },
      modelRegistry,
    } as any;
    const ctx = { cwd, modelRegistry } as any;

    async function runOne(id: string, tools?: string[]) {
      const type = `fanout-${id}`;
      const frontmatter = tools
        ? tools.length > 0
          ? `---\ntools:\n${tools.map((tool) => `  - ${tool}`).join("\n")}\n---\n# ${type}\n`
          : `---\ntools: []\n---\n# ${type}\n`
        : `# ${type}\n`;
      writeFileSync(join(cwd, ".pi", "agents", `${type}.md`), frontmatter);
      registration.appendResponses([response]);
      return runAgentTool(
        cwd,
        {
          subagent_type: type,
          description: `fan-out ${id}`,
          prompt: id,
          model: "@fanout-faux",
          isolated: true,
        },
        undefined,
        undefined,
        ctx,
        pi,
      );
    }

    try {
      registration.appendResponses([response]);
      const warmup = await runAgentTool(
        cwd,
        {
          subagent_type: "missing-warmup-agent",
          description: "warm resource and module caches",
          prompt: "warmup",
          model: "@fanout-faux",
          isolated: true,
        },
        undefined,
        undefined,
        ctx,
        pi,
      );
      if (warmup.details.status !== "completed") {
        throw new Error(`warmup failed: ${warmup.details.error ?? "unknown error"}`);
      }

      const availableTools = observedTools.get("warmup") ?? [];
      if (availableTools.length === 0) {
        throw new Error(`warmup exposed no tools; observations=${JSON.stringify([...observedTools])}`);
      }
      const baselineHeap = forceGc();
      const random = seededRandom(0x5eed_fade);
      const expectedTools = new Map<string, string[]>();

      async function runBatch(batch: number) {
        const runs = Array.from({ length: RUNS_PER_BATCH }, (_, index) => {
          const id = `spawn-${batch}-${index}`;
          const selected = availableTools.filter(() => random() >= 0.5);
          if (selected.length === 0) {
            selected.push(availableTools[Math.floor(random() * availableTools.length)]!);
          }
          selected.sort();
          expectedTools.set(id, selected);
          return runOne(id, selected);
        });
        const results = await Promise.all(runs);
        expect(results.every((result) => result.details.status === "completed")).toBe(true);
        for (const [id, expected] of expectedTools) {
          if (id.startsWith(`spawn-${batch}-`)) expect(observedTools.get(id)).toEqual(expected);
        }
        expect(registration.getPendingResponseCount()).toBe(0);
        return forceGc();
      }

      const afterFirstBatch = await runBatch(1);
      const afterSecondBatch = await runBatch(2);

      expect(registration.state.callCount).toBe(1 + RUNS_PER_BATCH * 2);
      const totalRuns = 1 + RUNS_PER_BATCH * 2;
      expect(eventCounts.get("subagents:created")).toBe(totalRuns);
      expect(eventCounts.get("subagents:started")).toBeGreaterThanOrEqual(totalRuns);
      expect(eventCounts.get("subagents:started")).toBeLessThanOrEqual(totalRuns * 4);
      expect(eventCounts.get("subagents:completed")).toBe(totalRuns);
      expect(eventCounts.get("subagents:failed") ?? 0).toBe(0);
      const secondBatchGrowth = afterSecondBatch - afterFirstBatch;
      const totalGrowth = afterSecondBatch - baselineHeap;
      console.info(
        `[fanout-memory] runs=${totalRuns} baseline=${baselineHeap} ` +
          `afterFirst=${afterFirstBatch} afterSecond=${afterSecondBatch} ` +
          `secondBatchGrowth=${secondBatchGrowth} totalGrowth=${totalGrowth}`,
      );
      expect(secondBatchGrowth).toBeLessThan(MAX_RETAINED_HEAP_GROWTH);
      expect(totalGrowth).toBeLessThan(MAX_RETAINED_HEAP_GROWTH * 2);
    } finally {
      registration.unregister();
    }
  }, 60_000);
});
