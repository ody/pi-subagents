# UI and mentions

The extension adds one above-editor widget, one conversation viewer, one `/agents` menu, and `@handle` mentions at the prompt. Every surface shows every agent, nested ones included. Ownership scoping bounds programmatic control only.

## Agents widget

The widget draws the running agents above the editor, with at most 12 lines.

```text
● Agents
├─ ⠹ Agent  Refactor auth module · ↻5≤30 · 5 tool uses · 33.8k token (62%) · 12.3s
│    ⎿  editing 2 files…
├─ ⠹ reviewer  Find auth files · ↻3 · 3 tool uses · 12.4k token (8%) · 4.1s
│    ⎿  searching…
├─ ⠹ Agent  Long-running task · ↻42 · 38 tool uses · 91.0k token (84% · ⇊2) · 2m17s
│    ⎿  reading…
└─ 2 queued
```

The widget is the only widget that lists agents. [`widgetMode`](settings.md#widget) selects which agents it shows:

- `all`: every agent.
- `background`: hides foreground agents, which already render inline as the `agent` tool result.
- `off`: hides the widget.

A running nested agent whose owner record is gone shows as a root row in `all` and `background`. A running nested agent under a top-level agent that `widgetMode` hides does not show. A nested agent that leaves `running` drops off the widget, except the row that [selection](#selecting-an-agent) or an open viewer holds.

The token field carries two optional signals inside parens:

- **`NN%`**: context-window utilization, color-coded: under 70% dim, 70-85% warning, 85% and above error. Omitted when the model has no declared `contextWindow`, or briefly right after compaction.
- **`⇊N`**: the number of times the session has compacted, when above zero. Stays dim; the percent's color carries urgency.

## Selecting an agent

Selection is a mode of the Agents widget. While the widget shows an agent row, its heading shows `↓ to manage`. Press `↓` at an empty prompt to start selecting. `▸` marks the selected row:

```text
● Agents ↑↓ select · enter open · esc done
▸  ⠹ Agent  Refactor auth module · ↻5≤30 · 5 tool uses · 33.8k token (62%) · 12.3s
│    ⎿  editing 2 files…
├─ ⠹ reviewer  Find auth files · ↻3 · 3 tool uses · 12.4k token (8%) · 4.1s
│    ⎿  searching…
└─ 2 queued
```

The keys:

- `↓` at an empty prompt starts selection on the first agent row. The editor must have focus. With `widgetMode` `off`, selection never starts.
- Only agent rows take the cursor. The queued row and the overflow line do not.
- `↑`/`↓` move the cursor. `↑` on the first agent row ends selection. `↓` on the last row keeps the cursor there.
- `Enter` opens the selected agent's [conversation viewer](#conversation-viewer). While the viewer is open, the widget keeps that agent's row. Closing the viewer returns to selection on that row.
- `Esc` ends selection. Any other key ends selection and passes through to the editor.
- The cursor follows the agent, not the row index. If the selected row goes away, the cursor moves to the agent row that now holds its index, else to the last agent row. Selection ends when the widget shows no agent row.
- The selected row always draws. When the 12-line budget overflows, the widget hides other rows first. A nested agent that leaves `running` while selected keeps its row until the cursor moves off it.

With `widgetMode` `off`, or for an agent the widget does not show, `/agents → Agents` is the way to open an agent. `↓` at an empty prompt never reaches the editor while the widget shows an agent row.

## Conversation viewer

The viewer is a live-scrolling overlay of an agent's full conversation. It is 95% wide and up to 90% tall, and it closes when pi shuts the extension down. `/agents` and the Agents widget open it the same way. A live agent with no session shows a notice that names its status.

- The viewer renders with pi's own message components: each message uses the same component the main session uses for its kind. It has no other rendering mode.
- The viewer follows the agent by default. After any scroll key, follow is on exactly when the view shows the latest line. `Home` goes to the start, and `End` goes to the latest line and turns follow on. While follow is off, the footer says `follow off · End to follow`.
- `Ctrl+O` (pi's `app.tools.expand` key) expands and folds the messages, as in the main session.
- The footer names the scroll and expand keys as your pi keybindings bind them (`tui.select.up`, `tui.select.down`, `tui.select.pageUp`, `tui.select.pageDown`, `app.tools.expand`). It names `Esc`, `Enter`, `x`, `Home` and `End` as they are.
- The top border shows one main-session line. It starts with `● main working` while the main session runs, and `○ main idle` otherwise. The first line of its last assistant message follows, cut to fit.

Steer a running agent inline. Press `Enter` to open pi's input box, type, then press `Enter` to send. `Esc` closes only the input box, and an empty submit sends nothing. A sent steer shows as a dim `Steering: <text>` line below the transcript until the agent takes it from its queue. It then appears as a user message and redirects the agent after its current tool.

Stop a still-running agent by pressing `x`, then `x` again to confirm. `Esc` never stops an agent. Steer and stop work only while the agent is running or queued.

A stopped agent reports its partial output and flags it as incomplete, not as a completion. An agent wedged inside a tool call that never returns still frees its concurrency slot, and it fires its completion notification within a few seconds.

### A finished agent's conversation

A finished agent that left a session file opens in the same overlay, read-only. The viewer reads the file once when it opens and renders the stored messages with the same pi message components. It subscribes to nothing.

- The top border keeps the main-session line.
- The header comes only from the agent's stored entry. It shows the type, the description, the status, the `stopCause` when set, and the stored agent config of an ephemeral agent when present. It has no model line and no `policy removed` line.
- Steer and stop never apply, because the agent has no running or queued state. `Enter` and `x` do nothing, and the footer omits them. Scroll, expand, close and follow work as they do for a live agent.
- A session file that is missing or unreadable opens no viewer. The notice names the path.
- Opening a stored conversation never starts a run, never removes the agent's entry, and never marks its result consumed.

## Agent mentions

Subagents are addressable. Every agent has a typeable handle: the agent type, lowercased, numbered when instances collide (`reviewer`, `reviewer-2`). `@handle <message>` at the prompt talks to that agent, whatever state it happens to be in. Type `@` to pick one:

```text
❯ @
  @auth-audit     send message · reviewer · running · audit the auth flow
  @reviewer-2     send message · running · find flaky tests
  @code-review    resume · code-review · check the diff
  @auditor        start agent · Reviews code for security vulnerabilities.
  index.ts        src/index.ts                        ← pi's own file rows, still there
  index.d.ts      dist/index.d.ts
```

The handle names the **agent**, not one process, so a single syntax covers its whole lifecycle:

| State | `@reviewer fix the flaky test` does |
| --- | --- |
| running or queued | sends the message into its conversation. A queued agent gets it when its session starts |
| finished | **resumes** it in the background from its existing session, continuing where it left off |
| finished long ago, record gone | **reopens** its session from disk and continues there |
| never started | **starts** it, through the path that [`agentMentions`](settings.md#agent-mentions) selects |

No turn is ever spent in the main conversation, and nothing about the mention enters the chat. The answer comes back as the ordinary background-completion notification, so the main model can relay it.

The grammar is deliberately narrow, so nothing gets swallowed by accident:

| Input | Goes to |
| --- | --- |
| `@reviewer fix the flaky test` | the `reviewer` agent |
| `@main @reviewer is not a mention` | the main model, with the leading `@main` and its trailing space stripped: the escape hatch |
| `@reviewer` (no message) | the main model: a bare handle is never a send |
| `hey @reviewer look at this` | the main model: only a **leading** mention goes to an agent |
| `@src/index.ts summarize this` | the main model, with pi's normal file attachment |
| `@nosuchagent hello` | the main model, verbatim: no agent, no type, no interception |

While an agent is live its handle addresses *it*, so `@reviewer` never starts a second reviewer alongside a running one. Use the `agent` tool for deliberate parallelism. `@<agent-id>` works too.

Three rules decide what a handle can name:

- `main` is a reserved name and can never be an agent's handle. A type slugging to it gets `main-2`.
- Handles have a 64-character limit.
- [Nested subagents](agents.md#nested-subagents) are not addressable. They are absent from every programmatic top-level surface, and only their owner may steer them *by tool*. A handle that would name one starts a fresh top-level agent instead of reaching through that boundary. They are still visible and steerable by hand in the widget and `/agents → Agents`.

Suggestions list live agents first, then resumable ones, then startable types, and then pi's own file rows in the same popup. `@` stays the file picker it always was, and the extension adds the handles to it rather than replacing it. [The `agentMentions` setting](settings.md#agent-mentions) turns the whole thing off.

### Named agents

The `agent` tool takes an optional `name`, so the orchestrator can call one `auth-audit` instead of leaving you to tell `@reviewer-2` from `@reviewer-3`. A name is *additive*: the type-derived handle is still assigned, so `@reviewer` keeps reaching that agent rather than starting a second one beside it.

Both names share one namespace, so an alias can never shadow a live handle or the reverse. The popup shows one row per agent, under its alias, with the type moved into the description. `agent_steer`, `agent_get_result` and `agent_stop` accept a handle too, so you and the model address agents the same way.

### Starting a new agent

In `model` mode the clone receives your message with a `<system-reminder>` appended. The reminder says the user wants to invoke agent X, and asks the model to invoke the agent and pass in the required context. The clone's model then makes the tool call. There is no tool forcing and no allowed-tools narrowing. The mention constrains *which* agent, not what it is told. So the model writes the agent's prompt, with the conversation context a cold spawn lacks.

The cost is a visible turn: the model's reasoning and its tool block, narrating a decision you already made by typing the handle. The extension keeps the mechanism and moves it off-screen. It copies the conversation into a throwaway in-memory session. That clone takes the turn holding only the `agent` tool. What it starts is an ordinary top-level agent:

```text
@cyan whats your favorite color        →  (nothing in the chat)
  └─ clone of this conversation, off-screen
       └─ agent(subagent_type: "cyan", prompt: …)
            ▸ Cyan Agent   favorite color        ← widget, handle
```

The clone is literal: the session's own entries and the same system prompt, not [`inherit_context`](agents.md#frontmatter-fields)'s text rendering of them. The extension takes it from memory, and it is compaction-aware, so the copy reads what the main model is working from.

The clone gets one tool and one job. It cannot read, write or run anything, because an invisible turn with the full toolset could do invisible work.

The extension attributes the agent it starts to the *real* session, so its transcript and `rootSessionId` land where they would have anyway. The agent carries no `tool-use-id`, because the main conversation never issued one.

A `model` start shows a `Prompting @reviewer…` toast. The wording marks the wait for that turn, where `direct`'s `Started @reviewer` means it is already running. In `direct` mode the agent starts there, immediately, with your message verbatim as its prompt. There is no model call, so there is no latency before it begins.

Either way the started agent honours its own frontmatter: `model:`, `thinking:`, `max_turns:` all apply, unless you name a model or reasoning level in `model` mode.

- `direct` sends your message unchanged and carries no overrides.
- `model` reads your words, so `@reviewer with model deepseek flash and reasoning high, review the ADR` sets `model` and `thinking` for that run.
- The clone's `agent` tool refuses `max_turns`, `run_in_background`, and `resume`. `inherit_context`, `isolated` and `isolation` fill as on the main tool.
- The clone's forced background start is not disclosed as an override.
- When the tool refuses the clone's call, the extension shows a warning toast with the refusal message. It does not fall back to a direct start.

Mentioning something as the very first thing in a session works. There is simply no history to carry, and the clone still runs on your model and system prompt.

If the clone never calls the tool, because a model can always answer in prose instead, the extension starts the agent directly with your text. The toast says so, so you never end up with nothing running.

`model` is also the only mode that works outside the TUI. `pi -p '@reviewer the migration'` clones, spawns, and reports through the normal completion path. A direct start would have detached the agent and printed nothing. Messaging and resuming stay TUI-only for that reason, in both modes.

Two things to weigh against `direct`: the clone re-sends the whole conversation, and the agent does not start until that turn finishes.

A `direct`-mode start takes the non-tool spawn path shared with cross-extension RPC, so, like it, it writes no `.output` transcript. That is the trade for skipping the model call: a `model`-mode start goes through the real `agent` tool and keeps everything.

Live tool activity and the turn counter are *not* part of that trade. A direct start renders them like any other agent. A mention-*resumed* agent goes through the full resume wiring and keeps both in either mode.

### Resuming much later

Pi persists subagent sessions by default ([`rememberAgents`](settings.md#remember-agents)). A handle therefore keeps working after the extension evicts the agent's in-memory record. `@reviewer anything else?` reopens the conversation from disk.

- Only the *definition* is re-resolved, so a continuation runs under the agent type's current frontmatter, not the one the first run used.
- If someone has since deleted or disabled the type, the extension refuses the resume rather than falling back to another agent. Re-enable it and the handle works again.
- A remembered [ephemeral agent](agent-tool.md#ephemeral-agents) has no type to resolve. Its tombstone stores the built config, and the reopen runs that config under the same minted type and handle.
- The [capability policy](settings.md#capability-policy) filters stored values that it now denies, and notifies you. It refuses the reopen only when filtering empties an explicit tool list.
- The `@` list shows a remembered ephemeral agent under its display name, and never offers an ephemeral type as startable.
- Names from an evicted agent stay reserved, so a later reviewer becomes `reviewer-2` rather than shadowing something you can still reach. The extension keeps the 100 most recent, and forgets all of them on `/new` and session switch. A resumed agent takes those names back, so `@reviewer` keeps meaning the same conversation.
- An agent whose session was only ever in memory leaves nothing to reopen, and the mention starts a fresh one instead.
- If someone has since deleted the session file, the mention reports its path and keeps the handle and stored result.
- A queued reopen that stops before it starts keeps the earlier result for recovery. Its stopped notification does not show that result as new output.
- A reopened non-isolated session runs in its original working directory. If that directory is missing, the reopen refuses it.
- A reopened [isolated](worktrees.md) session runs in its original worktree and uses the same worktree save and removal lifecycle as any other run. The `agent:record` entry stores the worktree path, branch, base commit, ownership token, repo path, and original working directory.
- The reopen refuses a removed worktree, an entry with unknown isolation state, and a worktree that Git does not verify. It also refuses while cleanup may still run. In every case it keeps the handle and stored result, and the conversation does not run in the parent checkout.

## The `/agents` menu

`/agents` opens an interactive menu.

```text
Agents (4) — 2 running, 2 done · 3 in history   ← the whole tree, nested included
Agent types (6)                                 ← unified list of registered agents
Settings                                        ← every persistent setting
```

- **Agents**: the whole hierarchy, indented, with nested children under their spawner. The list marks an agent whose owner is gone as `detached`. Select an agent to open its [conversation viewer](#conversation-viewer), where `Enter` steers, `x` twice stops, and `Ctrl+O` expands the messages. The menu header counts live rows and history rows separately.
- **History**: rows below the tree, under a `History` heading, one per finished agent of the active branch, newest `completedAt` first. A row shows the status icon, the handle or alias, the type, the description, and the age of `completedAt`. Select one to open its [read-only viewer](#a-finished-agents-conversation), which never starts a run. A tombstone with a live record never lists, a nested agent never gets a row, and the history holds at most 100 rows.
- **Agent types**: a unified list with source indicators: `•` (project), `◦` (global), `▹` (skill), `✕` (disabled). Each row shows the agent's model, and the full description of the highlighted agent appears below the list. The model column flags `(unavailable, fallback: inherit)` when the extension cannot resolve a configured model. It shows `(→ provider/id)` when the model resolves to a different provider or version than configured. Select an agent to manage it:
  - **Skill agents**: Eject, Disable.
  - **Custom agents**: Edit, Disable, Delete.
  - **Disabled agents**: Enable, Edit, Delete.
- **Eject**: copies a skill agent's `.md` file to a project or personal location, so you can customize it.
- **Disable/Enable**: toggles agent availability. Disabled agents stay visible in the list, marked `✕`, and can be re-enabled.
- **Settings**: changes any [persistent setting](settings.md) at runtime.

## Completion notifications

Background agent completion notifications render as styled boxes:

```text
✓ Find auth files completed
  ↻3 · 3 tool uses · 12.4k token · 4.1s
  ⎿  Found 5 files related to authentication...
  transcript: /tmp/pi-subagents-501/home-user-project/sess-1/tasks/0197a1b2-c3d4-7e5f-8a6b-1234567890ab.output
```

A notification carries model text and a user render separately, never the full result. Expanding it shows the full output. Group completions render each agent as a separate block.

The model receives structured `<task-notification>` XML for parsing, while the user sees the themed visual.
