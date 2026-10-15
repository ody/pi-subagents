> DRAFT: not accepted, not current truth.

# NNNN. A caller-supplied model overrides an agent file's model pin

## Context

An agent file's frontmatter outranks `Agent` tool parameters for every field it sets. For `model` that made a pin absolute: a caller's `model` was dropped with no message, so "this agent's model unless I say otherwise" could not be expressed. Upstream closed the request (issue #106) as intended behavior, so the code alone reads like a regression against upstream.

`resolveAgentInvocationConfig` in `src/invocation-config.ts` is the one place both the `Agent` tool (`src/index.ts`) and the nested `Agent` tool (`src/nested-tools.ts`) resolve precedence. Its `modelFromParams` flag feeds `checkModelScope`, which hard-refuses a caller-supplied model and only warns on a frontmatter one.

## Decision

`model` is the only field where the caller wins. Every other frontmatter field stays authoritative over caller parameters.

- `modelInput` is `params.model ?? agentConfig.model`. There is no opt-in frontmatter field; the rule applies to every agent.
- `modelFromParams` is `true` whenever the caller named a model, pin or no pin, so an out-of-scope caller model is still a hard refusal under `scopeModels`.
- A caller model that does not resolve refuses the spawn. Never fall back to the pin.
- The displaced pin is disclosed to the user. `overridden.model` holds the frontmatter pin, carried as `AgentInvocation.pinnedModel` and rendered `(over pinned <pin>)`. A pin that resolves to the winning model is not disclosed.
- No model-facing string mentions pins or precedence. The `model` parameter description tells the model to set it only when the user named a model. The override is the user's, not something the orchestrator reaches for.
- `thinking` keeps frontmatter-wins precedence, so `overridden.thinking` holds the caller's value. The two `overridden` fields carry opposite provenance on purpose.

Done check: `npx vitest run test/invocation-config.test.ts test/agent-model-display.test.ts` passes.

## Consequences

- Reverting to pin-wins silently drops caller models again, and makes `modelFromParams` and the disclosure fields carry the wrong side.
- Advertising the override in the tool schema would let the orchestrator replace pins on its own judgment. Revisit only if orchestrator-chosen models become a goal.
- Extending caller-wins to another field needs its own ADR; `isolation: off` in frontmatter, for one, is documented as the only way to refuse a caller's worktree.
