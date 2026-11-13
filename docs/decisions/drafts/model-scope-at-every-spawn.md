> DRAFT: not accepted, not current truth.

# NNNN. Model scope bounds the model of every new agent

## Context

`scopeModels` is off by default. When on, `checkModelScope` validates a model against pi's `enabledModels` (global and project `settings.json`, project winning).

It runs only where a call resolves a model. Those places are the `agent` tool (`src/tool/agent-call-resolution.ts`), the nested `agent` tool (`src/tool/nested-tools.ts`), and `subagents:rpc:spawn` for a caller-supplied model (`src/triggers/cross-extension-rpc.ts`). It does not run on `@handle` direct starts, tombstone reopens, or the registry `spawn`.

For a model that is not caller-supplied, such as an agent file's pin, the check only warns, and the agent runs on the out-of-scope model.

## Decision

With `scopeModels` on and an `enabledModels` list present, every new agent session runs on an in-scope model, whichever path starts it. With `scopeModels` off, or no `enabledModels` list, the check bounds nothing.

- The check runs at every site that calls `resolveCapability` (ADR 0011): the `agent` tool, the nested tool, mentions, `subagents:rpc:spawn`, the registry `spawn`, and tombstone reopens.
- A caller-supplied model outside the scope refuses the spawn with the allowed list.
- The check replaces an agent file's pinned model that is outside the scope with the session model.
- An agent that names no model runs on the session model, and the check never examines the session model.
- A replacement notifies the user at every site.
- The `agent` tools add a note about a replacement to the tool result.
- The `subagents:rpc:spawn` reply gains `modelReplaced`, the out-of-scope model it replaced, next to `filtered`. `docs/rpc.md` documents the field.
- The registry `spawn` still returns only the id.
- Resuming a live agent keeps its session and model and skips the check.
- The check re-reads `enabledModels` every time, so an edit applies without a restart.
- `scopeModels` stays a `/agents` setting, default off. It is separate from the capability policy and does not move into `policy`.

Done check: `npx vitest run test/model-scope.test.ts` passes. It covers:

- each spawn site
- the replacement and its disclosure on each channel
- the unchecked session model
- no bound when the setting is off or no list exists

## Consequences

- An agent file that pins an out-of-scope model keeps working on the session model, and the user gets told.
- A user who selects an out-of-scope session model can still run agents that name no model.
- ADR 0011's Context paragraph about where `checkModelScope` does not run becomes false. Whoever accepts this draft trims that paragraph.
- Revisit if scoping should become a `policy` field alongside tools, extensions, and skills.
