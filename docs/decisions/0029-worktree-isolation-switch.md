# 0029. A switch turns worktree isolation off for every path

## Context

`isolation: "worktree"` copies the repo for an agent. On a large repo the copy costs time and disk. ADR 0023 notes that `isolation` is conditional on `worktreeIsolation`.

With the switch off, `isolationParam` drops the parameter from the `agent` and nested tool schemas. The tool description loses the guideline. `agent-start.ts` skips `createWorktree` and runs the agent normally.

## Decision

`worktreeIsolation` (default `true`) controls whether any path may create a worktree.

- Off: no path creates a worktree. That covers the tool parameter, an agent file's `isolation`, and `subagents:rpc:spawn`.
- Off: the extension downgrades a requested worktree to a normal run instead of refusing it, and the result carries no note.
- Off: the extension removes the `isolation` parameter and the guideline in the tool description, so a model has nothing to read about it.
- With `toolDescriptionMode: "custom"`, the guideline appears only through `{{isolationGuideline}}`, which is empty when the switch is off.
- The downgrade applies at once. The schema and prose change on the next pi session.
- On: a worktree request creates a worktree.
- An agent file's `isolation: off` overrides a caller's worktree request, and the agent runs without a worktree (ADR 0014).

Done check: `npx vitest run test/worktree.test.ts test/isolation-param.test.ts test/invocation-config.test.ts test/worktree-isolation-e2e.test.ts` passes. It covers the downgrade on each path and the missing schema field.

## Consequences

- A downgraded run edits the real working tree, which a caller who asked for isolation did not expect. The missing schema field is the only prevention.
- Revisit if downgrades need a result note once models stop seeing the parameter.
