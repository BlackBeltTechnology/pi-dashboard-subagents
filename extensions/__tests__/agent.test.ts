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
  parseAgentMd,
  resolveAgentMdPath,
  selectEffectiveModelRef,
} from "../agent.js";
import activate from "../agent.js";

// Re-route getAgentDir() to a tmp dir per-test.
let tmpAgentDir: string;
let tmpCwd: string;

// Tiny YAML parser sufficient for these tests' fixtures — supports flat
// `key: value` pairs, `key: [a, b]` arrays, and `key: |` literal blocks.
// Real production code uses pi-coding-agent's `parseFrontmatter`; this stub
// keeps the test self-contained without an additional yaml dependency.
function tinyParseFrontmatter<T>(content: string): { frontmatter: T; body: string } {
  const m = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(content);
  if (!m) return { frontmatter: {} as T, body: content };
  const yaml = m[1];
  const body = m[2] ?? "";
  const out: Record<string, unknown> = {};
  const lines = yaml.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const kv = /^([A-Za-z_][A-Za-z0-9_-]*):\s*(.*)$/.exec(line);
    if (!kv) continue;
    const key = kv[1];
    const rest = kv[2];
    if (rest === "|") {
      const buf: string[] = [];
      while (i + 1 < lines.length && /^\s+/.test(lines[i + 1])) {
        buf.push(lines[++i].replace(/^ {2}/, ""));
      }
      out[key] = buf.join("\n");
    } else if (rest.startsWith("[") && rest.endsWith("]")) {
      out[key] = rest
        .slice(1, -1)
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
    } else if (rest === "true" || rest === "false") {
      out[key] = rest === "true";
    } else if (/^-?\d+(\.\d+)?$/.test(rest)) {
      out[key] = Number(rest);
    } else if (
      (rest.startsWith('"') && rest.endsWith('"') && rest.length >= 2) ||
      (rest.startsWith("'") && rest.endsWith("'") && rest.length >= 2)
    ) {
      // Strip surrounding quotes — matches real YAML parser behaviour for
      // "@fast" style references that need quoting per YAML 1.2 reserved
      // indicators.
      out[key] = rest.slice(1, -1);
    } else {
      out[key] = rest;
    }
  }
  return { frontmatter: out as T, body };
}

vi.mock("@earendil-works/pi-coding-agent", () => ({
  getAgentDir: () => tmpAgentDir,
  // The agent.ts default-export path imports several other symbols (defineTool,
  // createAgentSession, SessionManager). The schema + helper tests in this file
  // don't exercise the execute() body, so we only need to stub what we touch.
  defineTool: <T,>(t: T) => t,
  createAgentSession: vi.fn(),
  SessionManager: { inMemory: vi.fn() },
  parseFrontmatter: tinyParseFrontmatter,
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

  it("exposes `model` as an optional string regardless of exposeIsolated", () => {
    for (const exposeIsolated of [false, true]) {
      const s: any = buildAgentParametersSchema(exposeIsolated);
      expect(s.properties.model).toBeDefined();
      expect(s.properties.model.type).toBe("string");
      expect(s.required ?? []).not.toContain("model");
      // Description must teach the three accepted input forms.
      const desc: string = s.properties.model.description ?? "";
      expect(desc).toMatch(/@role/i);
      expect(desc).toMatch(/provider\/model/i);
      expect(desc).toMatch(/bare/i);
    }
  });
});

// ── selectEffectiveModelRef (precedence: args > config) ───────────────

describe("selectEffectiveModelRef", () => {
  it("tool-call arg wins over .md config when both are non-empty", () => {
    expect(selectEffectiveModelRef("@fast", "@coding")).toEqual({ ref: "@fast", source: "args" });
    expect(selectEffectiveModelRef("anthropic/opus", "@coding")).toEqual({
      ref: "anthropic/opus",
      source: "args",
    });
    expect(selectEffectiveModelRef("claude-haiku-4-5", "@coding")).toEqual({
      ref: "claude-haiku-4-5",
      source: "args",
    });
  });

  it(".md config used when args is absent", () => {
    expect(selectEffectiveModelRef(undefined, "@coding")).toEqual({ ref: "@coding", source: "config" });
    expect(selectEffectiveModelRef("", "@coding")).toEqual({ ref: "@coding", source: "config" });
    expect(selectEffectiveModelRef("   ", "@coding")).toEqual({ ref: "@coding", source: "config" });
  });

  it("returns 'none' when both are absent or empty", () => {
    expect(selectEffectiveModelRef(undefined, undefined)).toEqual({ ref: undefined, source: "none" });
    expect(selectEffectiveModelRef("", "")).toEqual({ ref: undefined, source: "none" });
    expect(selectEffectiveModelRef("   ", "   ")).toEqual({ ref: undefined, source: "none" });
    expect(selectEffectiveModelRef(undefined, "")).toEqual({ ref: undefined, source: "none" });
  });

  it("trims whitespace from chosen ref", () => {
    expect(selectEffectiveModelRef("  @fast  ", undefined)).toEqual({ ref: "@fast", source: "args" });
    expect(selectEffectiveModelRef(undefined, "  @coding  ")).toEqual({
      ref: "@coding",
      source: "config",
    });
  });

  it("accepts all three forms transparently in either source", () => {
    // @role
    expect(selectEffectiveModelRef("@research", undefined).ref).toBe("@research");
    // provider/model[:thinking]
    expect(selectEffectiveModelRef("anthropic/claude-haiku-4-5:high", undefined).ref).toBe(
      "anthropic/claude-haiku-4-5:high",
    );
    // bare
    expect(selectEffectiveModelRef("claude-haiku-4-5", undefined).ref).toBe("claude-haiku-4-5");
  });
});

// ── resolveAgentMdPath ──────────────────────────────────────────────────

describe("resolveAgentMdPath", () => {
  // Use a tmp dir for the bundled tier so tests never accidentally see the
  // real `<EXTENSION_ROOT>/agents/Explore.md` shipped with the package.
  let tmpBundledDir: string;
  beforeEach(() => {
    tmpBundledDir = mkdtempSync(join(tmpdir(), "pi-dashboard-subagents-bundled-"));
  });
  afterEach(() => {
    if (tmpBundledDir && existsSync(tmpBundledDir)) {
      rmSync(tmpBundledDir, { recursive: true, force: true });
    }
  });

  it("finds project-level .pi/agents/<type>.md first (source: \"project\")", () => {
    const projectAgents = join(tmpCwd, ".pi", "agents");
    mkdirSync(projectAgents, { recursive: true });
    const target = join(projectAgents, "Scout.md");
    writeFileSync(target, "# Scout");
    expect(resolveAgentMdPath("Scout", tmpCwd, tmpBundledDir)).toEqual({
      path: target,
      source: "project",
    });
  });

  it("falls back to global ~/.pi/agent/agents/<type>.md when no project file (source: \"user\")", () => {
    const globalAgents = join(tmpAgentDir, "agents");
    mkdirSync(globalAgents, { recursive: true });
    const target = join(globalAgents, "Explore.md");
    writeFileSync(target, "# Explore");
    expect(resolveAgentMdPath("Explore", tmpCwd, tmpBundledDir)).toEqual({
      path: target,
      source: "user",
    });
  });

  it("falls back to bundled <EXTENSION_ROOT>/agents/<type>.md when project + user are absent (source: \"bundled\")", () => {
    const target = join(tmpBundledDir, "Helper.md");
    writeFileSync(target, "# Helper");
    expect(resolveAgentMdPath("Helper", tmpCwd, tmpBundledDir)).toEqual({
      path: target,
      source: "bundled",
    });
  });

  it("project wins over user wins over bundled", () => {
    const projectAgents = join(tmpCwd, ".pi", "agents");
    mkdirSync(projectAgents, { recursive: true });
    const globalAgents = join(tmpAgentDir, "agents");
    mkdirSync(globalAgents, { recursive: true });
    const projectPath = join(projectAgents, "Triple.md");
    const globalPath = join(globalAgents, "Triple.md");
    const bundledPath = join(tmpBundledDir, "Triple.md");
    writeFileSync(projectPath, "# project");
    writeFileSync(globalPath, "# user");
    writeFileSync(bundledPath, "# bundled");
    expect(resolveAgentMdPath("Triple", tmpCwd, tmpBundledDir)).toEqual({
      path: projectPath,
      source: "project",
    });
  });

  it("user wins over bundled when project is absent", () => {
    const globalAgents = join(tmpAgentDir, "agents");
    mkdirSync(globalAgents, { recursive: true });
    const globalPath = join(globalAgents, "UserOverBundle.md");
    const bundledPath = join(tmpBundledDir, "UserOverBundle.md");
    writeFileSync(globalPath, "# user");
    writeFileSync(bundledPath, "# bundled");
    expect(resolveAgentMdPath("UserOverBundle", tmpCwd, tmpBundledDir)).toEqual({
      path: globalPath,
      source: "user",
    });
  });

  it("returns undefined when no file exists at any tier", () => {
    expect(resolveAgentMdPath("DoesNotExist", tmpCwd, tmpBundledDir)).toBeUndefined();
  });

  it("returns undefined for path-traversal attempts in the type name", () => {
    expect(resolveAgentMdPath("../../etc/passwd", tmpCwd, tmpBundledDir)).toBeUndefined();
    expect(resolveAgentMdPath("foo/bar", tmpCwd, tmpBundledDir)).toBeUndefined();
    expect(resolveAgentMdPath("", tmpCwd, tmpBundledDir)).toBeUndefined();
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

// ── parseAgentMd ────────────────────────────────────────────────────────

describe("parseAgentMd", () => {
  let tmpDir: string;
  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "pi-dashboard-subagents-parsemd-"));
  });
  afterEach(() => {
    if (tmpDir && existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true });
  });

  function write(name: string, content: string): string {
    const p = join(tmpDir, name);
    writeFileSync(p, content);
    return p;
  }

  it("returns fully populated AgentMdConfig for valid frontmatter", () => {
    const path = write(
      "Full.md",
      [
        "---",
        "model: anthropic/claude-haiku-4-5",
        "tools: [read, grep, bash]",
        "inherit_context: false",
        "description: Fast read-only exploration",
        "prompt: |",
        "  You are an Explore subagent.",
        "  Stay read-only.",
        "---",
        "body content here",
      ].join("\n"),
    );
    const cfg = parseAgentMd(path);
    expect(cfg).toBeDefined();
    expect(cfg!.model).toBe("anthropic/claude-haiku-4-5");
    expect(cfg!.tools).toEqual(["read", "grep", "bash"]);
    expect(cfg!.inherit_context).toBe(false);
    expect(cfg!.description).toBe("Fast read-only exploration");
    expect(cfg!.prompt).toBe("You are an Explore subagent.\nStay read-only.");
  });

  it("returns undefined when the file is missing", () => {
    expect(parseAgentMd(join(tmpDir, "DoesNotExist.md"))).toBeUndefined();
  });

  it("treats the whole file as the prompt body when no frontmatter is present", () => {
    // Convention: a `.md` without `---` block has its entire body fall into
    // `prompt`. Power users who want metadata MUST include the `---` block.
    const path = write("NoFrontmatter.md", "You are a helper agent. Stay safe.");
    const cfg = parseAgentMd(path);
    expect(cfg).toBeDefined();
    expect(cfg!.prompt).toBe("You are a helper agent. Stay safe.");
    // No other fields populated.
    expect(cfg!.model).toBeUndefined();
    expect(cfg!.tools).toBeUndefined();
  });

  it("returns undefined when frontmatter has no recognised field AND body is empty", () => {
    const path = write(
      "EmptyAll.md",
      ["---", "unrelated: value", "---", ""].join("\n"),
    );
    expect(parseAgentMd(path)).toBeUndefined();
  });

  it("uses the markdown body as the prompt when frontmatter omits the prompt field", () => {
    const path = write(
      "BodyAsPrompt.md",
      [
        "---",
        "model: anthropic/claude-haiku-4-5",
        "tools: [read]",
        "---",
        "You are an Explore subagent. Be fast and read-only.",
      ].join("\n"),
    );
    const cfg = parseAgentMd(path);
    expect(cfg).toBeDefined();
    expect(cfg!.prompt).toBe("You are an Explore subagent. Be fast and read-only.");
    expect(cfg!.model).toBe("anthropic/claude-haiku-4-5");
  });

  it("explicit `prompt:` field wins over the markdown body", () => {
    const path = write(
      "ExplicitWins.md",
      [
        "---",
        "prompt: |",
        "  Frontmatter wins.",
        "---",
        "This body should be ignored.",
      ].join("\n"),
    );
    const cfg = parseAgentMd(path);
    expect(cfg).toBeDefined();
    expect(cfg!.prompt).toBe("Frontmatter wins.");
  });

  it("ignores empty/whitespace-only model and description fields", () => {
    const path = write(
      "EmptyFields.md",
      ["---", "model: ", "description:    ", "tools: [read]", "---"].join("\n"),
    );
    const cfg = parseAgentMd(path);
    expect(cfg).toBeDefined();
    expect(cfg!.model).toBeUndefined();
    expect(cfg!.description).toBeUndefined();
    expect(cfg!.tools).toEqual(["read"]);
  });

  it("drops non-string entries from tools and rejects empty arrays", () => {
    const path = write(
      "OddTools.md",
      ["---", "tools: []", "model: anthropic/claude-haiku-4-5", "---"].join("\n"),
    );
    const cfg = parseAgentMd(path);
    expect(cfg).toBeDefined();
    expect(cfg!.tools).toBeUndefined();
    expect(cfg!.model).toBe("anthropic/claude-haiku-4-5");
  });
});

// resolveModelFromRef tests live in extensions/__tests__/model-resolve.test.ts
// (split out as part of change `add-model-resolve-event-with-fallback`).


// ── Activation-handle isolation (change: fix-stale-pi-handle-on-reactivation) ──
//
// The `pi` handle must be bound per-activation via lexical closure. A second
// activate() (as a nested subagent session triggers when it re-loads the
// extension set) must not rebind the handle used by an already-registered tool.

describe("activation handle isolation", () => {
  function fakeHandle() {
    const emitted: any[] = [];
    const tools: any[] = [];
    const pi: any = {
      events: { emit: (channel: string, data: any) => emitted.push({ channel, data }) },
      registerTool: (t: any) => tools.push(t),
      on: () => {},
    };
    return { pi, emitted, tools };
  }

  /** Simulates AgentSession.dispose() invalidating an extension runtime. */
  function invalidate(handle: ReturnType<typeof fakeHandle>) {
    const stale = () => {
      throw new Error("This extension ctx is stale after session replacement or reload.");
    };
    handle.pi.events = {
      get emit(): never {
        return stale();
      },
    };
    handle.pi.registerTool = stale;
  }

  const args = { subagent_type: "test", description: "d", prompt: "p" };

  it("a tool registered by activate(piA) emits through piA after activate(piB)", async () => {
    const a = fakeHandle();
    const b = fakeHandle();
    activate(a.pi);
    activate(b.pi);

    await a.tools[0].execute("call-1", { ...args }, undefined, undefined, { cwd: tmpCwd });

    expect(a.emitted.length).toBeGreaterThan(0);
    expect(b.emitted.length).toBe(0);
  });

  it("invalidating piB does not break the tool registered by activate(piA)", async () => {
    const a = fakeHandle();
    const b = fakeHandle();
    activate(a.pi);
    activate(b.pi);
    invalidate(b);

    await expect(
      a.tools[0].execute("call-1", { ...args }, undefined, undefined, { cwd: tmpCwd }),
    ).resolves.toBeDefined();
  });
});
