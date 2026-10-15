> DRAFT: not accepted, not current truth.

# NNNN. Agent UI shows the whole hierarchy; ownership scopes only control

## Context

`isTopLevelAgent` in `src/agent-manager.ts` decides whether a record is one of the session's own agents or one another agent owns (`parentAgentId` set). It scopes the model-facing tools, `@handle` resolution, `subagents:rpc:*`, lifecycle events, completion notifications, and the concurrency pools. Siblings and other extensions use that scoping to stay out of each other's agents.

Every UI surface used to filter through it too, so an agent spawned by another agent had no UI: nothing could watch, steer, or stop it. Activity state (current tool, turn count) was built in `src/index.ts` only on the `Agent` tool path, so a row from any other spawn route showed no activity.

## Decision

UI surfaces show every agent; ownership scoping applies to control channels, not to what the person running the session sees.

- FleetView, `/agents -> Agents`, and the above-editor widget render nested agents indented under their owner, at any depth.
- Rows come from `buildAgentTree` in `src/ui/agent-tree.ts`, a pure projection over all manager records. It derives topology from the full record set, keeps an ancestor whenever a descendant is shown, and promotes an agent whose owner is gone, or that sits in a cycle, to a root row marked as an orphan.
- Selection in tree views is keyed by row (`agent:<id>`), not by index.
- The widget shows only running descendants under each top-level row.
- `isTopLevelAgent` keeps scoping tools, `@handle`, RPC, lifecycle events, notifications, and pools. Showing an agent in the UI never makes it reachable through those.
- `AgentManager.getActivity(id)` is the only store of live activity state. UI code reads it and never builds its own, so every spawn route reports activity.

Done check: `npx vitest run test/agent-tree.test.ts test/fleet-list.test.ts test/agent-widget.test.ts` passes.

## Consequences

- Filtering a UI surface through `isTopLevelAgent` again makes nested agents unreachable by the user.
- Loosening control scoping to match the UI would let siblings and other extensions steer, stop, or consume agents they do not own.
- Revisit if nesting depth or width grows enough that the full tree crowds the widget's line budget.
