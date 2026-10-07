// Guards the private-field read in getParentModelRuntime against the REAL
// pi ModelRegistry class (no mocks), so an upstream rename fails CI.
import { describe, expect, it } from "vitest";
import { ModelRegistry, type ModelRuntime } from "@earendil-works/pi-coding-agent";
import { getParentModelRuntime } from "../agent.js";

describe("getParentModelRuntime (real pi ModelRegistry)", () => {
  it("returns the runtime the parent registry wraps", () => {
    const runtime = { marker: true } as unknown as ModelRuntime;
    const registry = new ModelRegistry(runtime);
    expect(getParentModelRuntime({ modelRegistry: registry } as any)).toBe(runtime);
  });
});
