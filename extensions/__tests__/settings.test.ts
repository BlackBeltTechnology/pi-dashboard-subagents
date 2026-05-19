/**
 * Tests for extensions/settings.ts
 *
 * Covers task §1.6:
 *   - Defaults loaded when file absent
 *   - Partial merge with defaults
 *   - Atomic write + readback
 *   - Cache invalidation
 *   - resolveIsolated four-mode truth table
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  DEFAULT_SETTINGS,
  getSettingsPath,
  invalidateSettingsCache,
  loadSettings,
  resolveIsolated,
  saveSettings,
} from "../settings.js";

// Re-route getAgentDir() to a tmp dir per-test so we don't touch the user's
// real ~/.pi/agent. We do this by stubbing the module's getAgentDir via
// vi.mock. Because pi-coding-agent isn't installed in this checkout, the
// import only resolves at runtime; the mock works against the symbol.

let tmpAgentDir: string;

vi.mock("@mariozechner/pi-coding-agent", () => ({
  getAgentDir: () => tmpAgentDir,
}));

beforeEach(() => {
  tmpAgentDir = mkdtempSync(join(tmpdir(), "pi-dashboard-subagents-test-"));
  invalidateSettingsCache();
});

afterEach(() => {
  if (tmpAgentDir && existsSync(tmpAgentDir)) {
    rmSync(tmpAgentDir, { recursive: true, force: true });
  }
});

describe("loadSettings", () => {
  it("returns DEFAULT_SETTINGS when config file is absent", () => {
    const s = loadSettings();
    expect(s.inheritContext).toBe(DEFAULT_SETTINGS.inheritContext);
    expect(s.exposeInheritanceInTool).toBe(DEFAULT_SETTINGS.exposeInheritanceInTool);
    expect(s.inheritance.recentTurns).toBe(DEFAULT_SETTINGS.inheritance.recentTurns);
    expect(s.inheritance.toolOutputWindow).toBe(DEFAULT_SETTINGS.inheritance.toolOutputWindow);
    expect(s.inheritance.maxChars).toBe(DEFAULT_SETTINGS.inheritance.maxChars);
  });

  it("settings file path is under the configured agent dir", () => {
    const path = getSettingsPath();
    expect(path.startsWith(tmpAgentDir)).toBe(true);
    expect(path.endsWith("config.json")).toBe(true);
  });

  it("merges partial config with defaults", () => {
    const path = getSettingsPath();
    const partial = { inheritContext: false };
    // mkdir handled by saveSettings; we write directly to test partial merge
    const dir = join(tmpAgentDir, "extensions", "pi-dashboard-subagents");
    // saveSettings will create dirs, but we want to test direct file
    saveSettings(partial); // this seeds dir + writes the merge
    invalidateSettingsCache();

    // Now overwrite with a partial payload simulating a hand-edit
    writeFileSync(path, JSON.stringify({ inheritContext: false }));
    invalidateSettingsCache();

    const s = loadSettings();
    expect(s.inheritContext).toBe(false);
    expect(s.exposeInheritanceInTool).toBe(DEFAULT_SETTINGS.exposeInheritanceInTool);
    expect(s.inheritance.recentTurns).toBe(DEFAULT_SETTINGS.inheritance.recentTurns);
  });

  it("falls back to defaults on malformed JSON without throwing", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    // Need to create dir for path to exist; saveSettings does this
    saveSettings({}); // seed
    invalidateSettingsCache();
    writeFileSync(getSettingsPath(), "{not valid json");
    invalidateSettingsCache();

    const s = loadSettings();
    expect(s.inheritContext).toBe(DEFAULT_SETTINGS.inheritContext);
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });
});

describe("saveSettings (atomic write + cache update)", () => {
  it("persists to disk and reflects in next loadSettings()", () => {
    saveSettings({ inheritContext: false });
    const s = loadSettings();
    expect(s.inheritContext).toBe(false);

    // Re-read from disk to confirm persistence
    const onDisk = JSON.parse(readFileSync(getSettingsPath(), "utf-8"));
    expect(onDisk.inheritContext).toBe(false);
    // Defaults preserved for the rest
    expect(onDisk.exposeInheritanceInTool).toBe(false);
  });

  it("merges nested inheritance.* knobs", () => {
    saveSettings({ inheritance: { recentTurns: 10 } as any });
    const s = loadSettings();
    expect(s.inheritance.recentTurns).toBe(10);
    expect(s.inheritance.toolOutputWindow).toBe(DEFAULT_SETTINGS.inheritance.toolOutputWindow);
    expect(s.inheritance.maxChars).toBe(DEFAULT_SETTINGS.inheritance.maxChars);
  });

  it("writes via tmp+rename (no partial files left)", () => {
    saveSettings({ inheritContext: false });
    // The settings dir should NOT contain any .tmp-* leftover
    const path = getSettingsPath();
    const dir = path.substring(0, path.lastIndexOf("/"));
    const entries = require("node:fs").readdirSync(dir);
    const leftover = entries.filter((e: string) => e.includes(".tmp-"));
    expect(leftover.length).toBe(0);
  });
});

describe("invalidateSettingsCache", () => {
  it("forces re-read from disk after external mutation", () => {
    saveSettings({ inheritContext: true });
    expect(loadSettings().inheritContext).toBe(true);

    // External hand-edit
    writeFileSync(
      getSettingsPath(),
      JSON.stringify({ ...DEFAULT_SETTINGS, inheritContext: false }, null, 2),
    );

    // Without invalidating, cache still says true
    expect(loadSettings().inheritContext).toBe(true);

    invalidateSettingsCache();
    expect(loadSettings().inheritContext).toBe(false);
  });
});

describe("resolveIsolated truth table", () => {
  it("expose=off, inherit=true, perCall=undefined → false (inherit)", () => {
    saveSettings({ exposeInheritanceInTool: false, inheritContext: true });
    expect(resolveIsolated(undefined)).toBe(false);
  });

  it("expose=off, inherit=true, perCall=true → false (per-call ignored)", () => {
    saveSettings({ exposeInheritanceInTool: false, inheritContext: true });
    expect(resolveIsolated(true)).toBe(false);
  });

  it("expose=off, inherit=false, perCall=false → true (per-call ignored, global wins)", () => {
    saveSettings({ exposeInheritanceInTool: false, inheritContext: false });
    expect(resolveIsolated(false)).toBe(true);
  });

  it("expose=on, inherit=true, perCall=undefined → false (falls back to global)", () => {
    saveSettings({ exposeInheritanceInTool: true, inheritContext: true });
    expect(resolveIsolated(undefined)).toBe(false);
  });

  it("expose=on, inherit=true, perCall=true → true (per-call wins)", () => {
    saveSettings({ exposeInheritanceInTool: true, inheritContext: true });
    expect(resolveIsolated(true)).toBe(true);
  });

  it("expose=on, inherit=true, perCall=false → false (per-call wins)", () => {
    saveSettings({ exposeInheritanceInTool: true, inheritContext: true });
    expect(resolveIsolated(false)).toBe(false);
  });

  it("expose=on, inherit=false, perCall=true → true (per-call wins)", () => {
    saveSettings({ exposeInheritanceInTool: true, inheritContext: false });
    expect(resolveIsolated(true)).toBe(true);
  });

  it("expose=on, inherit=false, perCall=false → false (per-call wins)", () => {
    saveSettings({ exposeInheritanceInTool: true, inheritContext: false });
    expect(resolveIsolated(false)).toBe(false);
  });
});
