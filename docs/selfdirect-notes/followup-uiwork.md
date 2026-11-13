# Notes: cluster uiwork

- Item bg description: re-registration via `pi.registerTool` works (loader replaces by name and calls `refreshTools`), so no ADR 0029-style fallback. ADR 0026 gained one line.
- Item bg description: the rebuilt tool also refreshes the `subagent_type` and worktree prose. The mention clone keeps the first registered tool object, whose `execute` is equivalent.
- Item bg description: the applier skips re-registration until the first registration, so startup load does not register twice.
- Viewer key: the `m` toast fires only when a command context exists. The fleet path passes the last session context.
- Viewer key: the session value resets on restart, and a later settings write from the menu overwrites it.
- Tests: `test/live-settings-wiring.test.ts` mocks `agents-menu` and `settings-menu` to capture wiring deps.
