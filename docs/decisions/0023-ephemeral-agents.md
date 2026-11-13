# 0023. The agent tool runs an ephemeral agent when the call names no type

Replaces: 0015-ephemeral-agents, last present in 503bd9e

## Context

`subagent_type` is optional on the `agent` tool and the nested `agent` tool. No registered agent can express a one-off specialist, because a call cannot choose tools, extensions, skills, or prompt mode. `subagents:rpc:spawn` already runs an inline definition that never enters the registry.

An ephemeral agent has a handle and a conversation worth keeping, like a registered agent. `@handle` cannot reopen it after the manager evicts its record. The tombstone holds only a type, and the registry cannot resolve a minted `ephemeral-<8 hex>` type.

This builds on ADR 0011 (capability policy) and ADR 0013 (delegation ceiling).

## Decision

A call without `subagent_type` runs an ephemeral agent built from the call's parameters and the defaults below. That call never goes through type resolution. With `resume`, the tool ignores `subagent_type` and mints no ephemeral type. The mention clone's `agent` tool refuses a call that omits `subagent_type` or names a different type from the mention.

- The tool builds the `AgentConfig` itself and passes it as `options.agentConfig` to `AgentManager.spawn`, with an empty `systemPrompt`. It does not go through `normalizeInlineAgentConfig`.
- The agent never enters the registry, so the `agent` tool's type list, `/agents → Agent types`, and `@handle` type completion never list it.
- There is no system prompt parameter. `prompt` is the task. `prompt_mode: "append"` reuses the session's system prompt, and `"replace"` gives the sub-agent preamble and environment block. `replace` is opt-in.
- Rejected: a system prompt parameter. A model-written persona bypasses the project's conventions, and `prompt_mode` already covers both cases.

Parameters:

- Seven parameters configure an ephemeral agent: `tools`, `disallowed_tools`, `extensions`, `exclude_extensions`, `skills`, `allowed_subagents`, and `prompt_mode`. They apply only to an ephemeral agent. A call that passes one with a `subagent_type` is an error. The error names the parameter and says to omit the type to build an agent.
- The existing `model`, `thinking`, `max_turns`, `run_in_background`, `inherit_context`, `isolated`, and `isolation` set plain values for an ephemeral agent. `isolation` stays conditional on `worktreeIsolation`.
- `tools`, `disallowed_tools`, and `exclude_extensions` are `string[]`. `tools` uses the frontmatter vocabulary of `*`, built-in names, `none`, and `ext:` selectors.
- `extensions` and `skills` are `boolean | string[]`. `prompt_mode` is `"append" | "replace"`.
- `allowed_subagents` is `"all" | string[]`, and `[]` means no nesting. The tool refuses it when `policy.ephemeralNesting` is `false`.
- `isolated: true` forces `extensions` and `skills` to `false` and drops `ext:` selectors. The tool refuses a call that passes `isolated: true` with `extensions`, `skills`, or an `ext:` entry in `tools`.

Defaults for a parameter the call leaves out:

- `prompt_mode: "append"`, so the agent follows the project's AGENTS.md.
- All built-in tools, `extensions: true`, `skills: true`, and `allowed_subagents: []`.
- The session's model, pi's default thinking level as for a registered agent with no `thinking`, `inherit_context: false`, `isolated: false`, and `isolation: off`.
- `max_turns` follows `defaultMaxTurns`. `run_in_background` follows `backgroundByDefault` on the top-level tool and stays foreground on the nested tool.

Identity:

- The tool mints the type as `ephemeral-<8 hex>` before the spawn. The `ephemeral-` prefix is a stable marker that extensions may match on. The loader skips an agent file whose name starts with `ephemeral-`, with a warning, as it does for a name containing `:`.
- The handle base is `name` if the call has one, else a slug of `description`, else `agent`, capped at the handle length limit. Handles normally read like `@find-auth-files`. The agent gets no alias.
- The spawn stores `promptMode` and the `displayName` on the `AgentRecord`, and every surface that looks up `getConfig(record.type)` reads the record first.
- The name badge is `name`, else the first three words of `description`, title-cased, else `Agent`. The description shows beside it as for registered agents.
- Lifecycle events and `subagents:record` carry the minted type.

Persistence and reopening:

- A top-level ephemeral agent persists its session as any top-level agent does. `rememberAgents` decides, and no parameter overrides it. A nested ephemeral agent never persists.
- The `AgentRecord` stores the built `AgentConfig`, and the agent's tombstone copies it. `@handle` then reopens an evicted ephemeral agent without a registry entry.
- A reopen runs the stored config as a new session under the same minted type and reclaims the handle.
- The capability policy treats the stored values as it treats an agent file's values. It filters what the policy now denies and notifies the user. It refuses only when filtering empties an explicit tool list, as ADR 0011 says for a file's values.
- A live ephemeral agent is steerable and resumable, and a resume follows the resume rule of ADR 0014.

Capability checks:

- The capability policy checks every value. For a nested ephemeral agent, the delegation ceiling checks it too.

Done check: `npx vitest run test/ephemeral-agent.test.ts` passes. It covers:

- an omitted type, each default, each parameter, and the named-agent error
- the handle rules and the registry gaining no entry
- a tombstone carrying the config after eviction, and none when `rememberAgents` is off or the agent has a parent
- a reopen under a policy that now denies a stored tool
- the prompt-mode label and a nested ephemeral spawn

## Consequences

- A fresh model session can run any one-off agent without the user writing a file.
- The model may reach for ephemeral agents over registered ones.
- The schema grows by seven parameters, which every session pays for in the tool description.
- A top-level caller can give an ephemeral agent `allowed_subagents`. Nested children hold no concurrency slot, so only the parent's turns bound the width of a fan-out. `policy.ephemeralNesting: false` turns this off.
- With `rememberAgents` on, every top-level ephemeral agent leaves a session file and a tombstone that holds its tool, extension, and skill lists in memory. Users who do not want that set `rememberAgents: false`.
- Rejected: a per-call persist parameter. It grows the schema again, and `rememberAgents` already decides.
- Revisit if sessions need a retention limit, since nothing prunes them.
