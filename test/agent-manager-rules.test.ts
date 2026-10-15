import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  assertValidSpawnCwd,
  DEFAULT_MAX_CONCURRENT,
  DEFAULT_MAX_CONCURRENT_FOREGROUND,
  isTopLevelAgent,
  occupiesForegroundSlot,
  occupiesPoolSlot,
} from "../src/agent-manager-rules.js";

describe("agent manager rules", () => {
  it("keeps the concurrency defaults", () => {
    expect(DEFAULT_MAX_CONCURRENT).toBe(10);
    expect(DEFAULT_MAX_CONCURRENT_FOREGROUND).toBe(0);
  });

  it("recognizes top-level agents", () => {
    expect(isTopLevelAgent({})).toBe(true);
    expect(isTopLevelAgent({ parentAgentId: "parent" })).toBe(false);
  });

  it("charges only top-level background agents to the background pool", () => {
    expect(occupiesPoolSlot({ isBackground: true })).toBe(true);
    expect(occupiesPoolSlot({ isBackground: false })).toBe(false);
    expect(occupiesPoolSlot({ isBackground: true, parentAgentId: "parent" })).toBe(false);
  });

  it("charges only top-level blocking agents to the foreground pool", () => {
    expect(occupiesForegroundSlot({ blocking: true })).toBe(true);
    expect(occupiesForegroundSlot({ blocking: false })).toBe(false);
    expect(occupiesForegroundSlot({ blocking: true, parentAgentId: "parent" })).toBe(false);
  });

  it("accepts unset and existing absolute directories", () => {
    expect(() => assertValidSpawnCwd(undefined)).not.toThrow();
    expect(() => assertValidSpawnCwd(null)).not.toThrow();
    expect(() => assertValidSpawnCwd(tmpdir())).not.toThrow();
  });

  it("rejects invalid cwd values with curated errors", () => {
    expect(() => assertValidSpawnCwd(42)).toThrow('SpawnOptions.cwd must be an absolute path: "42"');
    expect(() => assertValidSpawnCwd("relative/path")).toThrow("SpawnOptions.cwd must be an absolute path");
    expect(() => assertValidSpawnCwd("/path/that/does/not/exist/pi-subagents")).toThrow("SpawnOptions.cwd does not exist");
    expect(() => assertValidSpawnCwd(fileURLToPath(import.meta.url))).toThrow("SpawnOptions.cwd is not a directory");
  });
});
