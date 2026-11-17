# 0037. The Agents widget is a bounded summary of running work

## Context

The Agents widget sits above the editor for the whole time agents run. Every row it draws pushes the transcript up, so it must stay small while many agents run.

ADR 0007 makes every agent visible and lets the widget list only running descendants. ADR 0014 limits the widget's override disclosure to model and thinking. ADR 0036 sets how each status looks.

## Decision

The widget is `AgentWidget` in `src/ui/agent-widget.ts`, registered as `"agents"` with `placement: "aboveEditor"`. No other widget lists agents.

### What it lists

1. The widget draws only while it has a row to show. With no row, it removes itself and its status bar text.
2. `widgetMode` selects the top-level agents it lists: `all`, `background` for background agents only, or `off` for none.
3. Each running top-level agent shows, followed by its running descendants, depth first, each depth indented one step.
4. A running agent whose owner is gone shows as a root row (ADR 0007). A running agent whose top-level ancestor `widgetMode` hides does not show.
5. Queued top-level agents collapse into one row that gives their count.
6. A finished top-level agent stays until the next turn start, or two turn starts when its status is in the failure class.
7. Nested agents never show once they leave `running`, except the row that selection or an open viewer holds (ADR 0038).
8. The status bar text counts the running and queued top-level agents that `widgetMode` selects.

### Rows and budget

1. A running agent takes two lines: a stats line and its current activity. The stats line shows model and thinking only with `showModel` on, and cost only with `showCost` on.
2. An agent type's `color` frontmatter, a `#RRGGBB` value, colors its name.
3. The widget draws at most 12 lines, heading included, each cut to the terminal width.
4. On overflow, the row that selection holds draws first. Then running agents keep their rows, then the queued row, then finished agents. A last line counts the hidden rows.

Done check: `npx vitest run test/ui/agent-widget.test.ts test/ui/widget-layout.test.ts test/ui/agent-color.test.ts` passes, with a test for each rule above.

## Consequences

- A queued agent, a finished nested agent, or an agent past its linger time shows only in `/agents`.
- With more running agents than the budget holds, the overflow line is the only trace of the hidden ones.
- Revisit if nesting depth or width grows enough that running descendants crowd out top-level agents.
