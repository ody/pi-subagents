# Notes: ephemeral cluster (#83, #84, #91, #92)

## Decisions

- **#84 inline default.** `normalizeInlineAgentConfig` sets `persistSession: given.persistSession === true`. A non-boolean value counts as `false`. The runner precedence is unchanged.
- **#91 record fields.** `AgentRecord.agentConfig` is added next to `displayName` and `promptMode`. The two older fields stay, because the badge and prompt-mode label code reads them. They could derive from `agentConfig` in a later cleanup.
- **#91 tombstone rule.** The existing `tombstone()` guard (handle and session file present) already gives "none when `rememberAgents` is off or the agent has a parent". Tests pin that.
- **#92 funnel.** `spawnResolved` treats the config as stored values, not caller values, when `options.ephemeral` is set. It passes `ephemeral: true` to the policy and no `raw`. `spawnTopLevel` still deletes `options.ephemeral`, so an RPC caller cannot set it.
- **#92 live resume.** `dispatchLiveMention` reads `record.agentConfig` before `getAgentConfig(type)`. The `@` list reads the record or tombstone `displayName`. The type list comes from the registry, so it never offers an ephemeral type.

## Unresolved

- None. Model-scope checking in the funnel belongs to #82/#89 and was left alone.
