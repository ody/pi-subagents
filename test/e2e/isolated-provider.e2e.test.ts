import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

const pi = (await import("@earendil-works/pi-coding-agent")) as Record<string, unknown>;
const ModelRuntime = pi.ModelRuntime as
  | { create(opts?: Record<string, unknown>): Promise<ModelRuntimeLike> }
  | undefined;

const MIGRATED = typeof ModelRuntime?.create === "function";
const RT = ModelRuntime as { create(opts?: Record<string, unknown>): Promise<ModelRuntimeLike> };

interface ModelRuntimeLike {
  registerProvider(id: string, config: Record<string, unknown>): void;
}

const tmpDirs: string[] = [];
afterAll(() => {
  for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe.skipIf(!MIGRATED)("PR #152 reach: real ModelRegistry exposes .runtime (Pi >= 0.80.8)", () => {
  it("ctx.modelRegistry.runtime is reachable and IS the runtime it wraps", async () => {
    const dir = mkdtempSync(join(tmpdir(), "iso-prov-"));
    tmpDirs.push(dir);
    const runtime = await RT.create({
      authPath: join(dir, "auth.json"),
      modelsPath: join(dir, "models.json"),
      allowModelNetwork: false,
    });

    const indexUrl = import.meta.resolve("@earendil-works/pi-coding-agent");
    const mrUrl = indexUrl.replace(/index\.js$/, "core/model-registry.js");
    const { ModelRegistry } = (await import(mrUrl)) as {
      ModelRegistry: new (rt: ModelRuntimeLike) => { runtime?: unknown };
    };

    const facade = new ModelRegistry(runtime);
    expect((facade as { runtime?: unknown }).runtime).toBe(runtime);
  });
});
