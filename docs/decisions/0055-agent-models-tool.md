# 0055. `agent_models` checks which models an agent call accepts

## Context

A spawn accepts a caller `model` only if the resolver finds it (ADR 0053) and, with `scopeModels` on, `enabledModels` allows it (ADR 0024). A caller that names a model cannot learn the accepted set without a failed spawn.

A caller wants to confirm a user-named model before it starts an agent. The host gives it no check that matches the resolver, because the resolver matches fuzzily and the scope narrows the set.

ADR 0031 says a model passes `model` only when the user named one. A tool that lists models invites a model to compare them and choose.

## Decision

The extension registers a read-only tool `agent_models`. It reports what the `agent` tool accepts as `model`, by running the same resolution and scope check as a spawn, without spawning.

### Accepted set

1. The accepted set is the models in scope when the session scopes models. The session scopes models when `scopeModels` is on and `enabledModels` resolves to a non-empty set (ADR 0024).
2. Otherwise the accepted set is pi's available models (ADR 0053).
3. One function in `src/config/model-scope.ts` returns the accepted set. The tool, the not-found refusal, the ambiguity refusal, and the scope refusal all list that set, as `provider/id` lines sorted lexically.

### Behavior

1. With no parameter, the tool lists the accepted set.
2. With the optional `model` parameter, the tool runs the resolver and the scope check on that string. It reports the `provider/id` a spawn would use. A miss, an ambiguity, or a scope refusal returns the text a spawn refusal returns.
3. A blank `model` counts as absent.
4. The result never names an agent's configured `model` and never ranks models (ADR 0031). It states that listing a model does not mean to set one. It tells the model to set `model` only when the user named a model.
5. The tool never spawns, never changes state, and never writes an `agent:record` entry.

### Registration

1. The name is `agent_models`. It is in `SUBAGENT_TOOL_NAMES` and `NESTED_TOOL_NAMES`. Every registered name is `agent` or `agent_` followed by a lowercase snake_case action.
2. An agent holds `agent_models` exactly when it holds `agent`.
3. `allowed_subagents` does not narrow it. `policy.tools` neither grants nor denies it.
4. Extension-tool inheritance excludes it, as it excludes the other `agent` family tools (`EXCLUDED_TOOL_NAMES`).

### Guidance text

The tool description and prompt snippet tell the model, in this order:

1. Use this tool only to check a model the user named. Otherwise omit `model` and skip this tool.
2. The resolver matches a `model` value fuzzily, so a short name such as `sonnet` usually resolves.
3. A value that matches nothing returns the accepted models, so a failed call needs no extra lookup.

The text names no host tool (ADR 0020).

### Done check

`npx vitest run test/tool/agent-models-tool.test.ts test/tool/tool-names.test.ts test/tool/agent-tool-description.test.ts test/config/model-scope.test.ts` passes, with tests for:

- the full catalog, and the scoped set when `scopeModels` is on with a non-empty `enabledModels`
- the full catalog when `scopeModels` is on and `enabledModels` is missing or resolves to an empty set
- a resolved, an ambiguous, an unmatched, and an out-of-scope `model`, each listing the accepted set
- a blank `model`
- the guidance order, and the absence of a configured `model` and of host tool names
- registration on the top-level and nested sets, and the tool name rule
- the exclusion from extension-tool inheritance, and `policy.tools` having no effect on the tool

## Consequences

- The tool adds a round trip before a spawn.
- The tool shows a model the whole accepted set, which can tempt it to pass `model` unasked. The guidance text and ADR 0031 are the only brake. Revisit if models still pass `model` unasked.
- The tool, the refusals, and the scope check share one function. A second list builder would drift from the spawn.
- A refusal that lists the scoped set hides out-of-scope models from a model that asked for one. That matches what the spawn accepts.

Rejected: a model list inside the `agent` tool description. It costs tokens on every turn and invites model comparison (ADR 0031).

Rejected: no tool, relying on the refusal text alone. It gives no check before a spawn.
