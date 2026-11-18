# 0007. Agent ownership scopes control, not visibility

## Context

Every agent run is one `AgentRecord` in `AgentManager`, but the records are not peers. A run started by the session's own `agent` tool, an `@handle` mention, or another extension's RPC belongs to the session. A run started by another agent (nested) belongs to that agent, whether the owner awaits it inline or leaves it running in the background. `isTopLevelAgent` in `src/manager/agent-manager-rules.ts` draws the line: `parentAgentId === undefined`.

Without that line, three failures follow:

- Double reporting: an owned child and its owner would both emit completion events and notifications for the same work.
- Cross-owner control: one extension or sibling agent could steer, stop, or consume a record another caller is waiting on.
- Pool deadlock: a child can count against the same concurrency pool as its waiting parent. The parent then holds a slot for a child that never starts.

Applying the ownership test to UI visibility makes nested agents unreachable: the user cannot watch, steer, or stop them. Ownership must bound programmatic control without filtering what the user sees.

## Decision

Ownership is a property of the record, set at spawn and never changed: `parentAgentId` names the owner of a nested child. Ownership scopes control, never visibility.

### Control

- `isTopLevelAgent` is the one boundary test for model-facing tools, `@handle` resolution, `agent:rpc:*`, lifecycle events, completion notifications, and the concurrency pools. Every such site calls it; none compares `parentAgentId` directly.
- Only top-level records get a handle and alias, and `@handle` resolution skips owned records.
- Model-facing top-level tools report an owned record as not found.
- `agent:rpc:stop` refuses an owned record with the error `Agent is owned by another agent`. No RPC hands out ids for owned records.
- Callers cannot claim ownership. `agent:rpc:spawn` refuses a caller-supplied `parentAgentId` ([ADR 0045](0045-rpc-spawn-option-allowlist.md)), and the tool and mention paths never pass one.
- Lifecycle events, the persisted `agent:record` entry, and completion notifications fire only for top-level records. An owned child reports through its owner.
- Concurrency pools charge only top-level records, so a parent awaiting its own child cannot deadlock the pool.
- Settling a parent aborts its owned children, transitively. A child that outlives its owner keeps spending after the only model-facing caller that could consume its result has settled.

### Nesting

- Each owning run gets its own nested delegation tools. Every operation on an existing record (resume, result, steer, stop) requires `record.parentAgentId === context.parentAgentId`, so a nested agent reaches only its own children. The tools report any other record as not found.
- `README.md` documents the configuration that enables nesting (`allowed_subagents`, `maxSubagentDepth`).

### UI

- UI surfaces show every agent. `/agents -> Agents` and the above-editor widget render nested agents indented under their owner. An agent whose owner is gone appears as a root row.
- The widget lists only running descendants, to stay inside its line budget.
- `AgentManager.getActivity(id)` is the only store of live activity state. UI code reads it and never builds its own, so every spawn route reports activity.

Done check: `npm run check` passes.

## Consequences

- Filtering a UI surface through `isTopLevelAgent` makes owned agents unreachable by the user.
- Loosening control scoping to match the UI would let siblings and other extensions steer, stop, or consume agents they do not own.
- Charging owned children to the concurrency pools reintroduces the parent-awaiting-child deadlock.
- This ADR is the canonical owner of the RPC-stop rule. ADR 0003 does not restate it.
- Revisit if a second owner kind appears, since `isTopLevelAgent` names exactly one ownership field.
- Revisit if nesting depth or width grows enough that the full tree crowds the widget's line budget.
