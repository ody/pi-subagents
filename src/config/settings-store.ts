import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { globalSettingsPath, projectSettingsPath } from "./settings-paths.js";

export type SettingsLayer = "global" | "project";

export type LayerRead =
  | { ok: true; exists: boolean; data: Record<string, unknown> }
  | { ok: false; reason: string };

export type LayerWrite = { ok: true } | { ok: false; reason: string };

export function layerPath(layer: SettingsLayer, cwd: string): string {
  return layer === "global" ? globalSettingsPath() : projectSettingsPath(cwd);
}

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function readLayerFile(layer: SettingsLayer, cwd: string): LayerRead {
  const path = layerPath(layer, cwd);
  if (!existsSync(path)) return { ok: true, exists: false, data: {} };
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf-8"));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return { ok: false, reason: `${path} must contain a JSON object` };
    }
    return { ok: true, exists: true, data: parsed as Record<string, unknown> };
  } catch (err) {
    return { ok: false, reason: `${path} cannot be parsed (${describeError(err)})` };
  }
}

export function updateLayerFile(
  layer: SettingsLayer,
  cwd: string,
  mutate: (data: Record<string, unknown>) => void,
): LayerWrite {
  const read = readLayerFile(layer, cwd);
  if (!read.ok) {
    console.warn(`[pi-subagents] Not saving settings: ${read.reason}. Fix the file so its contents are not lost.`);
    return read;
  }
  const path = layerPath(layer, cwd);
  try {
    mutate(read.data);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(read.data, null, 2), "utf-8");
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: `${path} cannot be written (${describeError(err)})` };
  }
}

export function setLayerKey(layer: SettingsLayer, cwd: string, key: string, value: unknown): LayerWrite {
  return updateLayerFile(layer, cwd, (data) => {
    if (value === undefined) delete data[key];
    else data[key] = value;
  });
}
