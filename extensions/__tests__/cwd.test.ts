/**
 * `resolveSubagentCwd`: validation + `cwdScope` for `Agent.cwd`.
 * Real temp dirs and real git repos/worktrees. See change: add-subagent-orchestration.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { resolveChildProjectTrust, resolveSubagentCwd } from "../cwd.js";

let root: string;
let repo: string;
let siblingWt: string;
let foreign: string;
let plain: string;

function git(cwd: string, ...args: string[]): void {
  execFileSync("git", args, { cwd, stdio: "ignore" });
}

beforeAll(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "pi-subagents-cwd-")));
  repo = join(root, "repo");
  foreign = join(root, "foreign");
  plain = join(root, "plain");
  siblingWt = join(root, "wt-x");
  for (const d of [repo, foreign, plain]) mkdirSync(d, { recursive: true });
  for (const r of [repo, foreign]) {
    git(r, "init", "-q");
    git(r, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "init");
  }
  mkdirSync(join(repo, "src", "deep"), { recursive: true });
  mkdirSync(join(repo, ".worktrees"), { recursive: true });
  git(repo, "worktree", "add", "-q", join(repo, ".worktrees", "feat"), "-b", "feat");
  git(repo, "worktree", "add", "-q", siblingWt, "-b", "sib");
  writeFileSync(join(repo, "file.txt"), "x");
  symlinkSync("/", join(repo, "escape"));
  mkdirSync(join(plain, "sub"));
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("resolveSubagentCwd", () => {
  it("absent → parent cwd", () => {
    expect(resolveSubagentCwd(repo, undefined, "repo")).toEqual({ ok: true, cwd: repo });
    expect(resolveSubagentCwd(repo, "  ", "repo")).toEqual({ ok: true, cwd: repo });
  });

  it("relative resolves against the parent cwd", () => {
    expect(resolveSubagentCwd(repo, ".worktrees/feat", "repo")).toEqual({
      ok: true,
      cwd: join(repo, ".worktrees", "feat"),
    });
  });

  it("missing → cwd_not_found", () => {
    const r = resolveSubagentCwd(repo, "nope", "repo");
    expect(r).toMatchObject({ ok: false, reason: "cwd_not_found" });
  });

  it("a file → cwd_not_dir", () => {
    expect(resolveSubagentCwd(repo, "file.txt", "repo")).toMatchObject({ ok: false, reason: "cwd_not_dir" });
  });

  it("symlink escape → cwd_out_of_scope under repo", () => {
    expect(resolveSubagentCwd(repo, "escape", "repo")).toMatchObject({ ok: false, reason: "cwd_out_of_scope" });
  });

  it("subtree of the parent cwd accepted", () => {
    expect(resolveSubagentCwd(repo, "src/deep", "repo")).toEqual({ ok: true, cwd: join(repo, "src", "deep") });
  });

  it("parent's git top-level accepted from a subdirectory parent", () => {
    expect(resolveSubagentCwd(join(repo, "src"), repo, "repo")).toEqual({ ok: true, cwd: repo });
  });

  it("sibling worktree sharing the git common dir accepted", () => {
    expect(resolveSubagentCwd(repo, siblingWt, "repo")).toEqual({ ok: true, cwd: siblingWt });
    // and back: from the sibling worktree into the main checkout
    expect(resolveSubagentCwd(siblingWt, repo, "repo")).toEqual({ ok: true, cwd: repo });
  });

  it("foreign repository rejected under repo", () => {
    expect(resolveSubagentCwd(repo, foreign, "repo")).toMatchObject({ ok: false, reason: "cwd_out_of_scope" });
  });

  it("non-git parent limited to its own subtree", () => {
    expect(resolveSubagentCwd(plain, "sub", "repo")).toEqual({ ok: true, cwd: join(plain, "sub") });
    expect(resolveSubagentCwd(plain, repo, "repo")).toMatchObject({ ok: false, reason: "cwd_out_of_scope" });
  });

  it("any scope accepts any existing directory but still validates existence", () => {
    expect(resolveSubagentCwd(repo, foreign, "any")).toEqual({ ok: true, cwd: foreign });
    expect(resolveSubagentCwd(repo, "escape", "any")).toEqual({ ok: true, cwd: "/" });
    expect(resolveSubagentCwd(repo, "nope", "any")).toMatchObject({ ok: false, reason: "cwd_not_found" });
  });

  it("errors carry a human-readable message naming the path", () => {
    const r = resolveSubagentCwd(repo, foreign, "repo");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toContain(foreign);
  });
});

describe("resolveChildProjectTrust (D3: real pi trust store, never prompts)", () => {
  let agentDir: string;
  let proj: string;

  beforeAll(() => {
    agentDir = join(root, "agent-trust");
    proj = join(root, "trust-proj");
    mkdirSync(agentDir, { recursive: true });
    mkdirSync(join(proj, ".pi", "extensions"), { recursive: true });
    writeFileSync(join(proj, ".pi", "extensions", "x.ts"), "export default () => {};");
    mkdirSync(join(proj, ".worktrees", "x", ".pi", "extensions"), { recursive: true });
  });

  const setTrust = (data: Record<string, boolean>) =>
    writeFileSync(join(agentDir, "trust.json"), JSON.stringify(data));
  const setDefault = (v?: string) =>
    writeFileSync(join(agentDir, "settings.json"), JSON.stringify(v ? { defaultProjectTrust: v } : {}));

  it("no trust-requiring resources → trusted", () => {
    setTrust({});
    setDefault();
    expect(resolveChildProjectTrust(plain, agentDir)).toBe(true);
  });

  it("project extensions, no trust entry, default ask → untrusted (no prompt)", () => {
    setTrust({});
    setDefault();
    expect(resolveChildProjectTrust(proj, agentDir)).toBe(false);
  });

  it("a stored decision on an ancestor applies to a nested worktree", () => {
    setTrust({ [proj]: true });
    setDefault();
    expect(resolveChildProjectTrust(join(proj, ".worktrees", "x"), agentDir)).toBe(true);
    setTrust({ [proj]: false });
    expect(resolveChildProjectTrust(proj, agentDir)).toBe(false);
  });

  it("defaultProjectTrust always → trusted; never → untrusted", () => {
    setTrust({});
    setDefault("always");
    expect(resolveChildProjectTrust(proj, agentDir)).toBe(true);
    setDefault("never");
    expect(resolveChildProjectTrust(proj, agentDir)).toBe(false);
  });
});
