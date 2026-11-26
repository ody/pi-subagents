import type { Api, Model } from "@earendil-works/pi-ai";
import { isModelInScope, type ModelRegistryRef, readEnabledModels, resolveEnabledModels } from "./enabled-models.js";
import { type ModelMatch, type ModelMatchOptions, type ModelRegistry, matchModel } from "./model-resolver.js";
import { SETTING_SPECS } from "./settings-defaults.js";

let scopeModelsEnabled = SETTING_SPECS.scopeModels.default;

export function isScopeModelsEnabled(): boolean { return scopeModelsEnabled; }
export function setScopeModelsEnabled(enabled: boolean): void { scopeModelsEnabled = enabled; }

export type ModelScopeVerdict =
  | { kind: "ok" }
  | { kind: "error"; message: string }
  | { kind: "replace"; message: string; replaced: string };

export function acceptedModels(
  scope: Iterable<string> | undefined,
  registry: ModelRegistryRef,
): string[] {
  const scoped = scope === undefined ? [] : [...scope];
  if (scoped.length > 0) return scoped.sort();
  const available = (registry.getAvailable?.() ?? []) as { provider: string; id: string }[];
  return available.map(model => `${model.provider}/${model.id}`).sort();
}

export function acceptedModelLines(scope: Iterable<string> | undefined, registry: ModelRegistryRef): string {
  return acceptedModels(scope, registry).map(model => `  ${model}`).join("\n");
}

export function resolveModel(
  input: string,
  registry: ModelRegistry,
  options: ModelMatchOptions = {},
): Model<Api> | string {
  const match = matchModel(input, registry, options);
  if (match.kind === "resolved") return match.model;
  const accepted = acceptedModelLines(options.scope, registry);
  if (match.kind === "ambiguous") {
    return `Model "${input}" is ambiguous: ${match.candidates.join(", ")}.\n\nAccepted models:\n${accepted}`;
  }
  return `Model not found: "${input}".\n\nAccepted models:\n${accepted}`;
}

export function checkModelScope(args: {
  model: { provider: string; id: string } | undefined;
  cwd: string;
  modelRegistry: ModelRegistryRef;
  callerSupplied: boolean;
  agentLabel: string;
  modelInput?: string;
}): ModelScopeVerdict {
  const { model, cwd, modelRegistry, callerSupplied, agentLabel, modelInput } = args;
  if (!scopeModelsEnabled || !model) return { kind: "ok" };

  const allowed = resolveEnabledModels(readEnabledModels(cwd), modelRegistry, cwd);
  if (!allowed || isModelInScope(model, allowed)) return { kind: "ok" };

  if (callerSupplied) {
    return {
      kind: "error",
      message: `Model not in scope: "${modelInput}".\n\nAccepted models:\n${acceptedModelLines(allowed, modelRegistry)}`,
    };
  }
  const modelLabel = modelInput ?? `${model.provider}/${model.id}`;
  return {
    kind: "replace",
    replaced: modelLabel,
    message: `Agent "${agentLabel}" pins out-of-scope model "${modelLabel}"; using the session model instead`,
  };
}

export type ScopedModel<M> =
  | { ok: false; message: string }
  | { ok: true; model: M | undefined; replaced?: string; notice?: string };

export function scopeModel<M extends { provider: string; id: string }>(args: {
  pinned: M | undefined;
  sessionModel: M | undefined;
  cwd: string;
  modelRegistry: ModelRegistryRef;
  callerSupplied: boolean;
  agentLabel: string;
  modelInput?: string;
}): ScopedModel<M> {
  const { pinned, sessionModel, ...rest } = args;
  const verdict = checkModelScope({ ...rest, model: pinned });
  if (verdict.kind === "error") return { ok: false, message: verdict.message };
  if (verdict.kind === "replace") {
    return { ok: true, model: sessionModel, replaced: verdict.replaced, notice: verdict.message };
  }
  return { ok: true, model: pinned ?? sessionModel };
}

export interface ModelRequest {
  modelInput?: string;
  modelFromParams: boolean;
}

export interface ModelResolutionEnv {
  cwd: string;
  modelRegistry: ModelRegistry;
}

export function modelScope(cwd: string, modelRegistry: ModelRegistry): Iterable<string> | undefined {
  if (!scopeModelsEnabled) return undefined;
  return resolveEnabledModels(readEnabledModels(cwd), modelRegistry, cwd);
}

export function resolveModelMatch(input: string | undefined, env: ModelResolutionEnv): ModelMatch {
  const trimmed = input?.trim();
  if (!trimmed) return { kind: "unspecified" };
  return matchModel(trimmed, env.modelRegistry, { scope: modelScope(env.cwd, env.modelRegistry) });
}

export function resolvePinnedModel(
  request: ModelRequest,
  env: ModelResolutionEnv,
): { ok: true; pinned: Model<Api> | undefined } | { ok: false; message: string } {
  const input = request.modelInput?.trim();
  if (!input) return { ok: true, pinned: undefined };
  const resolved = resolveModel(input, env.modelRegistry, { scope: modelScope(env.cwd, env.modelRegistry) });
  if (typeof resolved !== "string") return { ok: true, pinned: resolved };
  return request.modelFromParams ? { ok: false, message: resolved } : { ok: true, pinned: undefined };
}

export function resolveScopedModel(
  request: ModelRequest,
  env: {
    sessionModel: Model<Api> | undefined;
    cwd: string;
    modelRegistry: ModelRegistry;
    notify: (message: string, level: "warning") => void;
  },
  agentLabel: string,
): { ok: false; message: string } | { ok: true; model: Model<Api> | undefined; replaced: string | undefined } {
  const pinned = resolvePinnedModel(request, { cwd: env.cwd, modelRegistry: env.modelRegistry });
  if (!pinned.ok) return pinned;
  const scoped = scopeModel({
    pinned: pinned.pinned,
    sessionModel: env.sessionModel,
    cwd: env.cwd,
    modelRegistry: env.modelRegistry,
    callerSupplied: request.modelFromParams,
    agentLabel,
    modelInput: request.modelInput,
  });
  if (!scoped.ok) return scoped;
  if (scoped.notice) env.notify(scoped.notice, "warning");
  return { ok: true, model: scoped.model, replaced: scoped.replaced };
}

export function modelReplacedNote(replaced: string | undefined): string {
  return replaced === undefined ? "" : `Note: model scope replaced out-of-scope model ${replaced} with the session model.\n\n`;
}
