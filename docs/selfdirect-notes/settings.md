# Notes: settings cluster (#77, #80, #93, #94, #95, #96, #97)

## Decisions

- **Menu reads files, not runtime state.** Rows show values from the layer files and the defaults table. A value that failed to persist (session only) does not show until the next write.
- **Failed write applies session-only.** `saveAndEmitChanged` applies the single changed value live and emits `persisted: false`. This keeps the old "session only" toast meaningful.
- **Viewer `m` key writes the project layer.** `chooseViewerMarkdown` persists one `viewerMarkdown` key to the project file. The old code did the same through the snapshot.
- **`settings_loaded` keeps its old shape.** It still carries only the keys the files set. `settings_changed` carries every key, defaults filled (#96).
- **`defaultMaxTurns` default is `0`.** The table stores `0` (unlimited). `runner-defaults` normalizes it to `undefined`.
- **Join mode row id is `defaultJoinMode`.** Row ids now equal settings keys, so the old `joinMode` id is gone.
- **Menu rejects bad numbers with a warning toast** that names the range. The prompt label shows the range from the table.
- **`ephemeralNesting` is a `SettingKey`, not a `SubagentsSettings` key.** It writes through `setLayerPolicyKey`. A reset removes a `policy` object that it emptied.
- **Override notice for `ephemeralNesting`.** A global change shows the "does not reach this project" notice only when the project file sets it to `false` and the global value is not `false`.
- **`r` on a row whose file value is invalid** (sanitize would drop it) still removes the key. The check reads the raw file, not the sanitized value.
- **Working directory.** The menu and the persistence use `process.cwd()`, as the loader already does.
- **README `widgetMode` default** reads `all` everywhere, matching `src/index.ts`.
- **Removed** `snapshotSettings`, `saveSettings`, and `readProjectPolicyRaw`. Nothing else used them.

## Unresolved

- Enum and toggle row `values` in `src/ui/settings-rows.ts` still repeat the allowed values from the defaults table. The table owns defaults and bounds, and a test checks both against `sanitize`, but no test ties the row lists to the table.
- File-backed tests for max concurrency replaced the numeric prompt tests that read runtime getters (default max turns, grace turns, nested depth).
- The menu has no per-key test for a project file that holds a full snapshot across a tab switch.
