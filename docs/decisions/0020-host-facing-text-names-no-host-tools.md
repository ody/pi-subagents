# 0020. Text this extension injects never prescribes host tools

## Context

pi renders a tool's `promptGuidelines` in the system prompt's `<rules>` section, after the `<tools>` snippet list. The model decides which tool to call there, so this text outranks most other instructions.

This extension owns delegation. Which tool reads a file in the host session is the host's choice. A tool name in delegation text overrides a host policy, such as one that routes code search through an LSP-backed MCP server.

An append-mode sub-agent keeps the host's system prompt so that it follows the host's conventions (ADR 0023). Text the extension adds to that prompt overrides the same host policy.

## Decision

Text this extension injects into a model's context never tells the model which non-subagent tool to use. That text is:

- `description`, `promptSnippet`, `promptGuidelines`, and parameter `description` strings of every tool this extension registers, top-level and nested.
- Text generated for `toolDescriptionMode` `"custom"`: `{{typeList}}`, `{{compactTypeList}}`, and `{{isolationGuideline}}`.
- Every `content[].text` that the `agent`, nested `agent`, `get_subagent_result`, `steer_subagent`, and `stop_subagent` tools return.
- `<task-notification>` messages and the mention reminder.
- The append-mode `<sub_agent_context>` bridge and the fallback identity in `src/session/prompts.ts`.

Rules:

- For work the model does not delegate, say "handle it yourself", never a tool name.
- Text may name this extension's tools (`agent`, `get_subagent_result`, `steer_subagent`, `stop_subagent`) and registered agent types.
- The type list may name the tools a sub-agent type has, in its `(Tools: …)` suffix. That describes the sub-agent, not the host.
- A capability note (`filteredNote`, `nestedFilteredNote`) may name the capabilities it removed from a sub-agent. That also describes the sub-agent.

Out of scope:

- Replace-mode agent system prompts. The agent definition owns that session's tool policy.
- Text the user or a sub-agent wrote, which the extension relays verbatim. That covers agent names, frontmatter `description`, and the user's prose in `agent-tool-description.md`. It also covers sub-agent output inside results and notifications.

Done check: `npx vitest run test/host-facing-text.test.ts` passes. It asserts that no built-in tool name appears outside a `(Tools: …)` suffix or a capability note's removed names in:

- the strings of the registered tools in `full`, `compact`, and `custom` mode, and of the nested tools. The fixture registers at least one agent with a narrowed `tools:` list.
- the output of `formatTaskNotification`, `getStatusNote`, `getForegroundOutcomeNote`, `filteredNote`, `nestedFilteredNote`, `modelReplacedNote`, and `agentMentionReminder`
- the output of `buildAgentPrompt` in append mode, both with a parent system prompt and without one, less the parent system prompt

## Consequences

- A tool name in injected text overrides host tool policy from the highest-attention position in the prompt.
- An append-mode sub-agent gets no tool advice from this extension, so it relies on the host prompt alone.
- Rejected: tool names phrased as suggestions. The position in the prompt gives a suggestion the weight of a rule.
- Revisit if pi gains a per-tool policy channel that resolves host tool choice outside prompt text.
