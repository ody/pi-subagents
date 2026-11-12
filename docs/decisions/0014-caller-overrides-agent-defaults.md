# 0014. The caller tunes a named agent's run, and the user is told

## Context

Frontmatter outranks `agent` tool parameters for `thinking`, `max_turns`, and `run_in_background`. Only `model` lets the caller win, in `resolveAgentInvocationConfig` (`src/tool/invocation-config.ts`). README calls frontmatter authoritative for everything else.

A user who sets defaults on a reusable named agent still wants one run on a different model or reasoning level, for example two reviewers on two models. A change to what an agent is, its tools or prompt, belongs to an ephemeral agent instead.

## Decision

On the `agent` tool and the nested `agent` tool, four fields of a named agent can be overridden by the caller: `model`, `thinking`, `max_turns`, and `run_in_background`. Precedence is caller parameter, then frontmatter, then the fallback below.

- Fallbacks: `model` is the session model, `thinking` is pi's default level, `max_turns` is `defaultMaxTurns`, and `run_in_background` is `backgroundByDefault` on the top-level tool and foreground on the nested tool.
- Both `agent` schemas accept `max_turns` of 0 or more. A caller `0` means unlimited and reaches the runner as an explicit value, so it is not re-resolved from the file.
- Every other frontmatter field is the file's. `inherit_context`, `isolated`, and `isolation` keep today's behavior: a parameter fills a field the file leaves unspecified, and a file's `isolation: off` still refuses a worktree.
- A caller `model` is checked by `scopeModels` as today.
- On resume, the session keeps its model and thinking. `run_in_background` and `max_turns` come from the resuming call, else the record's original values.

The user is told about every override:

- The tool-result header and the viewer show each field where the caller displaced a frontmatter value that resolves differently: `opus 4.6 (over pinned anthropic/claude-haiku-4-5)` for `model`, `high (over low)` for `thinking`, `5 turns (over 20)` for `max_turns`, and `background (over foreground)` for `run_in_background`. The thinking clamp note is independent, so a clamped override reads `high (asked xhigh, over low)`.
- The widget shows model and thinking only, and nested spawns disclose in the widget and viewer.
- A caller `model` that does not resolve refuses the spawn and never falls back to the file's pin.

Mentions:

- A direct-mode `@handle` run sends its message unchanged and carries no overrides.
- A model-mode `@handle` run goes through the mention clone, a model call that reads the user's words. `@handle with model deepseek flash and reasoning high, review the ADR` sets `model` and `thinking` for that run. The clone's `agent` tool refuses `max_turns`, `run_in_background`, and `resume`. `inherit_context`, `isolated`, and `isolation` fill as on the main tool. Its forced `run_in_background: true` is not disclosed as an override.
- A clone call that is refused is reported to the user with the refusal message and does not fall back to a direct start.
- A message that does not start with the mention goes to the main model, which may use all four overrides.
- `subagents:rpc:spawn` option semantics are unchanged.

Done check: `npx vitest run test/invocation-config.test.ts test/agent-model-display.test.ts test/nested-tools.test.ts test/mention-clone.test.ts` passes. It covers each of the four fields, the disclosure text, the nested path, the clone subset and refusal report, and the zero `max_turns` case.

## Consequences

- A file's `model`, `thinking`, `max_turns`, and `run_in_background` are defaults, not locks. Every other field in the file binds a named agent, so a read-only reviewer stays read-only.
- A file that must run on one model has no way to say so.
- Disclosure text grows with each overridable field, so a fifth field needs its own wording.
