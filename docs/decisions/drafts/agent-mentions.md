> DRAFT: not accepted, not current truth.

# NNNN. A mention addresses an agent from the prompt, in one of three modes

## Context

`@handle message` typed at the prompt can message a live agent, resume a finished one, or start one that is not running. `agentMentions` (`model`, `direct`, `off`; default `model`) decides who starts an agent that is not running.

Starting through the model needs a context-written prompt and a real `agent` call. A call from the main session would put the call and its result in the user's chat. `runMentionClone` (`src/triggers/mention-clone.ts`) avoids that. It runs an in-memory clone of the conversation with a wrapped `agent` tool and discards the clone after the call.

ADR 0014 and ADR 0015 set what the clone's tool may override and refuse. ADR 0007 limits handles to top-level agents. An ephemeral agent (ADR 0015) is a top-level agent with a handle but no registry entry. Mentions must treat it like any other handle.

## Decision

`agentMentions` selects how the extension handles a mention. The three modes differ only in who starts an agent that is not running.

- `model`: the clone starts it. The clone sees the conversation and may call only the `agent` tool.
- `direct`: the extension starts it through the spawn funnel with the user's text, in the background, with no model call.
- `off`: the extension intercepts nothing. It disables messaging, resuming, starting, and the `@` suggestion list, and every `@…` prompt reaches the main model unchanged.
- Messaging a live agent and resuming a finished one are direct in `model` and `direct`, but only in the TUI. Outside the TUI, `direct` passes every mention to the main model, and `model` passes messages to and resumes of existing agents to the main model. Only a start runs through the clone.
- The wrapped tool refuses a second start for one mention.
- A handle resolves to a live record first, then to a tombstone, then to a registered type.
- An ephemeral agent works like any other top-level agent. A mention can message a live one and reopen a remembered one. It has a handle, and its tombstone carries its built config (the ephemeral agents ADR).
- A reopen of an ephemeral agent skips type resolution and runs the stored config. The capability policy filters it as it filters an agent file's values.
- A mention cannot start an ephemeral agent. A handle that matches no live record, no tombstone, and no registered type is not a mention, and the prompt reaches the main model.
- The `@` suggestion list shows live and remembered ephemeral agents beside registered ones in its live and resumable groups. It never lists an ephemeral type as startable.
- A clone that fails with an error falls back to a direct start, and the extension warns the user with the error.
- Input from another extension (`event.source === "extension"`) never counts as a mention.
- A mention start passes through the capability policy like any other spawn (ADR 0011).
- The mode applies live.

Done check: `npx vitest run test/mention-clone.test.ts test/agent-mention-wiring.test.ts test/ephemeral-agent.test.ts test/settings.test.ts` passes. It covers messaging a live ephemeral agent, reopening a remembered one, and an unmatched handle reaching the main model.

## Consequences

- `model` mode costs a model call per start, and the clone's prompt carries the whole conversation.
- A live or remembered ephemeral agent shadows a registered type with the same handle until the manager evicts it and its tombstone ages out.
- Revisit if pi exposes a way to run a hidden turn without cloning the session.
