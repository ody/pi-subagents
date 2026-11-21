import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setLayerKey } from "../../src/config/settings-store.js";

describe("settings store write", () => {
  let cwd: string;

  beforeEach(() => { cwd = mkdtempSync(join(tmpdir(), "settings-store-")); });
  afterEach(() => { rmSync(cwd, { recursive: true, force: true }); });

  it("writes valid JSON and leaves no temporary file behind", () => {
    expect(setLayerKey("project", cwd, "maxConcurrent", 7).ok).toBe(true);
    const dir = join(cwd, ".pi");
    expect(readdirSync(dir)).toEqual(["subagents.json"]);
    expect(JSON.parse(readFileSync(join(dir, "subagents.json"), "utf-8"))).toEqual({ maxConcurrent: 7 });
  });
});
