# 0038. The user opens an agent by selecting its row in the Agents widget

Replaces: 0030-fleet-view-opens-on-demand, last present in 177dca5

## Context

A user who sees an agent in the Agents widget wants to open that agent from the same rows. A second list of the same agents repeats the widget and costs more rows.

pi widgets take no focus. An extension reads keys through `ui.onTerminalInput` while the editor has focus. pi exposes no editor row, so an overlay cannot sit above the input box.

pi's own selectors, such as `/model` and `/settings`, appear only when called. A user who knows them expects selection to start on a key and end without a trace.

## Decision

Selection is a mode of `AgentWidget` in `src/ui/agent-widget.ts`. No separate fleet list exists, and agent-lifecycle code updates only `AgentWidget`.

1. `↓` at an empty prompt starts selection when the editor has focus and the widget shows an agent row. Selection starts on the first agent row.
2. Only agent rows take the cursor. The queued row and the overflow line never do.
3. `↑` and `↓` move the cursor. `↑` on the first agent row ends selection. `↓` on the last row keeps the cursor there.
4. `Enter` opens the selected agent's conversation viewer (ADR 0039). While the viewer is open, the widget keeps that agent's row. Closing the viewer returns to selection on that row.
5. `Esc` ends selection. Any other key ends selection and passes through to the editor.
6. The cursor follows the agent, not the row index. If the selected row goes away, the cursor moves to the agent row that now holds its index, else to the last agent row. Selection ends when the widget shows no agent row.
7. The selected row always draws. The line budget hides other rows first.
8. The heading shows `↓ to manage` while selection can start, and the selection keys while selection runs.
9. With `widgetMode` `off`, selection never starts. The `fleetView` setting does not exist, `sanitize()` drops a stored `fleetView` key, and `/agents -> Settings` has no fleet view row.

Done check: `npx vitest run test/ui/agent-widget.test.ts` passes, with a test for each numbered rule. `grep -rni 'fleet' src test README.md` prints nothing.

Rejected:

- An overlay via `ui.custom({ overlay: true })`: it cannot anchor to the editor and covers the widget or the input.
- Replace the editor, as `/settings` does: the input box disappears.
- A `main` row that `↑` wraps to: with no separate list, `↑` from the first row undoes the `↓` that started selection, so leaving on `↑` cannot surprise the user.

## Consequences

- With `widgetMode` `off`, `/agents` is the only way to open an agent.
- An agent the widget does not show opens only from `/agents`.
- `↓` at an empty prompt never reaches the editor while the widget shows an agent row.
- Revisit if pi exposes widget focus or an editor-anchored overlay.
