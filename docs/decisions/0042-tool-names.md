# 0042. Tool names

Replaces: 0016-agent-tool-name, last present in 61e4195

## Context

The extension registers a delegation tool and three lifecycle tools. A model and a reader must see that the four belong to one family.

pi tool names are lowercase. A capital letter in `Agent` matched Claude Code, and ADR 0002 rules that out as a reason.

## Decision

Every registered tool name is lowercase, top-level and nested. The delegation tool is `agent`. Each lifecycle tool is `agent_` followed by a lowercase snake_case action, and the current three are `agent_get_result`, `agent_steer`, and `agent_stop`.

- The names come from `SUBAGENT_TOOL_NAMES` in `src/session/extension-scope.ts` and `NESTED_TOOL_NAMES` in `src/tool/nested-tools.ts`.
- Tool names match exactly. There is no alias.
- Model-facing and user-facing text, `AGENTS.md`, README, `docs/rpc.md`, and ADR text use these names. A `label` is a display string and is not covered.

Done check: `npx vitest run test/tool/tool-names.test.ts` passes. It asserts that `SUBAGENT_TOOL_NAMES` and the exported `NESTED_TOOL_NAMES` match `/^[a-z][a-z0-9_]*$/`. It also asserts the `agent` name and the three lifecycle names, and that the top-level and nested registrations use them.

## Consequences

- Anything outside this repo that names an earlier tool must change: skills, agent files, prompts, and other extensions' guidelines. A stale name fails as an unknown tool, with no warning.
- Recorded session history keeps its past calls under the earlier names.
- Revisit if pi gains tool namespacing or aliases, since the prefix would then be redundant.
