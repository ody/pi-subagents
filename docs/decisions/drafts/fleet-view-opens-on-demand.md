> DRAFT: not accepted, not current truth.

# NNNN. Fleet view opens on demand above the editor

## Context

The Agents widget already shows every running agent. A fleet list that draws while nobody uses it repeats that content and costs terminal rows.

pi's own selectors, such as `/model` and `/settings`, appear only when called and sit at the input. A user who knows those menus expects the fleet view to act the same way.

Two pi facts constrain the layout:

- `setWidget` keeps above-editor widgets in insertion order, and setting a key again moves it to the end. The Agents widget (`"agents"`, `aboveEditor`) can register again while the fleet is open.
- pi exposes no editor row to extensions, so a `ui.custom` overlay cannot pin itself above the input box.

## Decision

The fleet view is a modal list. It draws only while open.

1. Closed is the default. While closed, `FleetList` never registers the `"fleet"` widget and draws no line.
2. `↓` at an empty prompt opens it, only when the editor has focus, `fleetView` is on, and an openable agent exists. No other key opens it. `←` is not an activator.
3. Open, it registers `"fleet"` with `placement: "aboveEditor"`, and it must render directly above the editor, below the Agents widget. If another above-editor widget registers while the fleet is open, the fleet registers again so it stays last.
4. Its rows are `main` first, then the agent tree. Opening selects `main`.
5. `↑`/`↓` move the selection and wrap: `↑` on `main` selects the last row, `↓` on the last row selects `main`. Moving the selection never closes the view.
6. `Enter` on an agent opens its conversation viewer. Closing the viewer returns to the open fleet view with that agent selected.
7. `Enter` on `main` closes the view. `Esc` with no viewer open selects `main` and closes the view. `Esc` in a viewer closes only the viewer.
8. Any key that is not a fleet key closes the view and passes through to the editor.
9. While the fleet can open but has not, the Agents widget heading carries `↓ to manage`. No other surface shows a fleet hint.

Done check: `npx vitest run test/fleet-list.test.ts test/fleet-wiring.test.ts test/agent-widget.test.ts` passes with tests for each numbered rule.

Rejected:

- Overlay via `ui.custom({ overlay: true })`: it cannot anchor to the editor and covers the Agents widget or the input.
- Replace the editor, as `/settings` does: the input box disappears.
- Close on `↑` past `main`: an aimless scroll would dismiss the view, so only `Enter` on `main` and `Esc` close it.

## Consequences

A user who does not know `↓` sees no fleet. The Agents widget hint is the only cue, and widget modes that hide that widget hide it too. An always-drawn list would cost rows for the whole time agents run. Revisit if pi exposes editor-anchored overlays or a native selector slot above the input.
