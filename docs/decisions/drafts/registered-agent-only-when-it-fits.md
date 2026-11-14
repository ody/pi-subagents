> DRAFT: not accepted, not current truth.

# NNNN. The model picks a registered agent only when its description fits the job

## Context

A call without `subagent_type` builds an ephemeral agent from the call's parameters (ADR 0023). A registered type whose description does not fit the job does worse than an ephemeral agent built for it.

Delegation text that says "prefer a registered agent", or that requires `subagent_type`, pushes the model to a poor fit.

## Decision

Tool descriptions, parameter descriptions, snippets, and guidelines of the `agent` tool and the nested `agent` tool follow these rules:

- Tell the model to pass `subagent_type` only when a listed type's description matches the job. Otherwise it omits `subagent_type` and builds an ephemeral agent.
- Never say that every call must pass `subagent_type`, and never say "prefer a registered agent" without that fit test.
- A description may state where a tool refuses a call that omits `subagent_type`: the nested tool when `allowed_subagents` is not `all`, and the mention clone's tool.

Done check: `npx vitest run test/agent-tool-description.test.ts test/tool-description-mode.test.ts` passes. The tests assert two things:

- the `agent` tool description in `full` and `compact` mode contains "only when a listed type"
- no registered string says every call must pass `subagent_type`

Rejected: "prefer a registered agent" with no fit test. It pushes the model to a poor fit.

## Consequences

- Without the fit test, the model drops ephemeral agents and runs work on registered types that do not fit.
- The model builds more ephemeral agents. Each such call carries tool and prompt-mode parameters, so it costs more output tokens than a call that names a type.
- Revisit if registered types gain a machine-checkable fit signal that replaces the description match.
