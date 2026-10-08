> DRAFT: not accepted, not current truth.

# NNNN. No workflow orchestration in pi-subagents

## Context

Scripted workflow orchestration (`SubagentWorkflow`) is a second product inside this extension. It owns `src/workflow/` (12 files), `src/ui/workflow-card.ts`, `src/ui/workflow-dialog.ts`, `src/ui/workflow-menu.ts`, `docs/workflows.md`, `examples/workflows/`, and 17 `test/workflow-*.test.ts` files plus `test/e2e/workflow.e2e.test.ts`. It also reaches into the core:

- `workflowId` ownership on `AgentRecord` in `src/agent-manager.ts`, `src/types.ts`, `src/cross-extension-rpc.ts`, and the fleet tree in `src/ui/fleet-list.ts` and `src/ui/agent-tree.ts`.
- `structuredOutput` in `src/agent-runner.ts` and `src/structured-output.ts`, and the `onBeforeWorktreeCleanup` hook in `src/agent-manager.ts`. The workflow host is their only caller.
- The `workflowsEnabled` setting, the `--subagents-workflow-file` flag, the workflow session entry renderer, and the `/agents -> Workflows` menu in `src/index.ts`.

Orchestration is a separate concern from spawning and managing sub-agents and belongs in its own extension.

Other extensions depend on the `subagents:rpc:*` channels and lifecycle events. `pi-advisor` (`codeberg.org/ody/pi-advisor`, `src/backend.ts`) uses `ping`, `spawn` with an inline `agentConfig`, `consume`, and `subagents:completed` and `subagents:failed`. None of these depend on workflow code.

## Decision

pi-subagents provides sub-agents only: the `Agent` tool, `/agents`, scheduling, and the `subagents:rpc:*` channels and lifecycle events. It does not provide workflow orchestration.

- Never add workflow orchestration to this repo. A workflow extension, ported or new, is a separate package that drives sub-agents through `subagents:rpc:*`.
- Code whose only caller was the workflow host is removed, not kept as a hook for a future workflow extension.
- Removing workflow code must not change the behavior of any `subagents:rpc:*` channel or lifecycle event for top-level agents. `PROTOCOL_VERSION` stays `2`.
- `docs/rpc.md` stays as the RPC integration guide, without workflow references.
- RPC tests (`test/cross-extension-rpc.test.ts`, `test/rpc-*.test.ts`) keep covering every channel without depending on workflow code. A test that only covered workflow ownership is deleted.
- `subagents:rpc:stop` refuses a nested child with `Agent is owned by another agent`, and `isTopLevelAgent` is `parentAgentId === undefined`.

Removal is complete when both hold:

- `git grep -n -i workflow -- ':!docs/decisions' ':!AGENTS.md'` prints nothing, and the only match in `AGENTS.md` is this ADR's rules-index entry.
- `npm run check` passes.

Rejected: keep the code behind `workflowsEnabled: false`. It still costs maintenance, tests, and core coupling.

## Consequences

- Users lose `SubagentWorkflow`, including its Claude Code `Workflow` compatibility, until a separate extension ships it. The old code is recoverable from git at the commit before removal.
- A future workflow extension that needs run-level ownership or structured output must get it through RPC. Adding that to this repo needs its own ADR.
- Revisit if orchestration cannot be built outside this extension without duplicating its agent manager.
