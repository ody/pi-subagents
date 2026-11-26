# 0054. `/agents` lists the session's finished top-level agents and opens them read-only

## Context

`/agents → Agents` lists manager records. The sweep removes a settled record about 10 minutes after the run ends, and the record's `AgentSession` goes with it (ADR 0035). The conversation viewer needs a session to open (ADR 0039).

A persisted top-level agent leaves two durable traces (ADR 0027, ADR 0049):

- its session file
- an `agent:record` entry on the branch that was active at the settle

The manager rebuilds one tombstone per such entry, up to 100, on `session_start` and `session_tree`. A nested agent never persists a session (ADR 0027), so it leaves no trace past its record.

A session file holds the whole conversation as pi message entries. pi renders those entries with the same message components as a live session (ADR 0039).

## Decision

`/agents → Agents` shows the persisted top-level agents of the active branch, live and finished. A finished agent with a session file opens in the conversation viewer without a live session.

### Menu

1. `/agents → Agents` lists live records as the tree of ADR 0007. Below the tree it lists one row per tombstone (ADR 0049), under a `History` heading, newest `completedAt` first. A tombstone with a live record never lists, per ADR 0049.
2. The menu header counts live rows and history rows separately.
3. A history row shows the status icon from `src/ui/agent-format.ts` (ADR 0036), the handle or alias, the type, the description, and the age of `completedAt`. The description and age use the same cell formats as a live row.
4. Selecting a history row opens the viewer through the shared function of ADR 0039, so the overlay options and handlers stay the same.

### Read-only viewer

1. The viewer for a tombstone reads `sessionFile` once on open with `SessionManager.open`. It renders `buildSessionContext().messages` with the message components of ADR 0039, and skips a message kind that pi does not render. It subscribes to nothing.
2. The top border keeps the main-session line of ADR 0039.
3. The header line comes only from tombstone fields: `type`, `description`, `status`, `stopCause` when set, and `agentConfig` when present. It shows no model line and no `policy removed` line.
4. Steer and stop never apply. The agent has no running or queued state (ADR 0040), so `Enter` and `x` do nothing and the footer omits them.
5. Scroll, expand, and close keys work as ADR 0040 sets them. Follow starts on, as ADR 0040 sets.
6. A `sessionFile` that is missing or unreadable opens no viewer. The notice names the path, as the reopen notice of ADR 0049 does. ADR 0039's no-session notice, which names the agent's status, applies to live records only.
7. Opening a history row never starts a run, never removes the tombstone, and never marks a result consumed (ADR 0035).

### Done check

`npx vitest run test/ui/agents-menu.test.ts test/ui/conversation-viewer.test.ts test/ui/conversation-viewer-opener.test.ts` passes, with a test for each rule above. The tests cover:

- a swept record that stays openable
- a nested agent that never shows
- a missing session file, with its own notice
- no steer and no stop on a history row
- a header that holds only tombstone fields

## Consequences

- An agent with `rememberAgents` off or `persist_session: false` leaves no history row, since it writes no handle or session file.
- A finished nested agent leaves the menu at the sweep. This is an exception to ADR 0007's rule that UI surfaces show every agent. It holds while nested agents never persist.
- The history holds at most 100 rows, the tombstone cap. Older rows leave the menu while their session files stay on disk.
- A session switch replaces the history with that branch's agents, as ADR 0049 rebuilds tombstones.
- The viewer has two message sources, a live session and a stored file. Both go through the pi components, so a change to what pi exports (ADR 0039) affects both.
- Revisit if pi exposes a read-only session viewer, or if the 100-row cap hides agents a user wants.

Rejected: keeping settled records longer for the menu. Each record holds a live `AgentSession`, and ADR 0035 bounds that cost.
