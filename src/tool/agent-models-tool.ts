import { defineTool, type ModelRegistry, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { acceptedModelLines, checkModelScope, modelScope, resolvePinnedModel } from "../config/model-scope.js";
import { SUBAGENT_TOOL_NAMES } from "../session/extension-scope.js";

const DESCRIPTION =
  "Check whether the agent tool accepts a model, without starting an agent. " +
  "Use this tool only to check a model the user named. Otherwise omit model and skip this tool. " +
  'The resolver matches a model value fuzzily, so a short name such as "sonnet" usually resolves. ' +
  "A value that matches nothing returns the accepted models, so a failed call needs no extra lookup.";

const GUIDANCE = "Listing a model does not mean to set one. Set model only when the user named a model.";

function acceptedModelReport(scope: Iterable<string> | undefined, registry: ModelRegistry): string {
  return `Accepted models:\n${acceptedModelLines(scope, registry)}`;
}

export function createAgentModelsTool(configCwd?: string): ToolDefinition {
  return defineTool({
    name: SUBAGENT_TOOL_NAMES.MODELS,
    label: "Models",
    description: DESCRIPTION,
    promptSnippet: "Check a model the user named; a short name usually resolves, and a miss returns the accepted models",
    parameters: Type.Object({
      model: Type.Optional(
        Type.String({
          description:
            'Model to check, as "provider/modelId" or a short name (e.g. "haiku"). Omit it to list the accepted models. Set it only when the user named a model.',
        }),
      ),
    }),
    execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => {
      const registry = ctx.modelRegistry;
      const cwd = configCwd ?? ctx.cwd;
      const scope = modelScope(cwd, registry);
      const report = (text: string, isError = false) => ({
        content: [{ type: "text" as const, text: `${text}\n\n${GUIDANCE}` }],
        isError,
        details: {},
      });
      const input = (params.model ?? "").trim();
      if (!input) return report(acceptedModelReport(scope, registry));
      const pinned = resolvePinnedModel(
        { modelInput: input, modelFromParams: true },
        { cwd, modelRegistry: registry },
      );
      if (!pinned.ok) return report(pinned.message, true);
      const model = pinned.pinned;
      if (!model) return report(acceptedModelReport(scope, registry));
      const verdict = checkModelScope({
        model,
        cwd,
        modelRegistry: registry,
        callerSupplied: true,
        agentLabel: "",
        modelInput: input,
      });
      if (verdict.kind === "error") return report(verdict.message, true);
      return report(`Accepted model: ${model.provider}/${model.id}`);
    },
  });
}
