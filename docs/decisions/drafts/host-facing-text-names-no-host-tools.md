> DRAFT: not accepted, not current truth.

# NNNN. Text injected into the host session never prescribes host tools

## Context

pi renders a tool's `promptGuidelines` inside the system prompt's `Guidelines:` block, next to the tool schemas. That is where the model decides which tool to call. The `Agent` tool's second guideline used to end "Otherwise use direct tools (read, grep, find) when the target is already known". Naming three built-ins there overrode whatever tool policy the host session had set; a session that routes code search through an LSP-backed MCP server was told to grep.

This extension is about delegation. Which tool reads a file in the host session is the host's call.

The full `Agent` tool description in `src/index.ts` (`fullAgentToolDescription`, section `## When not to use`) still says "use a direct tool — `read` for a known path, `grep`/`find` for a specific symbol or string", inherited from the Claude Code prompt alignment in `0800a8a`. It overrides host policy the same way.

## Decision

Text this extension registers into the parent session never tells the model which non-subagent tools to use. That text is:

- `promptGuidelines` and `promptSnippet` of every tool registered in `src/index.ts`.
- Tool and parameter `description` strings of those tools.

Rules:

- Guidance may say when to delegate and when not to. For the not-delegated case, say "handle it yourself", never a tool name.
- Naming this extension's own tools (`Agent`, `get_subagent_result`, `steer_subagent`, `stop_subagent`) and agent types (`Explore`) is allowed.
- Listing the tools a sub-agent type has, as the agent type list does, is allowed. It describes the sub-agent, not the host.
- Replace-mode agent system prompts, such as the defaults in `src/default-agents.ts`, are out of scope. Those agents run in their own session with a tool set the agent definition chooses, so the definition owns their tool policy.

## Consequences

- Reintroducing tool names in guidelines overrides host tool policy again, in the highest-attention position in the prompt.
- No test pins the guideline text, so this rule is enforced in review. Revisit if a guideline regresses; a test asserting the registered guideline strings would then be worth adding.
