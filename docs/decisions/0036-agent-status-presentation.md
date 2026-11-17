# 0036. Every surface shows an agent's status the same way

## Context

The Agents widget, the conversation viewer, and completion notifications each show an agent's status. A user reads them at a glance, often from the corner of the eye. If one status looks different on two surfaces, the user misreads it.

`AgentRecord.status` in `src/types.ts` takes seven values. Some of them are neither a success nor a failure: a user who stops an agent asked for that outcome.

## Decision

One status-to-presentation mapping in `src/ui/agent-format.ts` serves every surface that shows an agent's status. No surface builds its own.

| Status | Class | Icon | Color |
| --- | --- | --- | --- |
| `running` | active | spinner frame, or `●` where a surface does not animate | `accent` |
| `queued` | active | `◦` | `muted` |
| `completed` | success | `✓` | `success` |
| `steered` | success | `✓`, with the note `turn limit` | `warning` |
| `aborted` | failure | `✗` | `error` |
| `error` | failure | `✗` | `error` |
| `stopped` | neutral | `■` | `dim` |

1. A rule that treats outcomes differently, such as how long the widget keeps a finished row, uses the class, not a list of statuses.
2. The status table in `README.md` carries every row of this mapping.

Done check: `npx vitest run test/ui/agent-widget.test.ts test/ui/conversation-viewer.test.ts test/ui/notification-block.test.ts` passes, with a test per status on each surface. `grep -rn 'ERROR_STATUSES' src` prints nothing.

## Consequences

- A new status needs one row in the mapping and one row in the `README.md` table, and every surface shows it with no further change.
- A surface that needs a different look for one status must change the mapping for every surface.
- Revisit if pi publishes its own status vocabulary for tool runs.
