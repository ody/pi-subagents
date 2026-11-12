> DRAFT: not accepted, not current truth.

# NNNN. A nested agent never exceeds its parent's capabilities

## Context

README documents that a child runs with its own `tools:`, `extensions:`, and `isolated:`, that the parent's restrictions are not inherited, and that delegation grants the parent the union of what its listed agents can do. This decision reverses that.

A nested child's `allowed_subagents` comes from its own file, and nothing compares it with its parent's. `AgentRecord` stores no tools, extensions, or skills, and `NestedToolContext` carries only the parent's `allowedSubagents`.

This builds on the capability policy and ephemeral agents ADRs, and the three are accepted together. It uses the capability policy's expansion rules.

## Decision

A nested spawn is bounded by its parent. In this rule the spawner is the owner as ADR 0007 defines it. Top-level, `@handle`, RPC, and scheduler spawns have no parent and are bounded by the capability policy alone.

- The parent's set is its tools, extensions, and skills after the capability policy and its own ceiling, so the bound is transitive. It is recorded on the parent's `AgentRecord` when its session is built.
- A child's values are compared with the parent's using the capability policy's expansion rules: wildcards, `true`, and whole-extension selectors expand first and are narrowed, never refused. The parent's `disallowed_tools` and `exclude_extensions` apply to the child, and `skills: true` under a parent list narrows to that list.
- A caller-supplied child value outside the parent's set refuses the spawn. File values and ephemeral defaults are narrowed to the intersection, with a warning to the user and a note in the nested tool result.
- A child's `allowed_subagents` cannot exceed its parent's. A list is a subset of a list, and `all` is allowed only when the parent has `all`. A caller value outside the parent's refuses the spawn, and a file value or ephemeral default is narrowed. The main session counts as `all`.
- A nested ephemeral child, one spawned with no `subagent_type`, is allowed only when the parent's `allowed_subagents` is `all`.
- A nested spawn whose parent record has no recorded set is refused.
- Extension tools that register after spawn are filtered by the same set, through the extension scope guard.

Done check: `npx vitest run test/delegation-ceiling.test.ts` passes. It covers each rule above through the nested `agent` tool.

## Consequences

- A restricted agent cannot hand a child tools its own file denied it, and a read-only orchestrator cannot obtain writes through its children.
- Every nested agent depends on its parent's recorded set.
- Revisit if a parent needs to grant a child something it does not hold, which this decision forbids.
