import { isModelInScope, type ModelRegistryRef, readEnabledModels, resolveEnabledModels } from "./enabled-models.js";

let scopeModelsEnabled = false;

export function isScopeModelsEnabled(): boolean { return scopeModelsEnabled; }
export function setScopeModelsEnabled(enabled: boolean): void { scopeModelsEnabled = enabled; }

export type ModelScopeVerdict =
  | { kind: "ok" }
  | { kind: "error"; message: string }
  | { kind: "replace"; message: string; replaced: string };

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
    const list = [...allowed].sort().map(m => `  ${m}`).join("\n");
    return {
      kind: "error",
      message: `Model not in scope: "${modelInput}".\n\nAllowed models (from enabledModels):\n${list}`,
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

export function modelReplacedNote(replaced: string | undefined): string {
  return replaced === undefined ? "" : `Note: model scope replaced out-of-scope model ${replaced} with the session model.\n\n`;
}
