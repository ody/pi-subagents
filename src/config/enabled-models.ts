import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { ModelEntry } from "./model-resolver.js";

export interface ModelRegistryRef {
  getAll(): unknown[];
  getAvailable?(): unknown[];
}

function settingsPaths(cwd: string): [project: string, global: string] {
  return [
    join(cwd, ".pi", "settings.json"),
    join(getAgentDir(), "settings.json"),
  ];
}

function readField(path: string): string[] | undefined {
  if (!existsSync(path)) return undefined;
  try {
    const raw = JSON.parse(readFileSync(path, "utf-8"));
    if (Array.isArray(raw?.enabledModels)) return raw.enabledModels as string[];
  } catch {
  }
  return undefined;
}

export function readEnabledModels(cwd: string): string[] | undefined {
  const [project, global] = settingsPaths(cwd);
  return readField(project) ?? readField(global);
}

let cachedAllowed: Set<string> | undefined;
let cachedHash = "";
let cachedPatternsKey = "";

function hashOf(path: string): string {
  try {
    const s = statSync(path);
    return `${s.mtimeMs}-${s.size}`;
  } catch {
    return "missing";
  }
}

export function resolveEnabledModels(
  patterns: string[] | undefined,
  registry: ModelRegistryRef,
  cwd: string = process.cwd(),
): Set<string> | undefined {
  const patternsKey = JSON.stringify(patterns);
  const [project, global] = settingsPaths(cwd);
  const fileHash = `${hashOf(project)};${hashOf(global)}`;

  if (fileHash === cachedHash && patternsKey === cachedPatternsKey) {
    return cachedAllowed;
  }

  if (!patterns || patterns.length === 0) {
    cachedHash = fileHash;
    cachedPatternsKey = patternsKey;
    cachedAllowed = undefined;
    return undefined;
  }

  const available = (registry.getAvailable?.() ?? registry.getAll()) as ModelEntry[];
  const allowed = new Set<string>();

  for (const pattern of patterns) {
    const trimmed = pattern.trim();
    if (!trimmed) continue;
    resolveExact(trimmed, available, allowed);
  }

  const result = allowed.size > 0 ? allowed : undefined;
  cachedHash = fileHash;
  cachedPatternsKey = patternsKey;
  cachedAllowed = result;
  return result;
}

export function isModelInScope(
  model: { provider: string; id: string },
  allowed: Set<string>,
): boolean {
  return allowed.has(modelKey(model));
}

function modelKey(model: { provider: string; id: string }): string {
  return `${model.provider}/${model.id}`.toLowerCase();
}

function resolveExact(
  pattern: string,
  available: ModelEntry[],
  allowed: Set<string>,
): void {
  const slashIdx = pattern.indexOf("/");
  if (slashIdx === -1) return;

  const provider = pattern.slice(0, slashIdx).toLowerCase();
  const modelId = pattern.slice(slashIdx + 1).toLowerCase();
  const exact = available.find(
    m => m.provider.toLowerCase() === provider && m.id.toLowerCase() === modelId,
  );
  if (exact) {
    allowed.add(modelKey(exact));
  }
}


