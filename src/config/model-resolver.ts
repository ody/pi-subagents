import type { Api, Model } from "@earendil-works/pi-ai";

export interface ModelEntry {
  id: string;
  name: string;
  provider: string;
}

export interface ModelRegistry {
  find(provider: string, modelId: string): Model<Api> | undefined;
  getAll(): Model<Api>[];
  getAvailable?(): Model<Api>[];
}

export function describeModel(
  model: { provider: string; id: string; name?: string },
): { modelName: string; modelId: string } {
  return {
    modelName: (model.name ?? model.id).replace(/^Claude\s+/i, "").toLowerCase(),
    modelId: `${model.provider}/${model.id}`,
  };
}

export function getModelLabelFromConfig(model: string): string {
  const name = model.split("/").pop() ?? model;
  return name.replace(/-\d{8}$/, "");
}

function normalizeModelText(text: string): string {
  return text.toLowerCase().replace(/\./g, "-");
}

function scoreModelMatch(m: ModelEntry, query: string): number {
  const id = normalizeModelText(m.id);
  const name = normalizeModelText(m.name);
  const full = normalizeModelText(`${m.provider}/${m.id}`);
  if (id === query || full === query) return 100;
  if (id.includes(query) || full.includes(query)) return 60 + (query.length / id.length) * 30;
  if (name.includes(query)) return 40 + (query.length / name.length) * 20;
  const partMatches = (part: string) =>
    /^\d{8}$/.test(part) || id.includes(part) || name.includes(part) || m.provider.toLowerCase().includes(part);
  return query.split(/[\s\-/]+/).every(partMatches) ? 20 : 0;
}

const MIN_MODEL_MATCH_SCORE = 20;

function bestModelMatch(models: ModelEntry[], query: string): ModelEntry | undefined {
  let best: ModelEntry | undefined;
  let bestScore = 0;
  for (const m of models) {
    const score = scoreModelMatch(m, query);
    if (score > bestScore) {
      bestScore = score;
      best = m;
    }
  }
  return bestScore >= MIN_MODEL_MATCH_SCORE ? best : undefined;
}

export function resolveModel(
  input: string,
  registry: ModelRegistry,
): Model<Api> | string {
  const all = (registry.getAvailable?.() ?? registry.getAll()) as ModelEntry[];
  const availableSet = new Set(all.map(m => `${m.provider}/${m.id}`.toLowerCase()));

  const slashIdx = input.indexOf("/");
  if (slashIdx !== -1) {
    const provider = input.slice(0, slashIdx);
    const modelId = input.slice(slashIdx + 1);
    if (availableSet.has(input.toLowerCase())) {
      const found = registry.find(provider, modelId);
      if (found) return found;
    }
  }

  const bestMatch = bestModelMatch(all, normalizeModelText(input));
  if (bestMatch) {
    const found = registry.find(bestMatch.provider, bestMatch.id);
    if (found) return found;
  }

  if (slashIdx !== -1) {
    const bare = resolveModel(input.slice(slashIdx + 1), registry);
    if (typeof bare !== "string") return bare;
  }

  const modelList = all
    .map(m => `  ${m.provider}/${m.id}`)
    .sort()
    .join("\n");
  return `Model not found: "${input}".\n\nAvailable models:\n${modelList}`;
}
