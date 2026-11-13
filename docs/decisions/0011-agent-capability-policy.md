# 0011. A capability policy bounds the tools, extensions, and skills of every new agent

## Context

Nothing bounds which tools, extensions, or skills a new agent gets. Users write agent files and skills ship them, so the extension does not trust a file. An RPC or registry inline definition can already choose any of them.

`scopeModels` bounds models only, and ADR 0024 sets where its check runs.

No single funnel exists. The `agent` tool, the nested tool, and the creation wizard call `AgentManager.spawn` or `spawnAndWait` directly. RPC, the registry entry, and mentions go through `spawnResolved`. Every new session ends in `spawnAgent`, and `runAgent` re-reads the agent's config by type when it launches.

The `agent` tools take tools, extensions, and skills parameters only for an ephemeral agent (ADR 0023), so only those calls carry caller-supplied capability values. ADR 0013 (delegation ceiling) builds on this, and ADR 0017 (no shipped default agents) removes the wizard spawn site.

## Decision

A policy allows or denies tools, extensions, and skills for every new agent. Its file format and merge rules are ADR 0022's. No policy allows everything.

Matching:

- Built-in tool names match exactly. A bare name in a deny list that is not a built-in matches any tool of that name. `ext:<extension>` and `ext:<extension>/<tool>` select extension tools.
- An extension matches if any of its canonical names matches, case-insensitively. A skill matches by the name pi's skill loader assigns, which is the frontmatter `name` or else the directory name, case-insensitively.
- A deny entry beats an allow entry. `ext:<extension>` in a deny list denies all of that extension's tools. `*` is valid only in an allow list.
- `*` in `tools.allow` allows all built-in and all extension tools, and a `tools` allow list with no `ext:` entry and no `*` permits no extension tools. The delegation tools are `agent`, `get_subagent_result`, `steer_subagent`, and `stop_subagent`. `allowed_subagents` and ADR 0013 govern them, not `policy.tools`.
- Wildcards, `extensions: true`, and whole-extension selectors expand first and are then narrowed, without refusal. A caller-supplied `ext:<extension>` refuses the spawn when `policy.extensions` denies that extension, and a tool-level deny only narrows. A path-form `extensions` entry matches by its canonical name. A caller-supplied path refuses the spawn whenever `policy.extensions` has an allow list.

Ephemeral nesting:

- `policy.ephemeralNesting` defaults to `true`. When it is `false`, an ephemeral agent's `allowed_subagents` is `[]`, and a caller value other than `[]` refuses the spawn. Named agents keep their own value.

Provenance decides refuse or filter:

- Caller-supplied means a field explicitly present in `agent` or nested `agent` parameters, or in the raw `agentConfig` of an RPC or registry spawn before `normalizeInlineAgentConfig` fills defaults. A caller-supplied value outside the policy refuses the spawn with an error that starts `Capability policy:` and names the value and the list.
- The check filters every other value, for example an agent file's. The user gets a notification. The `agent` tools add a note to the tool result. The `subagents:rpc:spawn` reply is `{ id, filtered? }`. The `AgentRecord` stores the filtered list for the viewer and for `getRecord(id)`. The registry `spawn` still returns the id.
- If filtering empties an explicit tool list, the check refuses the spawn.

Enforcement:

- One pure `checkCapabilityPolicy`, modeled on `checkModelScope`, runs at every resolution site: the `agent` tool, the nested tool, mentions, `subagents:rpc:spawn`, and the `spawn` of the `Symbol.for("pi-subagents:manager")` registry entry.
- `spawnTopLevel` serves RPC, the registry entry, and direct mentions, so for those callers the check runs inside the funnel after it strips a supplied verdict. The RPC handler passes the raw `agentConfig` alongside the normalized one. The registry path never normalizes.
- Its verdict carries the effective tools, extensions, and skills. `runAgent` builds the session from the verdict and never re-reads the agent file for those fields.
- Only `checkCapabilityPolicy` mints a verdict. `spawnTopLevel` strips one a caller supplies, and `spawnAgent` throws when it is absent.
- The check examines declared values at spawn. The existing extension scope guard filters extension tools that register later, and it never refuses. `DefaultResourceLoader`'s `skillsOverride` narrows `skills: true`, and the check filters named skills before `preloadSkills`.
- Resuming a live record reuses its session, so the check does not run again. Reopening a tombstone starts a new session, and the check runs.
- A denied extension still runs its factory once at load, and a denied skill's `SKILL.md` stays readable through `read` or `bash`. The policy removes tools and bound hooks, not file access.

Done check: `npx vitest run test/capability-policy.test.ts` passes. It asserts refusal of a caller-supplied denied tool through an ephemeral `agent` call, the nested tool, RPC, and the registry `spawn`. It asserts filtering for an agent file's value through a job when fired, a direct mention, and a tombstone reopen. It covers extension and skill denial, `ephemeralNesting: false`, `skills: true` narrowing, and `spawnAgent` throwing without a verdict.

## Consequences

- With no policy a fresh install behaves as it does today.
- An inline definition that names a denied value fails that extension's spawn. An extension can read the effective policy first, per ADR 0022.
- A filtered file default leaves an agent with fewer tools than its author wrote, and the filter notice is the only signal.
- Rejected: enforcing only in `spawnAgent`, which cannot tell caller values from file values. Rejected: refusing file values, which would make one restrictive policy break every shipped skill agent.
- Revisit if policy needs per-agent rules, or if extension denial must stop load-time code.
