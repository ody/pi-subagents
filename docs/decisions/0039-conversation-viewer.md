# 0039. The conversation viewer renders an agent the way pi renders the main session

## Context

The conversation viewer is the only surface that shows a sub-agent's full transcript. A completion notification and the Agents widget show only a preview or the current activity.

pi renders its main session with message components that `@earendil-works/pi-coding-agent` exports, such as `UserMessageComponent`, `AssistantMessageComponent`, `ToolExecutionComponent`, and `BashExecutionComponent`. A user already knows how that transcript looks and folds. A second renderer in the extension drifts from pi and repeats its work.

While the viewer is open, the user needs only to see that the main session still runs. pi's overlay API cannot see what pi draws behind the overlay.

ADR 0007 makes every agent visible, nested ones included. ADR 0014 sets the forms that disclose caller overrides.

## Decision

The viewer is one `ConversationViewer` overlay in `src/ui/conversation-viewer.ts`.

### Opening and closing

1. `/agents -> Agents` and a selected Agents widget row (ADR 0038) open the viewer through one shared function, with the same overlay options, handlers, and notices.
2. The overlay sits at the centre with a width of 95% and a maximum height of 90% of the terminal.
3. The viewer's top border carries one main-session line. It shows a working indicator while the main session runs, and the first line of its last assistant message, cut to fit. The extension builds the line from pi's session events.
4. An agent with no session does not open the viewer. Both entry points show the same notice, which names the agent's status.
5. The viewer opens for every agent, nested agents included (ADR 0007).
6. Disposing the extension's UI context closes any open viewer. The agent finishing never closes it.

### Rendering

1. Each message renders with the component pi uses for that message kind in the main session. The viewer skips a message kind that pi does not render.
2. The viewer has no other rendering mode, no `m` key, and no setting that selects a mode. The `viewerMarkdown` setting does not exist, and `sanitize()` drops a stored `viewerMarkdown` key. `/agents -> Settings` has no markdown row.
3. While open, the viewer redraws on every session event of the agent.
4. pi's `app.tools.expand` key, `Ctrl+O` by default, expands and folds the messages in the viewer as it does in the main session.
5. A line under the header shows the model and invocation tags in the forms ADR 0014 sets, and the capabilities the policy removed as `policy removed <names>`.

Done check: `npx vitest run test/ui/conversation-viewer.test.ts test/ui/agents-menu.test.ts test/ui/agent-widget.test.ts` passes, with a test for each rule above. `grep -rni 'viewermarkdown\|markdown mode' src README.md` prints nothing.

## Consequences

- The viewer looks like pi only as long as pi exports its message components. If pi stops exporting one, the viewer needs a replacement before it can upgrade.
- A second entry point that builds its own viewer drifts from the shared function, as wording and handlers diverge.
- Revisit if pi exposes a way to show a second session in its own chat view, or an editor-anchored overlay.
