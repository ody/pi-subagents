# 0015. The agent tool runs an ephemeral agent when no type is given

## Context

`subagent_type` is required on the `agent` tool and the nested `agent` tool. A task with no matching registered agent runs the fallback agent, and no call can choose tools, extensions, skills, or prompt mode, so a one-off specialist cannot be expressed.

`subagents:rpc:spawn` already runs an inline definition that never enters the registry.

This builds on ADR 0011 (capability policy) and ADR 0013 (delegation ceiling).

## Decision

Omitting `subagent_type` runs an ephemeral agent built from the call's parameters and the defaults below. An omitted type never goes through type resolution. With `resume`, `subagent_type` is ignored and no ephemeral type is minted. The mention clone's `agent` tool refuses a call whose `subagent_type` is omitted or differs from the mentioned type.

- The tool builds the `AgentConfig` itself and passes it as `options.agentConfig` to `AgentManager.spawn`, with an empty `systemPrompt`. It does not go through `normalizeInlineAgentConfig`.
- The agent never enters the registry, so the `agent` tool's type list, `/agents → Agent types`, and `@handle` type completion never list it.
- There is no system prompt parameter. `prompt` is the task. `prompt_mode: "append"` reuses the session's system prompt and `"replace"` gives the sub-agent preamble and environment block. `replace` is opt-in.
- Rejected: a system prompt parameter, because a model-written persona bypasses the project's conventions and `prompt_mode` already covers both cases.

Parameters:

- Seven parameters are new: `tools`, `disallowed_tools`, `extensions`, `exclude_extensions`, `skills`, `allowed_subagents`, and `prompt_mode`. They apply only to an ephemeral agent. A call that passes one with a `subagent_type` is an error naming the parameter and saying to omit the type to build an agent.
- The existing `model`, `thinking`, `max_turns`, `run_in_background`, `inherit_context`, `isolated`, and `isolation` set plain values for an ephemeral agent. `isolation` stays conditional on `worktreeIsolation`.
- `tools`, `disallowed_tools`, and `exclude_extensions` are `string[]`, and `tools` uses the frontmatter vocabulary of `*`, built-in names, `none`, and `ext:` selectors. `extensions` and `skills` are `boolean | string[]`. `allowed_subagents` is `"all" | string[]`, and `[]` means no nesting. It is refused when `policy.ephemeralNesting` is `false`. `prompt_mode` is `"append" | "replace"`.
- `isolated: true` forces `extensions` and `skills` to `false` and drops `ext:` selectors. A call that passes `isolated: true` with `extensions`, `skills`, or an `ext:` entry in `tools` is refused.

Defaults when a parameter is omitted:

- `prompt_mode: "append"`, so the agent follows the project's AGENTS.md.
- All built-in tools, `extensions: true`, `skills: true`, and `allowed_subagents: []`.
- The session's model, pi's default thinking level as for a registered agent with no `thinking`, `inherit_context: false`, `isolated: false`, and `isolation: off`.
- `max_turns` follows `defaultMaxTurns`. `run_in_background` follows `backgroundByDefault` on the top-level tool and stays foreground on the nested tool.

Identity and lifecycle:

- The tool mints the type as `ephemeral-<8 hex>` before the spawn. The `ephemeral-` prefix is a stable marker that extensions may match on, so an agent file whose name starts with `ephemeral-` is skipped with a warning, like a name containing `:`.
- The handle base is `name` if given, else a slug of `description`, else `agent`, capped at the handle length limit. Handles normally read like `@find-auth-files`. No alias is set.
- The spawn stores `promptMode` and `displayName: "Agent"` on the `AgentRecord`, and every surface that looks up `getConfig(record.type)` reads the record first. The name badge shows `Agent`, and the description shows beside it as for registered agents.
- An ephemeral agent is non-persistent: `persistSession` is `false`. It is steerable and resumable while its record is in memory, and a resume follows the resume rule of ADR 0014. It cannot be reopened once evicted.
- Lifecycle events and `subagents:record` carry the minted type.
- Every value is checked against the capability policy, and a nested ephemeral agent also against the delegation ceiling.

Done check: `npx vitest run test/ephemeral-agent.test.ts` passes. It covers an omitted type, each default, each parameter and the named-agent error, the handle rules, the registry gaining no entry, no tombstone after eviction, the prompt-mode label and a nested ephemeral spawn.

## Consequences

- A fresh model session can run any one-off agent without the user writing a file.
- The model may reach for ephemeral agents over registered ones.
- The schema grows by seven parameters, which every session pays for in the tool description.
- A top-level caller can give an ephemeral agent `allowed_subagents`. Nested children hold no concurrency slot, so the width of a fan-out is bounded only by the parent's turns. `policy.ephemeralNesting: false` turns this off.
- Ephemeral agents lose their conversation on eviction. Revisit if users want to reopen them, which needs the built config stored on `AgentRecord`. Rejected: persisting the built config now, which adds a stored-definition format for an agent the user never wrote.
