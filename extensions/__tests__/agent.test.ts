/**
 * Tests for extensions/agent.ts
 *
 * Covers task §3.8:
 *   - Schema with exposeInheritanceInTool: false has no `isolated` field
 *   - Schema with exposeInheritanceInTool: true has optional `isolated`
 *   - resolveAgentMdPath finds project-level file, falls back to global,
 *     returns undefined for missing
 *   - Throttling: rapid progress events coalesce to ≤4/sec
 *
 * Notes:
 *   - The full execute() path needs a real AgentSession (requires
 *     pi-coding-agent installed); that's the end-to-end concern of §9.5.
 *     Here we test the synchronous pure helpers and the throttling logic.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  buildAgentParametersSchema,
  createProgressEmitter,
  createUsageAccumulator,
  resolveAgentMdPath,
} from "../agent.js";

// Re-route getAgentDir() to a tmp dir per-test.
let tmpAgentDir: string;
let tmpCwd: string;

vi.mock("@mariozechner/pi-coding-agent", () => ({
  getAgentDir: () => tmpAgentDir,
  // The agent.ts default-export path imports several other symbols (defineTool,
  // createAgentSession, SessionManager). The schema + helper tests in this file
  // don't exercise the execute() body, so we only need to stub what we touch.
  defineTool: <T,>(t: T) => t,
  createAgentSession: vi.fn(),
  SessionManager: { inMemory: vi.fn() },
}));

beforeEach(() => {
  tmpAgentDir = mkdtempSync(join(tmpdir(), "pi-dashboard-subagents-agentdir-"));
  tmpCwd = mkdtempSync(join(tmpdir(), "pi-dashboard-subagents-cwd-"));
});

afterEach(() => {
  if (tmpAgentDir && existsSync(tmpAgentDir)) rmSync(tmpAgentDir, { recursive: true, force: true });
  if (tmpCwd && existsSync(tmpCwd)) rmSync(tmpCwd, { recursive: true, force: true });
});

// ── Schema (conditional on exposeInheritanceInTool) ─────────────────────

describe("buildAgentParametersSchema", () => {
  it("omits the isolated property when exposeIsolated is false", () => {
    const s: any = buildAgentParametersSchema(false);
    expect(s.properties).toBeDefined();
    expect(Object.keys(s.properties)).toEqual(expect.arrayContaining(["subagent_type", "description", "prompt"]));
    expect(s.properties.isolated).toBeUndefined();
  });

  it("includes isolated as an optional boolean when exposeIsolated is true", () => {
    const s: any = buildAgentParametersSchema(true);
    expect(s.properties.isolated).toBeDefined();
    expect(s.properties.isolated.type).toBe("boolean");
    // TypeBox marks optionals via absence in the `required` array.
    expect(s.required ?? []).not.toContain("isolated");
  });

  it("always requires subagent_type, description, prompt", () => {
    const offSchema: any = buildAgentParametersSchema(false);
    const onSchema: any = buildAgentParametersSchema(true);
    for (const schema of [offSchema, onSchema]) {
      expect(schema.required).toEqual(expect.arrayContaining(["subagent_type", "description", "prompt"]));
    }
  });
});

// ── resolveAgentMdPath ──────────────────────────────────────────────────

describe("resolveAgentMdPath", () => {
  it("finds project-level .pi/agents/<type>.md first", () => {
    const projectAgents = join(tmpCwd, ".pi", "agents");
    mkdirSync(projectAgents, { recursive: true });
    const target = join(projectAgents, "Scout.md");
    writeFileSync(target, "# Scout");
    expect(resolveAgentMdPath("Scout", tmpCwd)).toBe(target);
  });

  it("falls back to global ~/.pi/agent/agents/<type>.md when no project file", () => {
    const globalAgents = join(tmpAgentDir, "agents");
    mkdirSync(globalAgents, { recursive: true });
    const target = join(globalAgents, "Explore.md");
    writeFileSync(target, "# Explore");
    expect(resolveAgentMdPath("Explore", tmpCwd)).toBe(target);
  });

  it("project wins over global when both exist", () => {
    const projectAgents = join(tmpCwd, ".pi", "agents");
    mkdirSync(projectAgents, { recursive: true });
    const globalAgents = join(tmpAgentDir, "agents");
    mkdirSync(globalAgents, { recursive: true });
    const projectPath = join(projectAgents, "Both.md");
    const globalPath = join(globalAgents, "Both.md");
    writeFileSync(projectPath, "# project");
    writeFileSync(globalPath, "# global");
    expect(resolveAgentMdPath("Both", tmpCwd)).toBe(projectPath);
  });

  it("returns undefined when no file exists", () => {
    expect(resolveAgentMdPath("DoesNotExist", tmpCwd)).toBeUndefined();
  });

  it("returns undefined for path-traversal attempts in the type name", () => {
    expect(resolveAgentMdPath("../../etc/passwd", tmpCwd)).toBeUndefined();
    expect(resolveAgentMdPath("foo/bar", tmpCwd)).toBeUndefined();
    expect(resolveAgentMdPath("", tmpCwd)).toBeUndefined();
  });
});

// ── createProgressEmitter (throttle) ────────────────────────────────────

describe("createProgressEmitter throttling", () => {
  function fakePi() {
    const calls: any[] = [];
    return {
      pi: { events: { emit: (channel: string, data: any) => calls.push({ channel, data }) } } as any,
      calls,
    };
  }

  function snapshot(label: string) {
    return {
      agentId: "a1",
      displayName: label,
      description: "x",
      subagentType: "test",
      status: "running" as const,
      toolUses: 0,
      tokens: "0",
      durationMs: 1,
      entries: [],
    };
  }

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("first schedule fires synchronously, subsequent calls coalesce within the window", () => {
    const { pi, calls } = fakePi();
    const em = createProgressEmitter(pi, "a1", 250);

    em.schedule(snapshot("first"));
    expect(calls.length).toBe(1);

    em.schedule(snapshot("second"));
    em.schedule(snapshot("third"));
    expect(calls.length).toBe(1); // throttled

    vi.advanceTimersByTime(250);
    expect(calls.length).toBe(2); // single coalesced emission
    expect(calls[1].data.details.displayName).toBe("third"); // latest wins
  });

  it("≤4 emissions per second under continuous schedule", () => {
    const { pi, calls } = fakePi();
    const em = createProgressEmitter(pi, "a1", 250);

    // Schedule 100 times spread over 1 second
    for (let i = 0; i < 100; i++) {
      em.schedule(snapshot(`label-${i}`));
      vi.advanceTimersByTime(10);
    }
    // 1000ms / 250ms window = ~4 emissions max
    expect(calls.length).toBeLessThanOrEqual(5);
  });

  it("flush() always sends the latest state regardless of throttle", () => {
    const { pi, calls } = fakePi();
    const em = createProgressEmitter(pi, "a1", 250);

    em.schedule(snapshot("first"));
    em.schedule(snapshot("second"));
    expect(calls.length).toBe(1);

    em.flush();
    expect(calls.length).toBe(2);
    expect(calls[1].data.details.displayName).toBe("second");
  });

  it("flush() is a no-op when no pending update exists", () => {
    const { pi, calls } = fakePi();
    const em = createProgressEmitter(pi, "a1", 250);

    em.schedule(snapshot("only"));
    expect(calls.length).toBe(1);

    em.flush(); // nothing pending
    expect(calls.length).toBe(1);
  });

  it("dispose() clears the pending timer (no late emission)", () => {
    const { pi, calls } = fakePi();
    const em = createProgressEmitter(pi, "a1", 250);

    em.schedule(snapshot("first"));
    em.schedule(snapshot("queued"));
    expect(calls.length).toBe(1);
    em.dispose();
    vi.advanceTimersByTime(1000);
    expect(calls.length).toBe(1); // queued was discarded
  });
});

// ── createUsageAccumulator ──────────────────────────────────────────────

describe("createUsageAccumulator", () => {
  it("accumulates input/output across message_end events", () => {
    const acc = createUsageAccumulator();
    acc.observe({
      type: "message_end",
      message: { role: "assistant", usage: { input: 100, output: 50, totalTokens: 150 } },
    } as any);
    acc.observe({
      type: "message_end",
      message: { role: "assistant", usage: { input: 30, output: 20, totalTokens: 200 } },
    } as any);
    const totals = acc.totals();
    expect(totals.input).toBe(130);
    expect(totals.output).toBe(70);
    expect(totals.total).toBe(200); // total reflects the latest message's totalTokens
  });

  it("ignores non-message_end events", () => {
    const acc = createUsageAccumulator();
    acc.observe({ type: "agent_start" } as any);
    acc.observe({ type: "tool_execution_start", toolCallId: "x", toolName: "y", args: {} } as any);
    expect(acc.totals()).toEqual({ input: 0, output: 0, total: 0 });
  });

  it("ignores message_end without usage", () => {
    const acc = createUsageAccumulator();
    acc.observe({ type: "message_end", message: { role: "user" } } as any);
    expect(acc.totals()).toEqual({ input: 0, output: 0, total: 0 });
  });
});
