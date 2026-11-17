# 0041. A completion notification speaks to the model and shows a preview to the user

## Context

A background agent finishes while the main session does other work. Two readers need to know: the model, which must act on the result, and the user, who reads the transcript.

The two readers need different text. The model needs ids, the output path, a result preview, and usage in a form it can parse. The user needs a short block that shows the outcome at a glance.

ADR 0035 says a notification never consumes a result and the notifier skips a consumed result. ADR 0020 limits which tool names model-facing text may carry. ADR 0028 keeps usage out of pi's totals except on tool results.

## Decision

A completion notification is one pi custom message of type `subagent-notification`, built in `src/manager/completion-notifier.ts`.

### Delivery

1. The notifier sends the message with `deliverAs: "followUp"` and `triggerTurn: true`, so every notification starts a model turn.
2. Agents that the join mode (`defaultJoinMode`) groups together and that finish within one group-join window share one message. A group that times out sends what finished, and the rest follow in later messages. Every other agent gets its own message.

### Two audiences

1. The message `content` is for the model. It is a `<task-notification>` block per agent, built in `src/manager/notification-format.ts`, with the ids, output file, status, a result preview, and usage.
2. The message `details` is for the user. The renderer in `src/ui/notification-renderer.ts` draws it, and its output never reaches the model.
3. Neither part carries the full result. When a preview cuts the result, it says so, and the model text names `agent_get_result` as the way to read the rest.

### User rendering

1. A header line shows the status icon from ADR 0036, the description, and the status word.
2. A stats line shows turns, tool uses, tokens, and duration. Cost shows only with `showCost` on.
3. An `error` run shows its error text.
4. Folded, the block shows the first preview line. pi's `app.tools.expand` key, `Ctrl+O` by default, unfolds it to at most 30 preview lines.
5. The block names the transcript path when the agent has an output file.
6. A group message with `showCost` on adds a line with the group's total tokens and cost.

Done check: `npx vitest run test/manager/completion-notifier.test.ts test/manager/notification-format.test.ts test/ui/notification-block.test.ts test/ui/notification-renderer.test.ts` passes, with a test for each rule above.

## Consequences

- A user who wants the full result opens the conversation viewer or the output file. The notification block never holds it.
- Every notification costs a model turn. A group join is the only way to merge several into one turn.
- Revisit if pi adds a message kind that informs the model without starting a turn.
