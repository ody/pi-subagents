# 0022. The capability policy lives in subagents.json, a project can only narrow it, and the menu edits ephemeral nesting

Replaces: 0012-capability-policy-configuration, last present in 503bd9e

## Context

Settings load from the global `~/.pi/agent/subagents.json` and the project `.pi/subagents.json`. A project file comes from the repo, so an untrusted repo could widen a policy if the two merged per field.

The loader reads a file that fails to parse as `{}`, which would drop a project's restrictions. `checkModelScope` re-reads `enabledModels` on every call. The settings events fire at init and when the menu saves.

The settings menu edits either layer (see ADR 0021). The model can write the config files directly, so keeping `policy` out of the menu protects nothing.

## Decision

`subagents.json` carries an optional `policy` with `allow` and `deny` string lists for each of `tools`, `extensions`, and `skills`. The matching rules are ADR 0011's. `policy` also carries `ephemeralNesting`, a boolean that defaults to `true`.

- Global and project policy apply separately. A spawn value passes only if both allow it, and deny entries from either file apply.
- A project can only narrow, so `ephemeralNesting: false` in either file turns ephemeral nesting off. `policy` is the exception to per-field project-over-global precedence.
- An omitted list allows everything, and no `policy` allows everything.
- Every spawn reads the policy, so an edit applies without a restart.
- A wrong type or shape, `*` in a deny list, or a `subagents.json` that fails to parse makes the policy malformed. A malformed policy denies every spawn until the user fixes it, and a warning names the file and entry. A well-formed entry that names nothing known only warns.
- `policy` is not a `SubagentsSettings` field. The menu edits one of its keys, `ephemeralNesting`, as a row named "Ephemeral nesting" in each layer. It writes that key in the layer the user is editing and leaves every other part of `policy` as it was.
- On the project layer the row can only narrow. The menu refuses to turn it on while the global file has it off, with a message that says so. The row shows the effective value.
- Users edit the `allow` and `deny` lists by hand in the file.
- The `subagents:settings_loaded` and `subagents:settings_changed` payloads and the `subagents:rpc:ping` reply carry the policy under a `policy` key. Its shape is `{ global, project, ephemeralNesting }`. `global` and `project` hold each file's lists, and `ephemeralNesting` is the merged value.
- `settings_changed` fires when the menu changes `ephemeralNesting`. A hand edit fires neither event, so the ping reply is the only copy that is always current. `PROTOCOL_VERSION` stays `2`.

Done check: `npx vitest run test/capability-policy-config.test.ts test/settings-menu.test.ts` passes. It covers:

- the narrowing merge
- a malformed policy and an unparseable file denying spawns
- the menu writing only `ephemeralNesting`
- the refused widening on the project layer
- the policy in both events and the ping reply

## Consequences

- A project cannot grant what the global policy omits. The user edits the global file, or switches the menu to the global layer.
- A broken policy fails closed, so one typo stops all spawns until the user fixes it.
- A later extension misses `settings_loaded`, so it reads the policy from the ping reply.
- Revisit if projects need to widen the global policy for trusted repos, or if the menu needs to edit the lists.
