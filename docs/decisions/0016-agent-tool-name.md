# 0016. The delegation tool is named agent

## Context

The extension registers its delegation tool as `Agent`, top-level and nested (`SUBAGENT_TOOL_NAMES.AGENT` in `src/session/extension-scope.ts` and `NESTED_TOOL_NAMES` in `src/tool/nested-tools.ts`). Every other pi tool and the extension's other tools, `get_subagent_result`, `steer_subagent`, and `stop_subagent`, are lowercase.

The capital matches Claude Code's tool name, and ADR 0002 makes that compatibility no reason to keep it.

## Decision

The tool registers as `agent`, top-level and nested. Every registered tool name is lowercase.

- Tool names match exactly, so `Agent` in a file's `disallowed_tools` no longer matches anything. There is no alias.
- Model-facing and user-facing text, `AGENTS.md`, README, `docs/rpc.md`, and ADR text name the tool `agent`. A `label` is a display string and is not covered.

Done check: `npx vitest run test/tool-names.test.ts` passes. It asserts that `SUBAGENT_TOOL_NAMES` and `NESTED_TOOL_NAMES`, which is exported, match `/^[a-z][a-z0-9_]*$/` and that the top-level and nested registrations use them.

## Consequences

- Anything outside this repo that names `Agent` must change: skills, agent files, prompts, and other extensions' guidelines. A stale name fails as an unknown tool, with no warning.
- Accepted ADRs 0003 and 0007 name the tool in incidental text and change in the same commit as the rename.
- Recorded session history keeps its past `Agent` calls.
