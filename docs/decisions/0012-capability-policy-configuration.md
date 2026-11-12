# 0012. The capability policy lives in subagents.json and a project can only narrow it

## Context

Settings load from the global `~/.pi/agent/subagents.json` and the project `.pi/subagents.json`. README says the project overrides the global on any field present in both, and `loadSettings` merges with a shallow spread. A project file is repo-controlled, so an untrusted repo could widen a policy.

`saveSettings` overwrites the whole project file with `snapshotSettings`, and a compile-time check forces every `SubagentsSettings` key into that snapshot. A file that fails to parse is read as `{}`, which would drop a project's restrictions.

`checkModelScope` re-reads `enabledModels` on every call. The settings events fire at init and when `/agents` saves.

## Decision

`subagents.json` carries an optional `policy` with `allow` and `deny` string lists for each of `tools`, `extensions`, and `skills`. The matching rules are ADR 0011's. `policy` also carries `ephemeralNesting`, a boolean that defaults to `true`.

- Global and project policy are evaluated separately. A value is allowed only if each allows it, and deny entries from either apply. A project can only narrow, so `ephemeralNesting: false` in either file turns ephemeral nesting off. `policy` is the exception to per-field project-over-global precedence.
- An omitted list allows everything, and no `policy` allows everything.
- The policy is read at each spawn, so an edit applies without a restart.
- A wrong type or shape, `*` in a deny list, or a `subagents.json` that fails to parse is a malformed policy. It denies every spawn until it is fixed, and a warning names the file and entry. A well-formed entry that names nothing known only warns.
- `policy` is not a `SubagentsSettings` field. Saving settings reads the project file and writes its `policy` back unchanged, and `/agents` never edits it. Saving refuses, with a warning, when the project file exists and fails to parse.
- The `subagents:settings_loaded` and `subagents:settings_changed` payloads and the `subagents:rpc:ping` reply carry the policy under a `policy` key shaped `{ global, project, ephemeralNesting }`, where `global` and `project` hold each file's lists and `ephemeralNesting` is the merged value. The ping reply is the only copy that is always current, since `/agents` never writes `policy` and the events do not fire on a hand edit. `PROTOCOL_VERSION` stays `2`.

Done check: `npx vitest run test/capability-policy-config.test.ts` passes. It covers the narrowing merge, a malformed policy and an unparseable file denying spawns, a settings save leaving `policy` untouched, and the policy in both events and the ping reply.

## Consequences

- A project cannot grant what the global policy omits. The user edits the global file.
- A broken policy fails closed, so one typo stops all spawns until it is fixed.
- A later extension misses `settings_loaded`, so it reads the policy from the ping reply.
- Revisit if projects need to widen the global policy for trusted repos.
