/**
 * Working directory of a subagent: validation + `cwdScope` for `Agent.cwd`.
 *
 * `Agent.cwd` is model input, so it is resolved (symlinks followed) and
 * checked before any spawn work. `"repo"` scope accepts the parent cwd
 * subtree, the parent's git top-level, or any worktree sharing the parent's
 * git common dir; `"any"` accepts any existing directory.
 * Git is run argv-form (never through a shell).
 *
 * See change: add-subagent-orchestration (design D2).
 */
import { execFileSync } from "node:child_process";
import { realpathSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";

import {
  hasTrustRequiringProjectResources,
  ProjectTrustStore,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";

import type { CwdScope } from "./settings.js";

export type CwdRejectReason = "cwd_not_found" | "cwd_not_dir" | "cwd_out_of_scope";

export type CwdResolution =
  | { ok: true; cwd: string }
  | { ok: false; reason: CwdRejectReason; message: string };

/** `child` equals `parent` or lies below it (both already real paths). */
function isWithin(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/** `git rev-parse <flag>` in `cwd`, resolved to a real path; undefined outside git. */
function gitPath(cwd: string, flag: "--show-toplevel" | "--git-common-dir"): string | undefined {
  try {
    const out = execFileSync("git", ["rev-parse", flag], {
      cwd,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 5_000,
    }).trim();
    return out ? realpathSync(resolve(cwd, out)) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Resolve `arg` against `parentCwd` and check it. Absent / blank → parent cwd
 * (unchecked: that is today's behavior).
 */
export function resolveSubagentCwd(parentCwd: string, arg: unknown, scope: CwdScope): CwdResolution {
  if (typeof arg !== "string" || arg.trim() === "") return { ok: true, cwd: parentCwd };
  const requested = resolve(parentCwd, arg.trim());
  let real: string;
  try {
    real = realpathSync(requested);
  } catch {
    return { ok: false, reason: "cwd_not_found", message: `cwd does not exist: ${requested}` };
  }
  try {
    if (!statSync(real).isDirectory()) {
      return { ok: false, reason: "cwd_not_dir", message: `cwd is not a directory: ${requested}` };
    }
  } catch {
    return { ok: false, reason: "cwd_not_found", message: `cwd does not exist: ${requested}` };
  }
  if (scope === "any") return { ok: true, cwd: real };

  let parentReal: string;
  try {
    parentReal = realpathSync(parentCwd);
  } catch {
    parentReal = resolve(parentCwd);
  }
  if (isWithin(parentReal, real)) return { ok: true, cwd: real };

  const top = gitPath(parentReal, "--show-toplevel");
  if (top && isWithin(top, real)) return { ok: true, cwd: real };
  const parentCommon = gitPath(parentReal, "--git-common-dir");
  if (parentCommon && gitPath(real, "--git-common-dir") === parentCommon) return { ok: true, cwd: real };

  return {
    ok: false,
    reason: "cwd_out_of_scope",
    message:
      `cwd is outside the allowed scope: ${requested}. With cwdScope "repo" it must be the parent cwd or below, ` +
      `inside the parent's git repository, or a worktree of it.`,
  };
}

/**
 * Whether pi trusts `cwd` for a headless child (design D3). Mirrors pi's
 * non-interactive `resolveProjectTrusted` (not exported): nothing needing
 * trust → trusted; else the nearest stored decision in `<agentDir>/trust.json`;
 * else `defaultProjectTrust` (`"always"` → trusted, `"ask"` / `"never"` →
 * untrusted). Never prompts. Any failure → untrusted.
 */
export function resolveChildProjectTrust(cwd: string, agentDir: string): boolean {
  try {
    if (!hasTrustRequiringProjectResources(cwd)) return true;
    const stored = new ProjectTrustStore(agentDir).get(cwd);
    if (stored === true || stored === false) return stored;
    // Project settings excluded: a project must not vote on its own trust.
    return SettingsManager.create(cwd, agentDir, { projectTrusted: false }).getDefaultProjectTrust() === "always";
  } catch {
    return false;
  }
}
