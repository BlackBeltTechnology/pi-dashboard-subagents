/**
 * Tests for resolveModelFromRef — covers the primary-then-fallback algorithm
 * defined in spec `subagent-role-aliasing` (change:
 * add-model-resolve-event-with-fallback).
 *
 * The resolver has two paths:
 *   PRIMARY   pi.events.emit("model:resolve", probe)
 *             Handler fills probe.model (success) or probe.error (handler-
 *             reported miss). If neither is set the emit is silent and the
 *             extension falls through to:
 *   FALLBACK  In-process resolution via pi.modelRegistry — handles literal
 *             "provider/id" and bare "id" forms only; "@role" fails cleanly.
 *
 * The tests stub pi.events and pi.modelRegistry — no real SDK is loaded.
 */

import { describe, expect, it } from "vitest";

import { resolveModelFromRef } from "../agent.js";

// ── Tiny pi-handle factory ─────────────────────────────────────────────

type AnyModel = { id: string; provider?: string };
type RegistryStub = {
  find?: (provider: string, id: string) => AnyModel | undefined;
  getAll?: () => AnyModel[];
};

interface MkPiOpts {
  /** Handler installed on `model:resolve`. Omit → silent emit. */
  resolveHandler?: (probe: any) => void;
  /** Multiple handlers, in registration order — for cooperative-handler tests. */
  resolveHandlers?: Array<(probe: any) => void>;
  /** Stub for `pi.modelRegistry`. Omit → no registry. */
  modelRegistry?: RegistryStub;
  /** When true, `pi.events` is undefined (degraded mode). */
  noEvents?: boolean;
  /** When true, the emit() handler call throws — exercises the try/catch. */
  emitThrows?: boolean;
}

function mkPi(opts: MkPiOpts): any {
  const handlers: Array<(probe: any) => void> = [];
  if (opts.resolveHandler) handlers.push(opts.resolveHandler);
  if (opts.resolveHandlers) handlers.push(...opts.resolveHandlers);

  return {
    events: opts.noEvents
      ? undefined
      : {
          emit(channel: string, data: unknown) {
            if (channel !== "model:resolve") return;
            if (opts.emitThrows) throw new Error("boom from handler");
            for (const h of handlers) h(data);
          },
          on() { /* unused in these tests */ },
        },
    modelRegistry: opts.modelRegistry,
  };
}

// ── Tests ──────────────────────────────────────────────────────────────

describe("resolveModelFromRef — PRIMARY path (handler answers)", () => {
  it("handler fills probe.model for @role → resolver returns Model + thinkingLevel; fallback NOT exercised", () => {
    const fakeModel: AnyModel = { id: "deepseek-v4-flash", provider: "opencode-go" };
    let registryFindCalls = 0;
    const pi = mkPi({
      resolveHandler: (probe) => {
        expect(probe.ref).toBe("@fast");
        probe.model = fakeModel;
        probe.resolved = "opencode-go/deepseek-v4-flash";
        probe.thinkingLevel = "medium";
      },
      modelRegistry: {
        find: () => {
          registryFindCalls++;
          return undefined;
        },
      },
    });
    const out = resolveModelFromRef(pi, "@fast", "/tmp/x.md");
    expect(out.error).toBeUndefined();
    expect(out.model).toBe(fakeModel);
    expect(out.thinkingLevel).toBe("medium");
    expect(registryFindCalls).toBe(0); // fallback never ran
  });

  it("handler fills probe.model for provider/model → resolver returns Model", () => {
    const fakeModel: AnyModel = { id: "claude-opus-4", provider: "anthropic" };
    const pi = mkPi({
      resolveHandler: (probe) => {
        if (probe.ref === "anthropic/claude-opus-4") {
          probe.model = fakeModel;
          probe.resolved = "anthropic/claude-opus-4";
        }
      },
    });
    const out = resolveModelFromRef(pi, "anthropic/claude-opus-4", "/tmp/x.md");
    expect(out.error).toBeUndefined();
    expect(out.model).toBe(fakeModel);
  });

  it("handler fills probe.model for bare id → resolver returns Model", () => {
    const fakeModel: AnyModel = { id: "claude-haiku-4-5", provider: "anthropic" };
    const pi = mkPi({
      resolveHandler: (probe) => {
        if (probe.ref === "claude-haiku-4-5") {
          probe.model = fakeModel;
          probe.resolved = "anthropic/claude-haiku-4-5";
        }
      },
    });
    const out = resolveModelFromRef(pi, "claude-haiku-4-5", "/tmp/x.md");
    expect(out.error).toBeUndefined();
    expect(out.model).toBe(fakeModel);
  });

  it("handler reports error for @unknownrole → resolver surfaces error with available.roles hint", () => {
    const pi = mkPi({
      resolveHandler: (probe) => {
        probe.error = `Role "@unknownrole" not in providers.json#roles.`;
        probe.available = { roles: { fast: "x/y", research: "x/z" } };
      },
    });
    const out = resolveModelFromRef(pi, "@unknownrole", "/tmp/research.md");
    expect(out.model).toBeUndefined();
    expect(out.error).toMatch(/Role "@unknownrole" not in providers\.json/);
    expect(out.error).toMatch(/Available roles: @fast, @research/);
    expect(out.error).toMatch(/\/tmp\/research\.md/);
  });

  it("handler-supplied probe carries thinkingLevel through to ModelResolution", () => {
    const fakeModel: AnyModel = { id: "claude-opus-4", provider: "anthropic" };
    const pi = mkPi({
      resolveHandler: (probe) => {
        probe.model = fakeModel;
        probe.thinkingLevel = "high";
      },
    });
    const out = resolveModelFromRef(pi, "anthropic/claude-opus-4:high", "/tmp/x.md");
    expect(out.error).toBeUndefined();
    expect(out.model).toBe(fakeModel);
    expect(out.thinkingLevel).toBe("high");
  });

  it("cooperating handlers: first to set probe.model wins, second is no-op", () => {
    const winner: AnyModel = { id: "first", provider: "p" };
    const loser: AnyModel = { id: "second", provider: "p" };
    const pi = mkPi({
      resolveHandlers: [
        (probe) => {
          if (probe.model) return;
          probe.model = winner;
        },
        (probe) => {
          if (probe.model) return; // early-return idiom
          probe.model = loser;
        },
      ],
    });
    const out = resolveModelFromRef(pi, "p/first", "/tmp/x.md");
    expect(out.model).toBe(winner);
  });

  it("handler throwing surfaces a clear error mentioning the agent path", () => {
    const pi = mkPi({ emitThrows: true });
    const out = resolveModelFromRef(pi, "@fast", "/tmp/agents/Foo.md");
    expect(out.model).toBeUndefined();
    expect(out.error).toMatch(/"model:resolve" handler threw/);
    expect(out.error).toMatch(/boom from handler/);
    expect(out.error).toMatch(/\/tmp\/agents\/Foo\.md/);
  });
});

describe("resolveModelFromRef — FALLBACK path (silent emit, in-process registry)", () => {
  it("silent emit + provider/model → fallback uses registry.find, succeeds", () => {
    const fakeModel: AnyModel = { id: "claude-opus-4", provider: "anthropic" };
    let findArgs: [string, string] | undefined;
    const pi = mkPi({
      modelRegistry: {
        find: (p, m) => {
          findArgs = [p, m];
          return p === "anthropic" && m === "claude-opus-4" ? fakeModel : undefined;
        },
      },
    });
    const out = resolveModelFromRef(pi, "anthropic/claude-opus-4", "/tmp/x.md");
    expect(out.error).toBeUndefined();
    expect(out.model).toBe(fakeModel);
    expect(findArgs).toEqual(["anthropic", "claude-opus-4"]);
  });

  it("silent emit + bare id → fallback uses registry.getAll, first match wins", () => {
    const m1: AnyModel = { id: "claude-haiku-4-5", provider: "anthropic" };
    const m2: AnyModel = { id: "claude-haiku-4-5", provider: "bedrock" };
    const pi = mkPi({
      modelRegistry: {
        find: () => undefined,
        getAll: () => [m1, m2],
      },
    });
    const out = resolveModelFromRef(pi, "claude-haiku-4-5", "/tmp/x.md");
    expect(out.error).toBeUndefined();
    expect(out.model).toBe(m1); // first hit
  });

  it("silent emit + @role → fallback refuses with actionable install hint and agent path", () => {
    const pi = mkPi({
      modelRegistry: { find: () => undefined, getAll: () => [] },
    });
    const out = resolveModelFromRef(pi, "@fast", "/tmp/agents/Researcher.md");
    expect(out.model).toBeUndefined();
    expect(out.error).toMatch(/Cannot resolve role "@fast"/);
    expect(out.error).toMatch(/no "model:resolve" handler is registered/);
    expect(out.error).toMatch(/pi-agent-dashboard/);
    expect(out.error).toMatch(/pi-flows/);
    expect(out.error).toMatch(/\/tmp\/agents\/Researcher\.md/);
  });

  it("silent emit + unknown bare id → fallback errors with available models hint", () => {
    const pi = mkPi({
      modelRegistry: {
        find: () => undefined,
        getAll: () => [
          { id: "claude-haiku-4-5", provider: "anthropic" },
          { id: "gpt-5", provider: "openai" },
          { id: "deepseek-v4", provider: "opencode-go" },
        ],
      },
    });
    const out = resolveModelFromRef(pi, "made-up-model", "/tmp/x.md");
    expect(out.model).toBeUndefined();
    expect(out.error).toMatch(/No model matched "made-up-model"/);
    expect(out.error).toMatch(/Available model ids: .*claude-haiku-4-5/);
    expect(out.error).toMatch(/gpt-5/);
    expect(out.error).toMatch(/\/tmp\/x\.md/);
  });

  it("silent emit + unknown provider/model → fallback errors with auth-hint", () => {
    const pi = mkPi({ modelRegistry: { find: () => undefined, getAll: () => [] } });
    const out = resolveModelFromRef(pi, "anthropic/made-up", "/tmp/x.md");
    expect(out.model).toBeUndefined();
    expect(out.error).toMatch(/"anthropic\/made-up" is not registered or not authenticated/);
    expect(out.error).toMatch(/\/provider/);
    expect(out.error).toMatch(/\/tmp\/x\.md/);
  });

  it("fallback parses :thinking suffix off bare id before registry lookup", () => {
    const fakeModel: AnyModel = { id: "claude-haiku-4-5", provider: "anthropic" };
    let getAllCalled = false;
    const pi = mkPi({
      modelRegistry: {
        find: () => undefined,
        getAll: () => {
          getAllCalled = true;
          return [fakeModel];
        },
      },
    });
    const out = resolveModelFromRef(pi, "claude-haiku-4-5:high", "/tmp/x.md");
    expect(out.error).toBeUndefined();
    expect(out.model).toBe(fakeModel);
    expect(out.thinkingLevel).toBe("high");
    expect(getAllCalled).toBe(true);
  });

  it("fallback parses :thinking suffix off provider/model before registry lookup", () => {
    const fakeModel: AnyModel = { id: "claude-opus-4", provider: "anthropic" };
    let findArgs: [string, string] | undefined;
    const pi = mkPi({
      modelRegistry: {
        find: (p, m) => {
          findArgs = [p, m];
          return fakeModel;
        },
      },
    });
    const out = resolveModelFromRef(pi, "anthropic/claude-opus-4:high", "/tmp/x.md");
    expect(out.error).toBeUndefined();
    expect(out.thinkingLevel).toBe("high");
    expect(findArgs).toEqual(["anthropic", "claude-opus-4"]); // suffix stripped
  });

  it("no events AND no @role → fallback still runs against registry", () => {
    const fakeModel: AnyModel = { id: "claude-haiku-4-5", provider: "anthropic" };
    const pi = mkPi({
      noEvents: true,
      modelRegistry: {
        find: (p, m) => (p === "anthropic" && m === "claude-haiku-4-5" ? fakeModel : undefined),
      },
    });
    const out = resolveModelFromRef(pi, "anthropic/claude-haiku-4-5", "/tmp/x.md");
    expect(out.error).toBeUndefined();
    expect(out.model).toBe(fakeModel);
  });

  it("no events + @role → fails with the no-handler error (same as silent emit)", () => {
    const pi = mkPi({ noEvents: true, modelRegistry: { find: () => undefined } });
    const out = resolveModelFromRef(pi, "@fast", "/tmp/x.md");
    expect(out.model).toBeUndefined();
    expect(out.error).toMatch(/Cannot resolve role "@fast"/);
    expect(out.error).toMatch(/no "model:resolve" handler is registered/);
  });

  it("no registry at all → fails with registry-unavailable error", () => {
    const pi = mkPi({}); // no events handler, no modelRegistry
    const out = resolveModelFromRef(pi, "anthropic/claude-opus-4", "/tmp/x.md");
    expect(out.model).toBeUndefined();
    expect(out.error).toMatch(/Model registry unavailable/);
  });
});

describe("resolveModelFromRef — edge cases", () => {
  it("empty string ref returns an Empty model reference error", () => {
    const pi = mkPi({ modelRegistry: { find: () => undefined } });
    const out = resolveModelFromRef(pi, "", "/tmp/x.md");
    expect(out.error).toMatch(/Empty model reference/);
  });

  it("whitespace-only ref is treated as empty", () => {
    const pi = mkPi({ modelRegistry: { find: () => undefined } });
    const out = resolveModelFromRef(pi, "   ", "/tmp/x.md");
    expect(out.error).toMatch(/Empty model reference/);
  });

  it("handler that fills neither probe.model nor probe.error is treated as silent — fallback runs", () => {
    const fakeModel: AnyModel = { id: "x", provider: "p" };
    const pi = mkPi({
      resolveHandler: () => { /* no-op: doesn't set anything */ },
      modelRegistry: { find: (p, m) => (p === "p" && m === "x" ? fakeModel : undefined) },
    });
    const out = resolveModelFromRef(pi, "p/x", "/tmp/x.md");
    expect(out.error).toBeUndefined();
    expect(out.model).toBe(fakeModel);
  });
});
