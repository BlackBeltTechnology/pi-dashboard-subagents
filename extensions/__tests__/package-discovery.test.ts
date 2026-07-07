/**
 * Tests for the tier-4 package-agent discovery (extensions/agent.ts).
 *
 * Covers tasks §5.1–§5.14 of add-package-agent-discovery-tier:
 *   - index build over a temp package layout (basename → { path, pkg })
 *   - deterministic cross-package collision + stderr warning
 *   - tier-4 resolution after project/user/bundled miss
 *   - higher-tier precedence over the package index
 *   - path-traversal guard short-circuits before index lookup
 *   - empty/missing agents dir + non-.md entries tolerated
 *   - undefined installedPath skipped
 *   - defensive degradation (construction throw, list throw) → empty index
 *   - USER-SCOPE ONLY: project scope never indexed (no SDK trust API)
 *   - filtered packages contribute nothing
 *   - same source in both scopes → single user entry, no spurious warning
 *   - resolveAgentMdPath default packageIndex is empty (ignores module cache)
 *   - ensurePackageAgentIndex rebuilds on cwd change
 *
 * The SDK is mocked so `SettingsManager.create` / `DefaultPackageManager` are
 * controllable; `mockState` (via vi.hoisted) drives the enumerated packages
 * and the failure seams. Real temp dirs back `readdirSync`.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Hoisted mutable state driving the mocked package manager. Named `mockState`
// so vitest's mock-hoisting guard permits the factory reference.
const mockState = vi.hoisted(() => ({
  configuredPackages: [] as Array<{
    source: string;
    scope: "user" | "project";
    filtered: boolean;
    installedPath?: string;
  }>,
  listThrows: false,
  constructThrows: false,
  agentDir: "",
}));

vi.mock("@earendil-works/pi-coding-agent", () => ({
  getAgentDir: () => mockState.agentDir,
  defineTool: <T,>(t: T) => t,
  createAgentSession: vi.fn(),
  SessionManager: { inMemory: vi.fn() },
  parseFrontmatter: (content: string) => ({ frontmatter: {}, body: content }),
  SettingsManager: {
    create: (_cwd: string, _agentDir?: string) => ({ __kind: "settings" }),
  },
  DefaultPackageManager: class {
    constructor(_opts: unknown) {
      if (mockState.constructThrows) throw new Error("construct fail");
    }
    listConfiguredPackages() {
      if (mockState.listThrows) throw new Error("list fail");
      return mockState.configuredPackages;
    }
  },
}));

import {
  buildPackageAgentIndex,
  ensurePackageAgentIndex,
  refreshPackageAgentIndex,
  resolveAgentMdPath,
  type PackageAgentIndex,
} from "../agent.js";

let root: string;
let cwd: string;
let agentDir: string;
let bundledDir: string;

/** Create `<root>/<name>/agents/` populated with the given `.md` basenames. */
function makePackage(name: string, agentFiles: string[]): string {
  const dir = join(root, name);
  const agentsDir = join(dir, "agents");
  mkdirSync(agentsDir, { recursive: true });
  for (const f of agentFiles) writeFileSync(join(agentsDir, f), `# ${f}`);
  return dir;
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "pi-pkgdisc-root-"));
  cwd = mkdtempSync(join(tmpdir(), "pi-pkgdisc-cwd-"));
  agentDir = mkdtempSync(join(tmpdir(), "pi-pkgdisc-agentdir-"));
  bundledDir = mkdtempSync(join(tmpdir(), "pi-pkgdisc-bundled-"));
  mockState.configuredPackages = [];
  mockState.listThrows = false;
  mockState.constructThrows = false;
  mockState.agentDir = agentDir;
});

afterEach(() => {
  for (const d of [root, cwd, agentDir, bundledDir]) {
    if (d && existsSync(d)) rmSync(d, { recursive: true, force: true });
  }
});

// ── §5.1 index build ─────────────────────────────────────────────────────

describe("buildPackageAgentIndex", () => {
  it("registers every agents/*.md basename with its originating package (§5.1)", () => {
    const pA = makePackage("pkgA", ["reviewer.md", "planner.md"]);
    const pB = makePackage("pkgB", ["scout.md"]);
    mockState.configuredPackages = [
      { source: "@acme/a", scope: "user", filtered: false, installedPath: pA },
      { source: "@acme/b", scope: "user", filtered: false, installedPath: pB },
    ];
    const idx = buildPackageAgentIndex(cwd, agentDir);
    expect(idx.get("reviewer")).toEqual({ path: join(pA, "agents", "reviewer.md"), pkg: "@acme/a" });
    expect(idx.get("planner")).toEqual({ path: join(pA, "agents", "planner.md"), pkg: "@acme/a" });
    expect(idx.get("scout")).toEqual({ path: join(pB, "agents", "scout.md"), pkg: "@acme/b" });
    expect(idx.size).toBe(3);
  });

  // ── §5.2 collision determinism ─────────────────────────────────────────
  it("collision: lexicographically-smaller source wins, loser dropped + warning (§5.2)", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const pAcme = makePackage("acme", ["reviewer.md"]);
    const pCorp = makePackage("corp", ["reviewer.md"]);
    // Deliberately out of order to prove the sort, not input order, decides.
    mockState.configuredPackages = [
      { source: "@corp/pkg", scope: "user", filtered: false, installedPath: pCorp },
      { source: "@acme/pkg", scope: "user", filtered: false, installedPath: pAcme },
    ];
    const idx = buildPackageAgentIndex(cwd, agentDir);
    expect(idx.get("reviewer")).toEqual({ path: join(pAcme, "agents", "reviewer.md"), pkg: "@acme/pkg" });
    expect(idx.size).toBe(1);
    expect(warn).toHaveBeenCalledTimes(1);
    const msg = String(warn.mock.calls[0][0]);
    expect(msg).toContain("@acme/pkg");
    expect(msg).toContain("@corp/pkg");
    warn.mockRestore();
  });

  // ── §5.6 tolerant scan ─────────────────────────────────────────────────
  it("tolerates missing/empty agents dir and non-.md entries (§5.6)", () => {
    const pNoAgents = join(root, "noagents");
    mkdirSync(pNoAgents, { recursive: true }); // no agents/ subdir at all
    const pEmptyAgents = makePackage("emptyagents", []); // agents/ exists but empty
    const pMixed = makePackage("mixed", ["ok.md"]);
    writeFileSync(join(pMixed, "agents", "README.txt"), "not markdown");
    writeFileSync(join(pMixed, "agents", "notes"), "no extension");
    mockState.configuredPackages = [
      { source: "@a/noagents", scope: "user", filtered: false, installedPath: pNoAgents },
      { source: "@a/emptyagents", scope: "user", filtered: false, installedPath: pEmptyAgents },
      { source: "@a/mixed", scope: "user", filtered: false, installedPath: pMixed },
    ];
    const idx = buildPackageAgentIndex(cwd, agentDir);
    expect(idx.size).toBe(1);
    expect(idx.get("ok")?.pkg).toBe("@a/mixed");
  });

  // ── §5.7 undefined installedPath ───────────────────────────────────────
  it("skips packages with an undefined installedPath (§5.7)", () => {
    const p = makePackage("haspath", ["a.md"]);
    mockState.configuredPackages = [
      { source: "@a/nopath", scope: "user", filtered: false, installedPath: undefined },
      { source: "@a/haspath", scope: "user", filtered: false, installedPath: p },
    ];
    const idx = buildPackageAgentIndex(cwd, agentDir);
    expect(idx.size).toBe(1);
    expect(idx.has("a")).toBe(true);
  });

  // ── §5.8 construction failure ──────────────────────────────────────────
  it("returns an empty index (never throws) when the package manager cannot be built (§5.8)", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    mockState.constructThrows = true;
    let idx: PackageAgentIndex | undefined;
    expect(() => {
      idx = buildPackageAgentIndex(cwd, agentDir);
    }).not.toThrow();
    expect(idx?.size).toBe(0);
    warn.mockRestore();
  });

  // ── §5.9 user-scope only ───────────────────────────────────────────────
  it("indexes user-scope packages only; project-scope is never indexed (§5.9)", () => {
    const pUser = makePackage("u", ["userized.md"]);
    const pProj = makePackage("p", ["pwn.md"]);
    mockState.configuredPackages = [
      { source: "@a/user", scope: "user", filtered: false, installedPath: pUser },
      { source: "@a/proj", scope: "project", filtered: false, installedPath: pProj },
    ];
    const idx = buildPackageAgentIndex(cwd, agentDir);
    expect(idx.has("userized")).toBe(true);
    expect(idx.has("pwn")).toBe(false);
    expect(idx.size).toBe(1);
  });

  // ── §5.10 filtered packages ────────────────────────────────────────────
  it("skips filtered packages even if they ship agents/*.md (§5.10)", () => {
    const p = makePackage("filtered", ["x.md"]);
    mockState.configuredPackages = [
      { source: "@a/filtered", scope: "user", filtered: true, installedPath: p },
    ];
    const idx = buildPackageAgentIndex(cwd, agentDir);
    expect(idx.size).toBe(0);
  });

  // ── §5.11 same source in both scopes ───────────────────────────────────
  it("same source in user+project: single user entry, no spurious collision warning (§5.11)", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const pUser = makePackage("dupuser", ["reviewer.md"]);
    const pProj = makePackage("dupproj", ["reviewer.md"]);
    mockState.configuredPackages = [
      { source: "@a/dup", scope: "user", filtered: false, installedPath: pUser },
      { source: "@a/dup", scope: "project", filtered: false, installedPath: pProj },
    ];
    const idx = buildPackageAgentIndex(cwd, agentDir);
    expect(idx.get("reviewer")).toEqual({ path: join(pUser, "agents", "reviewer.md"), pkg: "@a/dup" });
    expect(idx.size).toBe(1);
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  // ── §5.12 list throw contained ─────────────────────────────────────────
  it("catches a throw from listConfiguredPackages → empty index, never throws (§5.12)", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    mockState.listThrows = true;
    let idx: PackageAgentIndex | undefined;
    expect(() => {
      idx = buildPackageAgentIndex(cwd, agentDir);
    }).not.toThrow();
    expect(idx?.size).toBe(0);
    warn.mockRestore();
  });
});

// ── §5.3–§5.5, §5.13 resolver wiring ──────────────────────────────────────

describe("resolveAgentMdPath tier-4 wiring", () => {
  it("returns the package tier when project/user/bundled all miss (§5.3)", () => {
    const idx: PackageAgentIndex = new Map([
      ["reviewer", { path: "/pkg/agents/reviewer.md", pkg: "@acme/x" }],
    ]);
    expect(resolveAgentMdPath("reviewer", cwd, bundledDir, idx)).toEqual({
      path: "/pkg/agents/reviewer.md",
      source: "package",
      pkg: "@acme/x",
    });
  });

  it("higher tiers win over a package index entry of the same name (§5.4)", () => {
    const idx: PackageAgentIndex = new Map([
      ["reviewer", { path: "/pkg/agents/reviewer.md", pkg: "@acme/x" }],
    ]);

    // project wins
    const projectAgents = join(cwd, ".pi", "agents");
    mkdirSync(projectAgents, { recursive: true });
    const projectPath = join(projectAgents, "reviewer.md");
    writeFileSync(projectPath, "# project");
    expect(resolveAgentMdPath("reviewer", cwd, bundledDir, idx)).toEqual({
      path: projectPath,
      source: "project",
    });
    rmSync(projectPath);

    // user wins (project now absent)
    const userAgents = join(agentDir, "agents");
    mkdirSync(userAgents, { recursive: true });
    const userPath = join(userAgents, "reviewer.md");
    writeFileSync(userPath, "# user");
    expect(resolveAgentMdPath("reviewer", cwd, bundledDir, idx)).toEqual({
      path: userPath,
      source: "user",
    });
    rmSync(userPath);

    // bundled wins (project + user absent)
    const bundledPath = join(bundledDir, "reviewer.md");
    writeFileSync(bundledPath, "# bundled");
    expect(resolveAgentMdPath("reviewer", cwd, bundledDir, idx)).toEqual({
      path: bundledPath,
      source: "bundled",
    });
  });

  it("path-traversal guard short-circuits before the index lookup (§5.5)", () => {
    const idx: PackageAgentIndex = new Map([["x", { path: "/p/agents/x.md", pkg: "@a/x" }]]);
    expect(resolveAgentMdPath("../x", cwd, bundledDir, idx)).toBeUndefined();
    expect(resolveAgentMdPath("a/b", cwd, bundledDir, idx)).toBeUndefined();
    expect(resolveAgentMdPath("a\\b", cwd, bundledDir, idx)).toBeUndefined();
    expect(resolveAgentMdPath("", cwd, bundledDir, idx)).toBeUndefined();
  });

  it("default packageIndex is an empty Map and ignores the module cache (§5.13)", () => {
    const p = makePackage("cachepkg", ["reviewer.md"]);
    mockState.configuredPackages = [
      { source: "@a/c", scope: "user", filtered: false, installedPath: p },
    ];
    // Populate the module-level cache with a package-tier "reviewer".
    refreshPackageAgentIndex(cwd, agentDir);
    // A 3-arg call must NOT consult that cache — default seam is an empty Map.
    expect(resolveAgentMdPath("reviewer", cwd, bundledDir)).toBeUndefined();
  });
});

// ── §5.14 cache lifecycle ─────────────────────────────────────────────────

describe("ensurePackageAgentIndex cache", () => {
  it("rebuilds when cwd changes and serves the cache for the same cwd (§5.14)", () => {
    const cwd1 = mkdtempSync(join(tmpdir(), "pi-pkgdisc-cwd1-"));
    const cwd2 = mkdtempSync(join(tmpdir(), "pi-pkgdisc-cwd2-"));
    try {
      const p1 = makePackage("cwd1pkg", ["one.md"]);
      mockState.configuredPackages = [
        { source: "@a/1", scope: "user", filtered: false, installedPath: p1 },
      ];
      const idx1 = ensurePackageAgentIndex(cwd1, agentDir);
      expect(idx1.has("one")).toBe(true);

      // Different cwd + different config → rebuild.
      const p2 = makePackage("cwd2pkg", ["two.md"]);
      mockState.configuredPackages = [
        { source: "@a/2", scope: "user", filtered: false, installedPath: p2 },
      ];
      const idx2 = ensurePackageAgentIndex(cwd2, agentDir);
      expect(idx2.has("two")).toBe(true);
      expect(idx2.has("one")).toBe(false);

      // Same cwd2 again → cached (config change is NOT picked up without a rebuild).
      const p3 = makePackage("cwd3pkg", ["three.md"]);
      mockState.configuredPackages = [
        { source: "@a/3", scope: "user", filtered: false, installedPath: p3 },
      ];
      const idx3 = ensurePackageAgentIndex(cwd2, agentDir);
      expect(idx3.has("two")).toBe(true);
      expect(idx3.has("three")).toBe(false);
    } finally {
      rmSync(cwd1, { recursive: true, force: true });
      rmSync(cwd2, { recursive: true, force: true });
    }
  });
});
