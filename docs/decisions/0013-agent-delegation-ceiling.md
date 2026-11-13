# 0013. A nested agent never exceeds its parent's capabilities

## Context

A nested child's own file could grant tools, extensions, skills, or `allowed_subagents` that its parent lacked. A restricted orchestrator could then escalate through its children. When pi builds the parent's session, the manager records its effective capabilities on the parent's `AgentRecord`, and the nested tool reads them from there.

This builds on ADR 0011 (capability policy) and ADR 0023 (ephemeral agents). It uses ADR 0011's expansion rules.

## Decision

The parent bounds a nested spawn. In this rule the spawner is the owner as ADR 0007 defines it. Top-level, `@handle`, and RPC spawns have no parent, so the capability policy alone bounds them.

- The parent's set is its tools, extensions, and skills after the capability policy and its own ceiling, so the bound is transitive. The manager records it on the parent's `AgentRecord` when it builds the parent's session.
- The runner compares a child's values with the parent's using the capability policy's expansion rules. Wildcards, `true`, and whole-extension selectors expand first, and the runner narrows them and never refuses them. The parent's `disallowed_tools` and `exclude_extensions` apply to the child. `skills: true` under a parent list narrows to that list.
- A caller-supplied child value outside the parent's set refuses the spawn. The runner narrows file values and ephemeral defaults to the intersection, with a warning to the user and a note in the nested tool result.
- A child's `allowed_subagents` cannot exceed its parent's. A list must be a subset of a list, and `all` needs a parent with `all`. A caller value outside the parent's refuses the spawn, and the runner narrows a file value or ephemeral default. The main session counts as `all`.
- A nested ephemeral child, one spawned with no `subagent_type`, needs a parent whose `allowed_subagents` is `all`.
- The nested tool refuses a spawn whose parent record has no recorded set.
- The extension scope guard filters extension tools that register after spawn through the same set.
- `maxSubagentDepth` (default `2`, 0 to 16) is the hard ceiling on nesting, counted from the main session as 0 and its subagents as 1. An agent whose depth has reached it gets no nested delegation tools, whatever its `allowed_subagents`, and `0` or `1` turns nesting off. An `isolated` agent also gets none.
- The runner reads the ceiling when it builds a top-level agent's session, and descendants inherit that value. A change applies to agent trees that start after it.

Done check: `npx vitest run test/delegation-ceiling.test.ts` passes. It covers each rule above through the nested `agent` tool, including the depth ceiling.

## Consequences

- A restricted agent cannot hand a child tools its own file denied it, and a read-only orchestrator cannot obtain writes through its children.
- Every nested agent depends on its parent's recorded set.
- Revisit if a parent needs to grant a child something it does not hold, which this decision forbids.
