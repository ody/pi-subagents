# 0019. Extensions pass agent definitions inline on subagents:rpc:spawn

## Context

An extension that runs its own agent through `subagents:rpc:spawn` used to need an agent file installed, so the type could resolve. An installed file enters the registry, which offers it to the model through the `agent` tool and to the user through `/agents`. An extension-private agent, such as `pi-advisor`'s reviewer (`codeberg.org/ody/pi-advisor`, issue #2), must not be callable that way.

## Decision

`subagents:rpc:spawn` accepts `options.agentConfig`, a `Partial<AgentConfig>` from `src/types.ts`, and runs that definition for the one spawn.

- The definition never enters the agent registry. The `agent` tool, `/agents`, and `@handle` type completion never see it.
- `type` only names the run: handle, session name, and record. It is not resolved against the registry.
- `normalizeInlineAgentConfig` in `src/triggers/cross-extension-rpc.ts` completes the definition at the RPC boundary, so an inline agent behaves like the same agent written as a file, except that its explicit fields are caller-supplied under the capability policy:
  - `systemPrompt` is required. A missing one, or an empty `type`, is an error envelope.
  - `name` is always `type`. `description` defaults to `options.description`, then `type`.
  - `extensions` and `skills` default to `true`, `promptMode` to `"replace"`, the same as omitted frontmatter. `persistSession` defaults to `false`, and an inline agent persists only when it sets `true` ([ADR 0027](0027-remember-agents.md)).
- `AgentManager.spawn` passes it through to `runAgent`, which uses it in place of `getAgentConfig(type)`.
- `PROTOCOL_VERSION` stays `2`. The field is additive; callers that omit it get the registry path unchanged.

Rejected: shipping an agent file with the extension. It exposes the agent to the `agent` tool and `/agents`.

Done check: `npx vitest run test/rpc-inline-agent.test.ts test/cross-extension-rpc.test.ts` passes.

## Consequences

- Putting inline definitions in the registry would leak extension-private agents to the model and the user.
- `pi-advisor` depends on this field. Removing it or changing its defaults breaks that extension.
- UI surfaces look display names up by type, so inline agents render under the generic display name. An evicted inline agent cannot be reopened by `@handle`, since reopening resolves the type against the registry. Revisit if extensions need either.
