> DRAFT: not accepted, not current truth.

# NNNN. The model overrides an agent's model only when the user names one

## Context

An agent's frontmatter `model` is the user's choice. A caller `model` displaces it (ADR 0014).

A model that sees the configured model, or reads how a caller `model`, the frontmatter `model`, and the session model rank, can compare models and pass `model` unasked. The override then replaces the user's choice silently.

## Decision

This narrows when the model uses the `model` override of ADR 0014. ADR 0014 still governs what the override does.

Tool descriptions, parameter descriptions, snippets, guidelines, and the generated type lists (`{{typeList}}`, `{{compactTypeList}}`) follow these rules, top-level and nested:

- Never show an agent's configured `model`.
- Never explain how a caller `model`, the frontmatter `model`, and the session model rank.
- Every `model` parameter description says to set `model` only when the user named a model, and to omit it otherwise.

Tool-result and notification text names a model only to report this run's outcome:

- The model-scope replacement note (`modelReplacedNote`) names the out-of-scope configured model that this run replaced.
- A refusal of an out-of-scope caller `model` may list the allowed models (ADR 0024).
- No other result or notification text shows the configured `model`.

Done check: `npx vitest run test/agent-tool-description.test.ts test/tool-description-mode.test.ts` passes. The tests assert, in `full`, `compact`, and `custom` mode and for the nested tools:

- the type lists for an agent with a frontmatter `model` contain no label of that model
- each `model` parameter description contains "only when the user named a model"
- `formatTaskNotification` output for a record with a configured model contains no label of that model

Rejected: showing the configured model with a "do not override" instruction. The visible value still invites comparison.

## Consequences

- A visible configured model invites unasked `model` overrides, which replace the user's choice.
- The model cannot read an agent's model from the type list. A user who wants a specific model must name it.
- Revisit if users ask the model to choose agents by model, which needs the configured model visible.
