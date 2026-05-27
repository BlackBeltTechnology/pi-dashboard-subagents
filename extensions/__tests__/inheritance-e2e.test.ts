/**
 * End-to-end smoke for context inheritance (task §9.5).
 *
 * Verifies the wiring from a faked parent session → buildInheritedContext →
 * compressParentContext produces the `<parent-context>` block that the
 * subagent's effective prompt is supposed to receive. Does not spin up a
 * real AgentSession (that needs network + auth + a real pi runtime).
 *
 * What this asserts:
 *   - With 3+ user/assistant turn pairs in the fake branch, the resulting
 *     block is non-empty and contains all of them in chronological order.
 *   - The block is wrapped in `<parent-context>` … `</parent-context>`.
 *   - With `inheritContext: false` (via `resolveIsolated` → isolated=true),
 *     no inheritance block is produced.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildInheritedContext } from "../events.js";
import { invalidateSettingsCache, resolveIsolated, saveSettings } from "../settings.js";

let tmpAgentDir: string;

vi.mock("@earendil-works/pi-coding-agent", () => ({
  getAgentDir: () => tmpAgentDir,
}));

beforeEach(() => {
  tmpAgentDir = mkdtempSync(join(tmpdir(), "pi-dashboard-subagents-e2e-"));
  invalidateSettingsCache();
});

afterEach(() => {
  if (tmpAgentDir && existsSync(tmpAgentDir)) rmSync(tmpAgentDir, { recursive: true, force: true });
});

function makeBranch(turnPairs: number): Array<{ type: string; message?: any }> {
  // getBranch returns leaf→root; we build that order directly.
  const entries: Array<{ type: string; message?: any }> = [];
  for (let i = turnPairs - 1; i >= 0; i--) {
    // Newest (leaf) first
    entries.push({ type: "message", message: { role: "assistant", content: `assistant turn ${i}` } });
    entries.push({ type: "message", message: { role: "user", content: `user turn ${i}` } });
  }
  return entries;
}

describe("inheritance end-to-end smoke", () => {
  it("with inheritContext: true and 3+ turn pairs, prompt has <parent-context> block", () => {
    saveSettings({ inheritContext: true, exposeInheritanceInTool: false });

    const ctx = {
      sessionManager: { getBranch: () => makeBranch(3) },
    } as any;

    // Mirror what agent.ts does: resolveIsolated → isolated flag → buildInheritedContext
    const isolated = resolveIsolated(undefined);
    expect(isolated).toBe(false);

    const inherited = buildInheritedContext(ctx, { isolated });
    expect(inherited).toContain("<parent-context>");
    expect(inherited).toContain("</parent-context>");
    expect(inherited).toContain("user turn 0");
    expect(inherited).toContain("user turn 1");
    expect(inherited).toContain("user turn 2");

    // Chronological order: turn 0 (oldest) precedes turn 2 (newest)
    expect(inherited.indexOf("user turn 0")).toBeLessThan(inherited.indexOf("user turn 2"));

    // Confirm the full effective-prompt composition pattern used by agent.ts
    const userPrompt = "Do the thing.";
    const effective = inherited ? `${inherited}\n\n<task>\n${userPrompt}\n</task>` : userPrompt;
    expect(effective).toContain("<parent-context>");
    expect(effective).toContain("<task>");
    expect(effective).toContain("Do the thing.");
  });

  it("with inheritContext: false, no <parent-context> block is produced", () => {
    saveSettings({ inheritContext: false, exposeInheritanceInTool: false });

    const ctx = {
      sessionManager: { getBranch: () => makeBranch(3) },
    } as any;

    const isolated = resolveIsolated(undefined);
    expect(isolated).toBe(true);

    const inherited = buildInheritedContext(ctx, { isolated });
    expect(inherited).toBe("");
  });

  it("with per-call isolated=true (and expose=on), still no inheritance", () => {
    saveSettings({ inheritContext: true, exposeInheritanceInTool: true });

    const ctx = {
      sessionManager: { getBranch: () => makeBranch(3) },
    } as any;

    const isolated = resolveIsolated(true);
    expect(isolated).toBe(true);

    const inherited = buildInheritedContext(ctx, { isolated });
    expect(inherited).toBe("");
  });
});
