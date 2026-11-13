> DRAFT: not accepted, not current truth.

# NNNN. Settings come from a global and a project layer, and the menu edits either

## Context

`SubagentsSettings` has 20 keys. The extension reads them from the global `~/.pi/agent/subagents.json` and the project `<cwd>/.pi/subagents.json`. A project key wins over a global key, and an unset key falls back to a hardcoded default.

The menu edits only the project file, and `saveSettings` writes the merged value of every key there on the first change. That pins every inherited global value in the project, so later edits to the global file stop applying. Users can edit the global file only by hand, and the menu cannot show where a value comes from or return a key to inheriting.

The menu also accepts numbers that `sanitize` rejects at load, so a saved value can vanish on the next start.

pi's `/model` selector is the model for the layout. Its header reads `Scope: all | scoped`, with the broad list on the left. `tab` switches between the two lists at any time. It opens on the scoped list when the user has scoped models, and on the full list when not.

## Decision

The effective value of a key is the project value, else the global value, else the default. The one exception is `policy`, which has its own merge rule.

The menu shows one layer at a time:

- The header reads `Scope: global | project`, with the global layer on the left as `all` is on `/model`. The footer advertises `tab scope`. `tab` switches layers at any time.
- The menu opens on the project layer when `<cwd>/.pi/subagents.json` exists, and on the global layer when it does not.
- The global layer shows the global file's values, with the default for an unset key. A change writes the global file. When the project overrides that key, the notification says the change does not reach this project.
- The project layer shows the effective value of every row. The menu marks a row the project file sets as a project value, and as overriding global when the global file also sets it. It dims a row the project does not set and marks it inherited. A change writes the project file and makes that key an override.
- `r` on a row removes that key from the layer's file. The project row then inherits, and the global row returns to the default. `r` on a row the layer does not set does nothing. The footer advertises it.

Writes:

- A change writes one key. It leaves every other key in the file as it was, including unknown keys and the rest of `policy`.
- The menu never writes a layer file that exists and fails to parse. That layer shows the parse error and stays read-only until the user fixes the file.
- The menu does not rewrite a project file that already holds a full snapshot. Every key in it is an override, and `r` removes them one at a time.
- After a write or a reset, the extension recomputes the effective settings from both files and the defaults, and applies them live. A reset restores the inherited value in the running session.
- The defaults and numeric bounds form one table. Load, the menu, and the appliers share it, and the README's settings table is the same table.
- `sanitize` drops a value outside its bounds at load without affecting other keys. The menu rejects it with a notification that names the range.

Other rules:

- `subagents:settings_changed` carries the effective settings and a `layer` field, `"global"` or `"project"`, for the layer that changed. `docs/rpc.md` documents it.
- A malformed file or key never fails a spawn, except a malformed `policy`, which the capability policy ADR covers.
- The extension ignores a removed key and reads no old value shape.
- `ephemeralNesting` is a row in both layers, with the rules the capability policy ADR gives it.

Done check: `npx vitest run test/settings.test.ts test/settings-menu.test.ts test/runtime-settings.test.ts` passes. It covers:

- the opening layer
- a project change leaving inherited keys out of the project file
- a later global edit still applying
- a global change under a project override
- a reset restoring the inherited value live
- bounds rejection
- unknown keys and `policy` surviving a write

## Consequences

- The extension now writes the global file, which the README currently says it never does. A global edit reaches every project without an override.
- A project that already holds a snapshot stays pinned until the user resets its keys by hand.
- The `allow` and `deny` policy lists remain hand-edited, because list editing does not fit a toggle row.
- Revisit if the project needs a third layer, such as a per-agent one.
