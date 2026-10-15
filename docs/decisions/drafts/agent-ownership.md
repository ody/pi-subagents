> DRAFT: not accepted, not current truth.

# NNNN. Agent ownership and control scoping

## Context

Every agent run ends up as one `AgentRecord` in `AgentManager`, but the records are not peers. A run started by the session's own `Agent` tool, an `@handle` mention, or another extension's RPC belongs to the session; a run started by another agent (nested) or by a workflow belongs to that owner, which is blocked awaiting it. `isTopLevelAgent` in `src/agent-manager.ts` draws the line: `parentAgentId === undefined && workflowId === undefined`.

Without that line, three failures follow:

- Double reporting: an owned child and its owner would both emit completion events and notifications for the same work.
- Cross-owner control: one extension or sibling agent could steer, stop, or consume a record another caller is waiting on.
- Pool deadlock: a queued child counted against the same concurrency pool as its waiting parent can leave the parent holding a slot for a child that never starts.

## Decision

Ownership is a property of the record, set at spawn and never changed: `parentAgentId` for a nested child, `workflowId` for a workflow's agent. `isTopLevelAgent` is the single test every scoping decision reads.

- Only top-level records get a handle and alias (`src/agent-manager.ts` spawn path). `@handle` resolution (`resolveMention`) skips any record with a `parentAgentId`, so nothing can address an owned child by name.
- The model-facing top-level tools (`Agent` resume, `get_subagent_result`, `steer_subagent`, `stop_subagent` in `src/index.ts`) reject any record that fails `isTopLevelAgent` as "not found".
- `subagents:rpc:*` handlers do the same: `subagents:rpc:stop` refuses an owned record, and no RPC hands out ids for one.
- Lifecycle events (`subagents:started`, `subagents:completed`, `subagents:failed`, `subagents:compacted`, `subagents:steered`), the persisted `subagents:record` entry, and completion notifications fire only for top-level records. An owned child reports through its owner.
- Concurrency pools charge only top-level records: `occupiesPoolSlot` (background) and `occupiesForegroundSlot` (blocking). Nested children take no slot, so a parent awaiting its own child cannot deadlock the pool.
- A nested agent's own tools come from `createNestedSubagentTools` in `src/nested-tools.ts`, injected only when the agent's frontmatter sets `allowed_subagents`, a `nestedRuntime` exists, the run is not isolated, and depth is below `maxSubagentDepth` (default 2, main session = 0). Every nested tool checks `record.parentAgentId === context.parentAgentId` before acting, so a nested agent reaches only its own children. `stop_subagent` and its nested mirror act only on agents the caller owns; anything else is reported as not found.
- Settling a parent aborts its owned children (`abortOwnedChildren`), transitively — a child that outlives its owner would burn tokens with no surface able to reach it.
- UI surfaces are the exception: they show every record, not only top-level ones. Ownership scopes control, never visibility.

Done check: `npx vitest run test/nested-tools.test.ts test/cross-extension-rpc.test.ts test/stop-subagent-wiring.test.ts` passes.

## Consequences

- Filtering a UI surface through `isTopLevelAgent` again makes owned agents unreachable by the user; that belongs to the UI decision, not this one.
- Loosening control scoping to match the UI would let siblings and other extensions steer, stop, or consume agents they do not own.
- Charging owned children to the concurrency pools reintroduces the parent-awaiting-child deadlock.
- Revisit if a second owner kind appears that is neither an agent nor a workflow, since `isTopLevelAgent` currently names exactly two ownership fields.
