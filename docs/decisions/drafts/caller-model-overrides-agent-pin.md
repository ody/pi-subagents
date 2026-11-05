> DRAFT: not accepted, not current truth.

# NNNN. A caller-supplied model overrides an agent file's model pin

## Context

Frontmatter is authoritative over `Agent` tool parameters for invocation fields other than `model`. Treating a model pin as absolute drops a caller's explicit `model` with no message, so "this agent's model unless I say otherwise" cannot be expressed.

`resolveAgentInvocationConfig` in `src/tool/invocation-config.ts` is the one place both the top-level resolution (`src/tool/agent-call-resolution.ts`) and the nested `Agent` tool (`src/tool/nested-tools.ts`) resolve precedence. Its `modelFromParams` flag feeds `checkModelScope`, which hard-refuses a caller-supplied model and only warns on a frontmatter one.

## Decision

`model` is the only field where the caller wins. Every other frontmatter field stays authoritative over caller parameters.

- `modelInput` is `params.model ?? agentConfig.model`. There is no opt-in frontmatter field; the rule applies to every registry-backed agent definition: default, user, and skill agents. Inline RPC definitions do not pass through this resolver.
- `modelFromParams` is `true` whenever the caller named a model, pin or no pin, so an out-of-scope caller model is still a hard refusal under `scopeModels`.
- A caller model that does not resolve refuses the spawn. Never fall back to the pin.
- A scheduled job stores the caller's raw model and resolves it again when it fires. If it no longer resolves, that firing fails without spawning. It never substitutes the agent's pin or the spawn default.
- The displaced pin is disclosed to the user. `overridden.model` holds the frontmatter pin, carried as `AgentInvocation.pinnedModel` and rendered `(over pinned <pin>)`. A pin that resolves to the winning model is not disclosed.
- `thinking` keeps frontmatter-wins precedence, so `overridden.thinking` holds the caller's value. The two `overridden` fields carry opposite provenance on purpose.

Done check: `npx vitest run test/invocation-config.test.ts test/agent-model-display.test.ts test/model-scope.test.ts test/nested-tools.test.ts test/schedule.test.ts` passes.

## Consequences

- Reverting to pin-wins silently drops caller models again, and makes `modelFromParams` and the disclosure fields carry the wrong side.
- Extending caller-wins to another field needs its own ADR; `isolation: off` in frontmatter, for one, is documented as the only way to refuse a caller's worktree.
