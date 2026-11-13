# 0017. The extension ships no default agents

## Context

`src/agents/default-agents.ts` ships `general-purpose`, `Explore`, and `Plan`, generic agents the user is better placed to provide. The defaults are woven in:

- The registry overlays them first, below every user and skill agent, and ADR 0018 states the precedence without them.
- `resolveSpawnType` falls back to `general-purpose`, and `getConfig` takes labels from it for unregistered types.
- The wizard spawns it, and `agent-runner.ts` reads it as a last resort.
- `fallbackSubagent` and `disableDefaultAgents` exist only because of them.

An empty registry is workable only with ephemeral agents, so this builds on ADR 0023 (ephemeral agents).

## Decision

The extension ships no agent definitions. Registered agents come from user files and skills only.

- No source file defines an agent configuration, and `DEFAULT_AGENT_NAMES` does not exist. `AgentConfig` has no `isDefault` field and no `"default"` source, and `/agents` offers no Reset to default.
- `fallbackSubagent` and `disableDefaultAgents` do not exist, and the settings events drop them. `PROTOCOL_VERSION` stays `2`. The loader ignores a persisted key.
- A type that does not resolve to exactly one enabled agent is an error that lists the enabled types. Only the `agent` tool's message suggests omitting the type for a one-off agent. An empty `type` on `subagents:rpc:spawn` without `agentConfig` is an error envelope.
- `fellBackFrom` and `fallbackNote` do not exist. Stored references to a removed type fail at use with the type named.
- `getConfig` for an unregistered type returns a fixed generic display config that names no agent type and carries no prompt-mode label. `runAgent` with neither an inline definition nor a registered type throws.
- The extension has no agent creation wizard. `/agents` offers no create entry, and `src/ui/create-agent-wizard.ts` does not exist. Users write agent files by hand.
- No model-facing or user-facing text, README included, refers to default or built-in agents or names an agent type as a literal. The `/agents` empty-state message points to agent files. Type names reach the model only through the list generated from the registry, and an empty registry produces no list.

Done check: `npm run check` passes, and `grep -rni "default-agents\|DEFAULT_AGENT\|isDefault\|disableDefaultAgents\|DefaultsDisabled\|fallbackSubagent\|fellBackFrom\|fallbackNote\|NO_FALLBACK\|e\.g\. Explore\|create-agent-wizard\|showCreateWizard" src README.md docs/rpc.md` returns nothing. `test/agent-types.test.ts` asserts an empty registry yields no types and an unresolved type is an error.

## Consequences

- A fresh install has no named agents until the user or a skill adds one.
- An extension that spawns a default type through `subagents:rpc:spawn` now gets an error envelope. So does one that relies on the implicit fallback for an unknown type. Both must pass an inline definition.
- Rejected: shipping the defaults but off by default, which keeps the code paths and settings this removes. Rejected: shipping them as a bundled skill, since users then get the same generic agents under another name.
- Revisit if users routinely hand-install the same generic agent.
