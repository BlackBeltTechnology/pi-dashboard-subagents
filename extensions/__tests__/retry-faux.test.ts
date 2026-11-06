/**
 * End-to-end: pi's own auto-retry inside a REAL child AgentSession, against
 * pi-ai's scripted faux provider, on pi's real event bus. The extension only
 * observes retries; these tests pin how they surface.
 *
 * Own agent dir so the child's `settings.json` `retry` block (written per
 * test) never leaks into other faux suites.
 *
 * See change: surface-subagent-retries.
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

describe("real faux-provider auto-retry", () => {
  let root: string;
  let cwd: string;
  let agentDir: string;
  let previousAgentDir: string | undefined;

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "pi-subagents-retry-faux-"));
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

  /** The child reads pi's `settings.retry` from the agent dir at session creation. */
  function writeRetrySettings(retry: { maxRetries: number; baseDelayMs: number }): void {
    writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ retry: { enabled: true, ...retry } }));
  }

  async function setup(retry = { maxRetries: 2, baseDelayMs: 10 }) {
    writeRetrySettings(retry);
    const [piAi, { default: activate }, { invalidateSettingsCache }, sdk] = await Promise.all([
      import("@earendil-works/pi-ai"),
      import("../agent.js"),
      import("../settings.js"),
      import("@earendil-works/pi-coding-agent"),
    ]);
    invalidateSettingsCache();

    const registration = piAi.fauxProvider({ provider: "retry-faux", models: [{ id: "retry-model" }] });
    const model = registration.getModel();
    const modelRuntime = await sdk.ModelRuntime.create({
      authPath: join(agentDir, "auth.json"),
      modelsPath: join(agentDir, "models.json"),
    });
    modelRuntime.registerNativeProvider(registration.provider);
    await modelRuntime.setRuntimeApiKey(model.provider, "faux-test-key");
    const modelRegistry = new sdk.ModelRegistry(modelRuntime);

    const bus = sdk.createEventBus();
    const log: Array<{ channel: string; data: any }> = [];
    for (const channel of [
      "subagents:created",
      "subagents:started",
      "subagents:entry",
      "subagents:retry",
      "subagents:completed",
      "subagents:failed",
    ]) {
      bus.on(channel, (data) => log.push({ channel, data }));
    }
    bus.on("model:resolve", (payload: any) => {
      payload.model = model;
      payload.resolved = `${model.provider}/${model.id}`;
    });

    const tools: any[] = [];
    const pi: any = { events: bus, modelRegistry, registerTool: (t: any) => tools.push(t), on: () => {} };
    activate(pi);
    const ctx: any = { cwd, modelRegistry };
    const of = (channel: string) => log.filter((e) => e.channel === channel).map((e) => e.data);
    const run = (onUpdate?: (u: any) => void, toolCallId = "call-retry") =>
      tools[0].execute(
        toolCallId,
        { subagent_type: "faux-agent", description: "retry", prompt: "go", model: "@retry-faux" },
        undefined,
        onUpdate,
        ctx,
      ) as Promise<any>;
    // Like a real provider failure: no content blocks, only the error.
    const err = (message: string) => piAi.fauxAssistantMessage([], { stopReason: "error", errorMessage: message });
    return { piAi, registration, modelRuntime, model, run, of, bus, err };
  }

  const kinds = (entries: any[]) => entries.map((e) => e.kind);

  it("retryable error then success: one retry entry in order, retries: 1, completed", async () => {
    const { piAi, registration, modelRuntime, model, run, of, err } = await setup();
    try {
      registration.setResponses([
        piAi.fauxAssistantMessage([piAi.fauxText("looking"), piAi.fauxToolCall("read", { path: "notes.txt" }, { id: "t1" })], {
          stopReason: "toolUse",
        }),
        err("503 service unavailable"),
        piAi.fauxAssistantMessage("done"),
      ]);
      const res = await run();
      expect(res.details.status).toBe("completed");
      expect(res.content[0].text).toBe("done");
      expect(res.details.retries).toBe(1);
      expect(kinds(res.details.entries)).toEqual(["text", "tool", "retry", "text"]);
      expect(res.details.entries[2]).toMatchObject({
        kind: "retry",
        attempt: 1,
        maxAttempts: 2,
        delayMs: 10,
        text: "503 service unavailable",
      });

      const steps = of("subagents:entry");
      const retrySteps = steps.filter((s) => s.entry.kind === "retry");
      expect(retrySteps).toHaveLength(1);
      expect(retrySteps[0].index).toBe(2);
      expect(steps.map((s) => s.index)).toEqual([0, 1, 2, 3]);
      expect(of("subagents:completed")[0].details.retries).toBe(1);

      // A plugin can follow retries on their own channel.
      const agentId = res.details.agentId;
      expect(of("subagents:retry")).toEqual([
        {
          v: 1,
          agentId,
          toolCallId: "call-retry",
          phase: "scheduled",
          attempt: 1,
          maxAttempts: 2,
          delayMs: 10,
          error: "503 service unavailable",
          retries: 1,
        },
        { v: 1, agentId, toolCallId: "call-retry", phase: "ended", attempt: 1, success: true, retries: 1 },
      ]);
    } finally {
      modelRuntime.unregisterProvider(model.provider);
    }
  }, 30_000);

  it("retries exhausted: two retry entries, retries: 2, failure says after 2 retries", async () => {
    const { registration, modelRuntime, model, run, of, err } = await setup();
    try {
      registration.setResponses([err("429 rate_limit_error"), err("429 rate_limit_error"), err("429 rate_limit_error")]);
      const res = await run();
      expect(res.isError).toBe(true);
      expect(res.details.status).toBe("error");
      expect(res.details.retries).toBe(2);
      expect(res.details.error).toBe("429 rate_limit_error (after 2 retries)");
      expect(res.content[0].text).toBe("Subagent failed: 429 rate_limit_error (after 2 retries)");
      const retries = res.details.entries.filter((e: any) => e.kind === "retry");
      expect(retries.map((e: any) => e.attempt)).toEqual([1, 2]);
      const failed = of("subagents:failed");
      expect(failed).toHaveLength(1);
      expect(failed[0].error).toBe("429 rate_limit_error (after 2 retries)");
      expect(failed[0].details.retries).toBe(2);
      expect(of("subagents:retry").map((e) => [e.phase, e.attempt])).toEqual([
        ["scheduled", 1],
        ["scheduled", 2],
        ["ended", 2],
      ]);
      expect(of("subagents:retry").at(-1)).toMatchObject({ success: false, finalError: "429 rate_limit_error", retries: 2 });
    } finally {
      modelRuntime.unregisterProvider(model.provider);
    }
  }, 30_000);

  it("an early recovered retry does not decorate a later non-retryable failure", async () => {
    const { piAi, registration, modelRuntime, model, run, err } = await setup();
    try {
      registration.setResponses([
        err("503 service unavailable"),
        piAi.fauxAssistantMessage([piAi.fauxToolCall("read", { path: "notes.txt" }, { id: "t1" })], { stopReason: "toolUse" }),
        err("400 bad request"),
      ]);
      const res = await run();
      expect(res.details.status).toBe("error");
      expect(res.details.error).toBe("400 bad request");
      expect(res.details.retries).toBe(1);
    } finally {
      modelRuntime.unregisterProvider(model.provider);
    }
  }, 30_000);

  it("a retried attempt that fails non-retryably says after 1 retry", async () => {
    const { registration, modelRuntime, model, run, err } = await setup();
    try {
      registration.setResponses([err("503 service unavailable"), err("400 bad request")]);
      const res = await run();
      expect(res.details.status).toBe("error");
      expect(res.details.error).toBe("400 bad request (after 1 retry)");
      expect(res.details.retries).toBe(1);
      expect(kinds(res.details.entries)).toEqual(["retry"]);
    } finally {
      modelRuntime.unregisterProvider(model.provider);
    }
  }, 30_000);

  it("a non-retryable error alone: no retry entry and no retries key", async () => {
    const { registration, modelRuntime, model, run, of, err } = await setup();
    try {
      registration.setResponses([err("GoUsageLimitError: monthly usage limit reached")]);
      const res = await run();
      expect(res.details.status).toBe("error");
      expect(res.details.error).toBe("GoUsageLimitError: monthly usage limit reached");
      expect("retries" in res.details).toBe(false);
      expect(res.details.entries.some((e: any) => e.kind === "retry")).toBe(false);
      expect("retries" in of("subagents:failed")[0].details).toBe(false);
      expect(of("subagents:retry")).toEqual([]);
    } finally {
      modelRuntime.unregisterProvider(model.provider);
    }
  }, 30_000);

  it("shows the backoff on the activity line, then returns to normal activity", async () => {
    const { piAi, registration, modelRuntime, model, run, err } = await setup({ maxRetries: 2, baseDelayMs: 400 });
    try {
      registration.setResponses([
        err("503 service unavailable"),
        piAi.fauxAssistantMessage([piAi.fauxText("recovered answer")]),
      ]);
      const updates: any[] = [];
      const res = await run((u) => updates.push(u.details));
      expect(res.details.status).toBe("completed");
      const activities = updates.map((d) => d.activity);
      const at = activities.indexOf("retrying (attempt 1/2) in 400ms…".replace("400ms", "1s"));
      expect(at).toBeGreaterThanOrEqual(0);
      expect(activities.slice(at + 1)).toContain("writing");
      expect(updates.slice(at).every((d) => d.retries === 1)).toBe(true);
    } finally {
      modelRuntime.unregisterProvider(model.provider);
    }
  }, 30_000);

  it("a stop during the backoff ends the run as stopped, promptly, with no further retry", async () => {
    const { registration, modelRuntime, model, run, of, bus, err } = await setup({ maxRetries: 3, baseDelayMs: 60_000 });
    const warn = console.warn;
    console.warn = () => {};
    try {
      registration.setResponses([err("503 service unavailable"), err("503 service unavailable")]);
      bus.on("subagents:entry", (s: any) => {
        if (s.entry.kind === "retry") setTimeout(() => bus.emit("subagents:stop", { agentId: s.agentId }), 20);
      });
      const t0 = Date.now();
      const res = await run();
      expect(Date.now() - t0).toBeLessThan(10_000);
      expect(res.isError).toBeFalsy();
      expect(res.details).toMatchObject({ status: "stopped", stopReason: "running", stoppedBy: "event", retries: 1 });
      expect(of("subagents:entry").filter((s) => s.entry.kind === "retry")).toHaveLength(1);
      expect(registration.getPendingResponseCount()).toBe(1); // the retried call never happened
    } finally {
      console.warn = warn;
      modelRuntime.unregisterProvider(model.provider);
    }
  }, 30_000);
});
