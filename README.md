# @ody/pi-subagents

A [pi](https://pi.dev) extension that brings **autonomous sub-agents** to pi. Spawn specialized agents that run in isolated sessions — each with its own tools, system prompt, model, and thinking level. Run them in the background (the default) or block on them, steer them mid-run, resume completed sessions, and define your own custom agent types.

## Features

- **Native tools and UI** — the `agent`, `get_subagent_result`, `steer_subagent`, and `stop_subagent` tools follow pi's calling conventions and UI patterns
- **Parallel background agents** — spawn multiple agents that run concurrently with automatic queuing (configurable concurrency limit, default 10) and smart group join (consolidated notifications)
- **Live widget UI** — persistent above-editor widget with animated spinners, live tool activity, token counts, and colored status icons. Configurable via `/agents → Settings → Widget`: `all` (every agent), `background` (default — hides foreground runs, which already render inline as the `agent` tool result), or `off`
- **FleetView** — navigable **tree** of `main` + every running subagent rendered below the editor, with [nested children](#nested-subagents) indented under their owner. `↓` (or `←`) at an empty prompt jumps in. `↑`/`↓` move the selection. `←`/`→` collapse and expand a row that owns children. `Enter` opens the selected agent's live conversation. `Esc` returns. Toggle via `/agents → Settings → Fleet view`
- **Conversation viewer** — select any agent in `/agents` to open a live-scrolling overlay of its full conversation (auto-follows new content, scroll up to pause). Steering and stopping both work for background agents too.
  - Steer a running agent inline. Press `Enter` to open a composer, type, then press `Enter` to send (`Esc` or an empty submit returns). The message appears as a user message and redirects the agent after its current tool.
  - Stop a still-running agent by pressing `x` (then `x` again to confirm).
  - Assistant text renders as Markdown; `m` cycles that between off, assistant-only and everything (see [Viewer markdown](#persistent-settings)).
- **Custom agent types** — define agents in `.pi/agents/<name>.md` or `.agents/agents/<name>.md` (project) or globally. YAML frontmatter sets custom system prompts, model selection, thinking levels, tool restrictions, and colored name badges
- **Nested subagents** — opt-in, default-off delegation. A custom agent that sets `allowed_subagents` gets its own ownership-scoped `agent`, `get_subagent_result`, `steer_subagent`, and `stop_subagent` tools. The extension caps depth from the main session (default 2). The agent can control only its own children. The extension stops them when the agent finishes, and their transcripts and token spend roll up to it. A child never exceeds its parent's tools, extensions, or skills
- **Agent mentions** — subagents are first-class. Type `@reviewer also check the RPC path` at the prompt. The text goes to that agent instead of the main model, and none of it enters the chat. Toggle via `/agents → Settings → Agent mentions`.
  - One syntax covers the whole lifecycle. Message an agent while it runs. Resume it once it has finished. Reopen its session from disk long after that. Start it if it never ran.
  - Mentioning an agent that isn't running spawns it through an off-screen clone of the conversation. The agent gets a context-written prompt and a real `agent` tool call, and none of it reaches the chat. `direct` mode starts it here from your text instead, with no model call at all.
  - The orchestrator can `name` an agent so you address it as `@auth-audit`, and handles work in `steer_subagent`/`get_subagent_result` too.
  - `@` completes live agents, resumable ones, and startable types alongside pi's file completion. `@main` forces text back to the main model.
- **Mid-run steering** — inject messages into running agents to redirect their work without restarting
- **Session resume** — pick up where an agent left off, preserving full conversation context. The session keeps its model and thinking level; `run_in_background` and `max_turns` come from the resuming call, else from the run's original values. Pass `run_in_background: false` to block and get the result inline
- **Graceful turn limits** — agents get a "wrap up" warning before hard abort, producing clean partial results instead of cut-off output
- **Case-insensitive agent types** — `"reviewer"`, `"Reviewer"`, `"REVIEWER"` all work. A type that doesn't resolve to exactly one *enabled* agent gets an error that lists the enabled types. That covers unknown types, disabled types, and types ambiguous between two agents differing only by case
- **Fuzzy model selection** — specify models by name (`"haiku"`, `"sonnet"`) instead of full IDs, with automatic filtering to only available/configured models
- **Context inheritance** — optionally fork the parent conversation into a sub-agent so it knows what the parent discussed
- **Git worktree isolation** — run agents in isolated repo copies; changes auto-committed to branches on completion
- **Skill preloading** — inject named skills into agent system prompts, discovered from `.pi/skills/`, `.agents/skills/`, and global locations (Pi-standard `<name>/SKILL.md` directory layout supported)
- **Tool denylist** — block specific tools via `disallowed_tools` frontmatter
- **Styled completion notifications** — background agent results render as themed, compact notification boxes (icon, stats, result preview) instead of raw XML. Expandable to show full output. Group completions render each agent individually
- **Event bus** — lifecycle events (`subagents:created`, `started`, `completed`, `failed`, `steered`, `compacted`) emitted via `pi.events`, enabling other extensions to react to sub-agent activity
- **Cross-extension RPC** — other pi extensions can spawn, stop, and join subagents via the `pi.events` event bus (`subagents:rpc:ping`, `subagents:rpc:spawn`, `subagents:rpc:stop`, `subagents:rpc:consume`). Standardized reply envelopes with protocol versioning. Emits `subagents:ready` on session start. **[Full reference](docs/rpc.md)**
- **Model scope enforcement** — opt-in validation that subagent model choices stay within your pi `enabledModels` allowlist (from `/scoped-models`, honoring both global and project-local pi settings). A caller-supplied out-of-scope model gives a hard error to the orchestrator. The session model replaces an out-of-scope model pinned in an agent file, with a warning toast and a note in the tool result. Toggle via `/agents → Settings → Scope models`

## Install

Install from git:

```bash
pi install git:github.com/ody/pi-subagents
```

Or load a local checkout directly:

```bash
pi install /path/to/pi-subagents
```

Or load the extension entry for development:

```bash
pi -e ./src/index.ts
```

Requires pi **1.0.0 or newer**. Earlier versions are not supported. The `peerDependencies` range declares it, so npm flags an older pi at install time.

### Other hosts

The maintainers develop and test this extension against [pi](https://pi.dev).

Third-party adapters report running it elsewhere. Their authors maintain these independently of this project. We do not test them here, our CI does not cover them, and compatibility may break with any release.

- **DeepSeek Harness (`dsh`)** — via an adapter that maps pi's host API onto native DSH agents. Details and reports: the adapter's issue tracker.

## Quick Start

The parent agent spawns sub-agents using the `agent` tool:

```js
agent({
  subagent_type: "reviewer",
  prompt: "Find all files that handle authentication",
  description: "Find auth files",
  run_in_background: true,
})
```

Agents run in the background by default. The call returns an ID immediately and notifies you on completion with a preview of the result (use `get_subagent_result` for the full text). Pass `run_in_background: false` to block until the agent finishes and get its full output inline.

## UI

The extension renders a persistent widget above the editor showing active agents. By default it shows background runs only (`widgetMode: background`) — foreground agents already render inline as the `agent` tool result, so the widget would otherwise double-render them. Switch to `all` (every agent) or `off` (hide the widget) via `/agents → Settings → Widget`:

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

The token field carries two optional signals inside parens:

- **`NN%`** — context-window utilization (color-coded: <70% dim, 70–85% warning, ≥85% error). Omitted when the model has no declared `contextWindow`, or briefly right after compaction.
- **`⇊N`** — number of times the session has compacted, when > 0. Stays dim; the percent's color carries urgency.

### FleetView

While subagents are running, a navigable list renders **below** the editor:

```text
  ↑↓ select · ←→ collapse · enter view · esc back

   ● main
  ▾○ worker           Sleep then report 1                               11s · ↓ 13.1k tokens
     ○ reviewer       Find the route table                               4s · ↓ 2.1k tokens
   ○ worker           Sleep then report 2                               11s · ↓ 13.1k tokens
                                                                                   ↓ 3 more
```

The list is a tree. A [nested child](#nested-subagents) sits indented under the agent that spawned it, at any depth. So every agent in the session is reachable, openable, steerable and stoppable, which nested ones were not when the list showed only the top level.

Three rules govern the tree:

- A row that owns children carries `▾` when expanded and `▸` when collapsed. `→` expands, `←` collapses, and `←` on a leaf moves up to its parent.
- An agent whose owner is gone — evicted by cleanup — renders at the top level marked `↯`, rather than vanishing.
- Selection follows the row, not its position, so an agent starting or settling elsewhere in the tree never moves the cursor out from under you.

Which rows appear:

- The list orders siblings earliest-launched first.
- The list shows only agents you can actually open. A pending or queued agent with no session yet appears once it starts.
- An owner is always kept while a descendant of it is live, so an active grandchild never shows up detached.

The keys, at an **empty prompt**:

- `↓` (or `←`) moves focus from the prompt into the list. `●` marks the selected row, and `○` marks the rest.
- `↑`/`↓` move the selection. `Esc`, or `↑` above `main`, returns to the prompt, as does selecting `main`.
- `Enter` opens the selected agent's live conversation overlay, which auto-updates as the agent works.
- Inside that overlay, `Enter` steers the running agent. Type a message and press `Enter` to send it (`Esc` or an empty submit returns). This redirects the agent the same way the `steer_subagent` tool does.

The selected row renders in the theme's primary text color rather than the muted/dim treatment of the others. An agent with a configured `color` shows its badge there too, bolded.

A viewer stays open when its agent finishes so you can read the final output. Finished agents linger in the list for a few seconds before dropping out. Typing anything at a non-empty prompt behaves normally. The list only captures arrow keys when the prompt is empty. Disable it entirely via `/agents → Settings → Fleet view`.

### Agent mentions

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
| running or queued | sends the message into its conversation, exactly as `steer_subagent` would |
| finished | **resumes** it in the background from its existing session, continuing where it left off |
| finished long ago, record gone | **reopens** its session from disk and continues there |
| never started | **starts** it — by default, through a clone of this conversation ([below](#starting-a-new-agent)) |

No turn is ever spent in the main conversation, and nothing about the mention enters the chat. The answer comes back as the ordinary background-completion notification, so the main model can relay it.

#### Starting a new agent

In `model` mode the clone receives your message with a `<system-reminder>` appended. The reminder says the user wants to invoke the agent X. It asks the model to invoke the agent and pass in the required context. The clone's model then makes the tool call. There is no tool forcing and no allowed-tools narrowing. The mention constrains *which* agent, not what it is told.

So the model writes the agent's prompt, giving it the conversation context a cold spawn lacks.

The cost is a visible turn — the model's reasoning and its tool block, narrating a decision you already made by typing the handle. This extension keeps the mechanism and moves it off-screen. The extension copies the conversation into a throwaway in-memory session. That clone takes the turn holding only the `agent` tool. What it starts is an ordinary top-level agent:

```text
@cyan whats your favorite color        →  (nothing in the chat)
  └─ clone of this conversation, off-screen
       └─ agent(subagent_type: "cyan", prompt: …)
            ▸ Cyan Agent   favorite color        ← widget, fleet row, handle
```

It is a literal clone: the session's own entries and the same system prompt, not [`inherit_context`](#frontmatter-fields)'s text rendering of them. The extension takes it from memory and it is compaction-aware, so the copy reads what the main model is working from.

The clone gets one tool and one job. It cannot read, write or run anything, because an invisible turn with the full toolset could do invisible work.

The extension attributes the agent it starts to the *real* session, so its transcript and `rootSessionId` land where they would have anyway. The agent carries no `tool-use-id`, because the main conversation never issued one.

| Mode | `@planner sketch the migration`, with no planner agent running |
| --- | --- |
| `model` (default) | a clone of this conversation takes the turn off-screen and calls `agent`, so the agent starts with a prompt **written from the conversation**. Nothing reaches the chat but a `Prompting @reviewer…` toast — the wording marks the wait for that turn, where `direct`'s `Started @reviewer` means it is already running |
| `direct` | the agent starts here, immediately, with your message verbatim as its prompt. No model call at all, so no latency before it begins |
| `off` | `@` means only "attach a file" again |

Either way the started agent honours its own frontmatter — `model:`, `thinking:`, `max_turns:` all apply, unless you name a model or reasoning level in `model` mode.

- **`direct`** sends your message unchanged and carries no overrides.
- **`model`** reads your words, so `@reviewer with model deepseek flash and reasoning high, review the ADR` sets `model` and `thinking` for that run.
- The clone's `agent` tool refuses `max_turns`, `run_in_background`, and `resume`. `inherit_context`, `isolated`, and `isolation` fill as on the main tool.
- The clone's forced background start is not disclosed as an override.
- When the tool refuses the clone's call, the extension shows a warning toast with the refusal message and does not start the agent directly.

Mentioning something as the very first thing in a session works. There is simply no history to carry, and the clone still runs on your model and system prompt.

If the clone never calls the tool (a model can always answer in prose instead), the extension starts the agent directly with your text. The toast says so, so you never end up with nothing running.

`model` is also the only mode that works outside the TUI. `pi -p '@reviewer the migration'` clones, spawns, and reports through the normal completion path. A direct start would have detached the agent and printed nothing. Messaging and resuming stay TUI-only for that reason, in both modes.

Two things to weigh against `direct`: the clone re-sends the whole conversation, and the agent does not start until that turn finishes.

#### Named agents

The `agent` tool takes an optional `name`, so the orchestrator can call one `auth-audit` instead of leaving you to tell `@reviewer-2` from `@reviewer-3`. A name is *additive*: the type-derived handle is still assigned, so `@reviewer` keeps reaching that agent rather than starting a second one beside it.

Both names share one namespace, so an alias can never shadow a live handle or the reverse. The popup shows one row per agent, under its alias, with the type moved into the description. `steer_subagent`, `get_subagent_result`, and `stop_subagent` accept a handle too, so you and the model address agents the same way.

#### Resuming much later

Pi persists subagent sessions by default ([`rememberAgents`](#persistent-settings)). A handle therefore keeps working after the extension evicts the agent's in-memory record. `@reviewer anything else?` reopens the conversation from disk.

- Only the *definition* is re-resolved, so a continuation runs under the agent type's current frontmatter, not the one the first run used.
- If someone has since deleted or disabled the type, the extension refuses the resume rather than falling back to another agent. Re-enable it and the handle works again.
- Names from an evicted agent stay reserved, so a later reviewer becomes `reviewer-2` rather than shadowing something you can still reach. The extension keeps the 100 most recent, and forgets all of them on `/new` and session switch. A resumed agent takes those names back, so `@reviewer` keeps meaning the same conversation.
- An agent whose session was only ever in memory leaves nothing to reopen, and the mention starts a fresh one instead.
- If someone has since deleted the session file, the mention says so and frees the handle. It does not silently send your message to a new agent.

The grammar is deliberately narrow so nothing gets swallowed by accident:

| Input | Goes to |
| --- | --- |
| `@reviewer fix the flaky test` | the `reviewer` agent |
| `@main @reviewer is not a mention` | the main model, with the leading `@main` and its trailing space stripped — the escape hatch |
| `@reviewer` (no message) | the main model — a bare handle is never a send |
| `hey @reviewer look at this` | the main model — only a **leading** mention goes to an agent |
| `@src/index.ts summarize this` | the main model, with pi's normal file attachment |
| `@nosuchagent hello` | the main model, verbatim — no agent, no type, no interception |

While an agent is live its handle addresses *it*, so `@reviewer` never starts a second reviewer alongside a running one — use the `agent` tool for deliberate parallelism. `@<agent-id>` works too.

Three rules decide what a handle can name:

- `main` is a reserved name and can never be an agent's handle. A type slugging to it gets `main-2`.
- Handles have a 64-character limit.
- [Nested subagents](#nested-subagents) are not addressable. They are absent from every programmatic top-level surface. Only their owner may steer them *by tool*. A handle that would name one starts a fresh top-level agent instead of reaching through that boundary. They are still visible and steerable by hand in [FleetView](#fleetview) and `/agents → Agents`.

Suggestions list live agents first, then resumable ones, then startable types, and then pi's own file rows in the same popup. `@` stays the file picker it always was. The extension adds the handles to it rather than replacing it. Disable the whole thing via `/agents → Settings → Agent mentions`.

A `direct`-mode start takes the non-tool spawn path shared with cross-extension RPC, so — like it — it writes no `.output` transcript. That is the trade for skipping the model call: a `model`-mode start goes through the real `agent` tool and keeps everything.

Live tool activity and the turn counter are *not* part of that trade — a direct start renders them like any other agent. A mention-*resumed* agent goes through the full resume wiring and keeps both in either mode.

### Result rendering

Individual agent results render in the conversation as follows:

| State | Example |
| --- | --- |
| **Running** | `⠹ ↻3≤30 · 3 tool uses · 12.4k token (8%)` / `⎿ searching, reading 3 files…` |
| **Completed** | `✓ ↻8 · 5 tool uses · 33.8k token (62%) · 12.3s` / `⎿ Done` |
| **Wrapped up** | `✓ ↻50≤50 · 50 tool uses · 89.1k token (84% · ⇊2) · 45.2s` / `⎿ Wrapped up (turn limit)` |
| **Stopped** | `■ ↻3 · 3 tool uses · 12.4k token (8%)` / `⎿ Stopped` |
| **Error** | `✗ ↻3 · 3 tool uses · 12.4k token (8%)` / `⎿ Error: timeout` |
| **Aborted** | `✗ ↻55≤50 · 55 tool uses · 102.3k token (95% · ⇊3)` / `⎿ Aborted (max turns exceeded)` |

Press ctrl+o in pi to expand a completed result and show the full agent output inline.

By default, foreground and background agents each stream their full conversation to a per-subagent transcript. The transcript is a JSON-lines file at `<os-tmpdir>/pi-subagents-<uid>/<cwd>/<session>/tasks/<agent-id>.output` (owner-only `0700`; the OS clears it on reboot).

- Set `output_transcript: false` on a custom agent to write no transcript path or file for it.
- Set `outputTranscript: false` in `subagents.json` to make transcripts opt-in for the whole project. Frontmatter overrides the project default.

This governs **only** the transcript. It is independent of `persist_session` (the pi session on disk). It does not affect `isolation: worktree` (which commits the agent's work to a git branch). Set that accordingly if the goal is to keep a run off disk entirely.

Background agent completion notifications render as styled boxes:

```text
✓ Find auth files completed
  ↻3 · 3 tool uses · 12.4k token · 4.1s
  ⎿  Found 5 files related to authentication...
  transcript: /tmp/pi-subagents-501/home-user-project/sess-1/tasks/agent-abc123.output
```

Group completions render each agent as a separate block. The LLM receives structured `<task-notification>` XML for parsing, while the user sees the themed visual.

## Custom Agents

Define custom agent types by creating `.md` files. The frontmatter `name:` is the `subagent_type` and dispatch identity, falling back to the filename when absent; `display_name` only changes the UI label.

The extension discovers agents from four locations (higher priority wins):

| Priority | Location | Scope |
| --- | --- | --- |
| 1 (highest) | `.pi/agents/<name>.md` | Project — pi's config dir; authoritative, and where `/agents` writes |
| 2 | `.agents/agents/<name>.md` | Project — the shared cross-tool `.agents` workspace (same convention as `.agents/skills/`) |
| 3 | `$PI_CODING_AGENT_DIR/agents/<name>.md` (default `~/.pi/agent/agents/<name>.md`) | Global — available everywhere |
| 4 (lowest) | `$PI_CODING_AGENT_DIR/skills/.../<skill>/agents/<name>.md` | Skill — agents a skill ships for its own use |

Project-level agents override global ones with the same name, so you can customize a global agent for a specific project.

- If both project locations define the same name, **`.pi/agents/` wins**. `.pi` stays the project authority. `.agents/agents/` is an additional read location for projects that keep their agent assets in the `.agents` workspace.
- The global location follows the upstream `PI_CODING_AGENT_DIR` env var — set it to relocate all pi-coding-agent state (agents, skills, settings) to a custom directory.
- An agent's name is its frontmatter `name:`, falling back to the filename. Two files can now claim the same name. The later load wins, and the warning below names the file that took over.

A skill can ship agents in an `agents/` directory next to its `SKILL.md`. It can then dispatch work into a clean context without asking the user to install agent files. The extension finds skills the way pi does: any directory under `$PI_CODING_AGENT_DIR/skills/` that holds a `SKILL.md`, at any depth, following symlinks. Rules for skill agents:

- Any user location overrides a skill agent of the same name.
- Two skills shipping the same name log a warning. The skill found later wins: the walk is breadth-first, sorted by name at each level.
- `/agents` never edits a skill's file. **Eject** copies it to a user location, and **Disable** writes a user stub that shadows it.

The extension skips an unreadable or unparseable agent file instead of failing. A warning names the file and the error. If it was overriding a same-named agent, a second line names the file that loads instead. Set `strictAgentFiles: true` in `subagents.json` (or `/agents → Settings → Strict agent files`) to fail startup on a broken file instead; mid-session reloads still only warn.

### Example: `.pi/agents/auditor.md`

```markdown
---
color: red
description: Security Code Reviewer
tools: read, grep, find, bash
model: anthropic/claude-opus-4-6
thinking: high
max_turns: 30
---

You are a security auditor. Review code for vulnerabilities including:
- Injection flaws (SQL, command, XSS)
- Authentication and authorization issues
- Sensitive data exposure
- Insecure configurations

Report findings with file paths, line numbers, severity, and remediation advice.
```

Then spawn it by its name:

```js
agent({ subagent_type: "auditor", prompt: "Review the auth module", description: "Security audit" })
```

### Frontmatter Fields

All fields are optional — sensible defaults for everything.

| Field | Default | Description |
| --- | --- | --- |
| `description` | filename | Agent description shown in tool listings |
| `name` | filename | **The agent's type** — what `subagent_type` and `@handle` address. See [`name` and `color` rules](#name-and-color-rules) |
| `display_name` | the type | Label shown in the UI (widget, agent list, badges) — cosmetic only, and independent of `name`. A file that sets only `name` badges as its type, unchanged |
| `color` | — | Background color for the agent name badge. See [`name` and `color` rules](#name-and-color-rules) |
| `tools` | all 7 | Which tools the agent can call. Built-in names (`read, grep, …`), `*` / `all` (all built-ins), `none`, and `ext:<extension>` / `ext:<extension>/<tool>` selectors for extension tools. See [Tool & extension scoping](#tool--extension-scoping) below |
| `extensions` | `true` | Which extensions to load for the agent. `true` (all defaults), `false` (none), or an explicit list: `[mcp, "/abs/path.ts", "*"]`. See [Tool & extension scoping](#tool--extension-scoping) below |
| `exclude_extensions` | — | Extension denylist applied after `extensions:` — exclude wins. Plain names only (case-insensitive), no paths or `*`. Useful with `extensions: true` to drop one extension (e.g. `pi-notify`) |
| `skills` | `true` | `true` inherits the parent's skills; `false` inherits none. A comma-separated list preloads **only** those skills into the system prompt and does not inherit the rest (see [Skill Preloading](#skill-preloading) for discovery locations) |
| `disallowed_tools` | — | Comma-separated tools to deny even if extensions provide them |
| `isolation` | — | Set to `worktree` to run in an isolated git worktree, or `off` to refuse one even when the caller passes `isolation: "worktree"` (frontmatter is authoritative). The extension accepts `none`, `no`, and `false` as spellings of `off` |
| `model` | inherit parent | Model — `provider/modelId` or fuzzy name (`"haiku"`, `"sonnet"`). Resolution is tolerant (`.`/`-` and a trailing date stamp are interchangeable). It falls back to the same model under another provider if the named one doesn't have it |
| `thinking` | inherit | off, minimal, low, medium, high, xhigh, max — actual availability depends on your pi version and model; pi clamps unsupported levels down |
| `max_turns` | unlimited | Max agentic turns before graceful shutdown. `0` or omit for unlimited. A caller `max_turns` overrides it |
| `persist_session` | `subagents.json` `rememberAgents` (default `true`) | Persist this subagent as a normal pi session instead of keeping the session in memory only; overrides the `rememberAgents` project default in both directions. It records its spawning session as parent, so it nests under it in `/resume`. The subagent's `.output` transcript is still written either way unless `output_transcript: false` |
| `output_transcript` | `true` (or `subagents.json` `outputTranscript`) | Write this subagent's `.output` transcript; when set, overrides the `subagents.json` `outputTranscript` default. Set `false` to write no transcript file or path. Governs only the transcript — independent of `persist_session` and `isolation: worktree` |
| `session_dir` | pi default | Optional session directory when `persist_session: true`; omitted uses pi's normal session location, and relative paths resolve from the agent cwd. A session outside the parent's session directory (this override, or `isolation: worktree`) appears separately in the list, so it shows as a root instead of nesting |
| `allowed_subagents` | none | Opt in to scoped nested `agent`, `get_subagent_result`, `steer_subagent`, and `stop_subagent` tools. Omitted / empty / `none` / `false` = no nesting. `all` (or `"*"` / `true`) = any enabled agent. Comma-separated list = only those agent types |
| `prompt_mode` | `replace` | `replace`: body is the full system prompt (no AGENTS.md / CLAUDE.md inheritance). `append`: body appended to parent's prompt (inherits parent's AGENTS.md / CLAUDE.md). The extension tags a `replace` agent `(bare)` in the widget, viewer, and tool result |
| `inherit_context` | `false` | Fork parent conversation into agent |
| `run_in_background` | — | Default this agent to background (`true`) or foreground (`false`); a caller value overrides it. Omit to follow `backgroundByDefault` |
| `isolated` | `false` | Hermetic specialist mode: forces `extensions: false` + `skills: false` + drops `ext:` selectors. Only built-in tools. Distinct from `isolation: worktree` (filesystem) |
| `enabled` | `true` | Set to `false` to disable an agent (useful for hiding a skill agent per-project) |

#### Name and color rules

`name`:

- The filename does not have to match, so `blubb.md` with `name: code-review` dispatches as `code-review`. Omit it and the extension uses the filename.
- Any value works except one containing `:`, which plugin-scoped identifiers reserve. The extension skips such a file with a warning.
- Two files may declare the same name; the later load wins, as a filename clash always did.

`color` sets the badge in the agent tool header, widget, FleetView, and conversation viewer. Accepted value:

- Quoted six-digit hex such as `"#8B5CF6"`. Color names are not accepted.

Badge text is black or white, whichever clears 4.5:1 against the rendered background. Invalid values render no badge and preserve each surface's existing theme foreground.

The caller can override four fields of a named agent for one run: `model`, `thinking`, `max_turns`, and `run_in_background`. Precedence is the `agent` tool parameter, then frontmatter, then the default (the session model, pi's default thinking level, `defaultMaxTurns`, and `backgroundByDefault`; nested calls default to foreground). A caller `max_turns` of `0` means unlimited and is not re-resolved from the file. Every other field binds the agent: `inherit_context`, `isolated`, and `isolation` only fill what the file leaves unspecified, and `isolation: off` still refuses a worktree.

`model` is the exception. A `model` passed to the `agent` tool takes effect even against a pin. So `model:` in an agent file means "this agent's model unless the caller says otherwise". Three consequences:

- The extension discloses the displaced pin. The widget, the tool-result header and the conversation viewer render `opus 4.6 (over pinned anthropic/claude-haiku-4-5)`.
- The tool schema does not advertise the capability. The `model` parameter tells the model to set it only when the user named one. It says nothing about pins or precedence, so it is a user-driven override rather than something the orchestrator reaches for on its own.
- A caller model that does not resolve is a hard error. The extension refuses the spawn rather than quietly demoting it to the pin. An out-of-scope caller model gets the same policy under [Model Scope](#model-scope).

**Forgiving `model:` resolution.** The extension matches a `model:` pin against pi's model registry tolerantly. Cosmetic id variations therefore don't silently drop the agent back to the parent's model:

- The extension treats `.` and `-` as equivalent in version numbers (`claude-haiku-4.5` ≡ `claude-haiku-4-5`).
- A trailing `-YYYYMMDD` date stamp is optional (`anthropic/claude-haiku-4-5-20251001` matches an undated registry id and vice-versa).
- A `provider/modelId` whose named provider doesn't carry that model retries the bare id against every provider.

Precedence is **exact → fuzzy under the named provider → same model under any provider → unavailable**. An exact match always wins, so dated snapshots aren't conflated.

If nothing resolves, the pin can't run and the agent inherits the parent model. `/agents → Agent types` flags this case as `(unavailable, fallback: inherit)` and shows the resolved target `(→ provider/id)` when resolution lands on a different provider or version than configured.

This is distinct from [Model Scope](#model-scope) enforcement, which matches the `enabledModels` allowlist by *exact* entry.

### Nested subagents

Nested delegation is default-off. Set `allowed_subagents` only on a non-isolated custom agent that owns a real fan-out responsibility:

```yaml
---
tools: read, grep, find
extensions: false
allowed_subagents: support-file-finder, support-callsite-tracer   # or `all`
---
```

**A nested child never exceeds its parent.** The extension records the parent's effective tools, extensions, and skills on its record when it builds the session. Those values already include the [capability policy](#capability-policy) and its own ceiling. The bound is therefore transitive.

- The extension compares a child's values with the parent's using the policy's expansion rules. Wildcards, `true`, and whole-extension selectors expand and narrow, and a child's `skills: true` under a parent list narrows to that list.
- The parent's `disallowed_tools` and `exclude_extensions` apply to the child.
- The extension narrows a file value or default that exceeds the parent. It adds a warning to the user and a note in the nested tool result.
- A child's `allowed_subagents` is a subset of its parent's, and `all` only when the parent has `all`. The extension narrows a file value with a warning, and the main session counts as `all`.
- The extension refuses a nested spawn whose parent record has no recorded set.
- The same set filters extension tools that register after spawn.
- Top-level, `@handle`, and RPC spawns have no parent, so only the policy bounds them.

The read-only agent above therefore cannot obtain writes through its children, but `allowed_subagents` still decides which types it may start.

`allowed_subagents` is runtime-enforced, and takes three forms:

- A comma-separated list restricts nesting to those types.
- `all` (or `"*"` / `true`, matching how `extensions:` and `skills:` take booleans) allows any enabled agent.
- Omitted, empty, `none`, or `false` means the extension injects no nested tools at all.

The extension rejects unknown, disabled, and out-of-list types. It validates a nested `model:` against [Model Scope](#model-scope) exactly like a top-level spawn.

Result, resume, and steering operations are ownership-scoped, so a parent can control only its own children. Nested records stay internal to that parent for every *programmatic* surface: top-level tools, lifecycle events, the [RPC channels](docs/rpc.md), and `@handle` resolution. When a parent finishes, stops, or ends a resumed turn, the extension stops its nested children with it.

Three things survive that boundary:

- Nested agents write their own `.output` transcript (subject to the same `output_transcript` gate). The extension files it under the root session's directory alongside their ancestors', so you can still inspect a nested run after the fact.
- Their token usage folds into every ancestor's totals up to the top-level agent (lifecycle events, completion notifications, `/agents`). Nested spend therefore stays attributable at any depth.
- The extension labels a nested result that ends `stopped`, `aborted`, or `steered` as partial, the same guarantee top-level results carry.

The **human** surfaces are not part of that ownership boundary. A nested child appears indented under its owner in [FleetView](#fleetview), in `/agents → Agents`, and, while running, in the above-editor widget. You can open, steer and stop it from any of them. Ownership scoping keeps siblings and other extensions out of each other's agents. It does not hide an agent from the person running the session.

The hard cap is depth 2 by default: main session (0) → subagent (1) → nested child (2). Change it project-wide with `maxSubagentDepth` in `subagents.json` (or `/agents → Settings → Nested depth`).

- `0` or `1` turns nesting off everywhere.
- An agent already at the cap gets no nested tools at all — not even `get_subagent_result`, since it can never own a child.
- A child must independently set `allowed_subagents` to delegate again.
- Isolated agents never receive nested tools.

Nested children occupy no concurrency slot, in either pool. Their parent already holds one, and queueing them behind it would deadlock a parent waiting on its own child. The depth cap bounds how *deep* nesting goes, not how *wide*. A parent's only limit on concurrent children is that each spawn costs it a turn. Pair `allowed_subagents` with a `max_turns` on that agent if you want a hard ceiling on its fan-out.

A subagent session never activates this extension. That keeps a child from building a second agent manager, and it is why the extension injects nested tools directly instead. A subagent therefore also gets none of the extension's other surfaces: no `/agents` command, no cross-extension RPC handlers, no `subagents:ready` event.

### Tool & extension scoping

`extensions:` decides **which extensions load**, `tools:` decides **which tools surface to the LLM**. They compose:

```yaml
# Default (both omitted): all extensions load, all 7 built-ins surface

tools: read, grep, find           # narrow to listed built-ins; extensions still load
tools: "*"                        # all 7 built-ins (alias: `all`)
tools: none                       # zero built-ins (alias: `""`)
tools: "*, ext:mcp/search"        # built-ins plus one extension tool

extensions: false                 # no extensions load
extensions: [mcp]                 # only mcp loads
extensions: ["*", "/abs/foo.ts"]  # all defaults plus one path-loaded extension

exclude_extensions: pi-notify     # everything except pi-notify (with extensions: true)

# Specialist: load one extension, expose only one of its tools, keep built-ins
extensions: [mcp]
tools: "*, ext:mcp/search"

isolated: true                    # hermetic: built-ins only, no extensions/skills/context
```

A few rules the examples don't make obvious:

- `extensions:` is the sole loading authority. `ext:foo` in `tools:` narrows what surfaces; it can't load `foo` on its own. Mismatches fire `extension-error:…` warnings.
- Any `ext:` entry flips extension tools to an explicit allowlist — unnamed extensions still load (handlers fire) but expose no tools. So `tools: "*, ext:mcp/search"` exposes only `search` from `mcp`, nothing from any other extension.
- Extension names match case-insensitively (`[Mcp]` = `[mcp]`); tool names in `ext:foo/bar` stay case-sensitive.
- Extensions that register tools **lazily** work too. MCP-backed extensions typically can't enumerate their tools until their servers connect, so they register from `session_start` or `before_agent_start` rather than at load. The extension re-derives subagent scoping as tools appear, so these surface normally. That includes `ext:` selectors, which keep narrowing correctly no matter when a tool shows up.
- Extensions bound into a subagent see **both ends** of that session's lifecycle. `session_start` fires when the agent starts. `session_shutdown` (reason `quit`) fires when the extension disposes of its session, on quit and when it evicts the record ~10 minutes after the agent finishes. Release per-session resources there, because anything left armed outlives the session it belongs to. Handlers get three seconds on quit, after which teardown proceeds regardless.
- An installed **package** extension matches by its package short name (`@scope/pi-subagents` → `[pi-subagents]`), in addition to its path-derived name (a package whose entry is `src/index.ts` also answers to `[src]`). Prefer the package name — the path-derived one is incidental.
- Plain `tools:` typos fail loudly: `tools: reed, grep` fires `tools-error:…` instead of silently producing an under-tooled agent.
- `exclude_extensions:` wins over `extensions:` and over `ext:` selectors — an excluded extension never loads and a `tools: ext:` entry can't pull it back. Plain names only (no paths, no `*`); a name matching nothing fires an `extension-error:…` warning.
- `exclude_extensions:` is **not a sandbox**: excluded extensions' factory code still executes once during loading. Exclusion suppresses their tools and their bound lifecycle hooks (`pi.on` handlers like `session_start` only fire for extensions bound to the session). It does not suppress other load-time side effects: a factory that subscribes directly to the shared `pi.events` bus stays live. Don't rely on it to contain an untrusted extension.
- Array and string forms are equivalent: `[a, b]` == `"a, b"`.

**How the extension advertises an agent's scope.** The agent tool description lists every available agent with a `(Tools: …)` suffix. The orchestrator reads that suffix when deciding where to route work. It describes **built-in scope only**. The extension resolves extension tools when the agent runs (extensions may register lazily, see above). It therefore can't enumerate them when it builds the description:

| `tools:` | suffix |
| --- | --- |
| omitted, `*`, or `all` | `*` |
| a list of built-ins | that list, e.g. `read, grep` |
| `none` with `isolated: true` or `extensions: false` | `none` |
| `none`, or only `ext:` entries, with extensions loading | `no built-ins, extension tools only` |

The last two rows are separate because zero built-ins is not zero tools. `tools: none` alongside `extensions:` still surfaces every extension tool, so calling it `none` would understate what the agent can do. Note that `*` doesn't enumerate extension tools either. An agent with `tools: "*, ext:mcp/search"` advertises `*`.

## Tools

### `agent`

Launch a sub-agent.

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `prompt` | string | yes | The task for the agent |
| `description` | string | yes | Short 3-5 word summary (shown in UI) |
| `name` | string | no | Memorable name for this agent (`auth-audit`), addressable as `@name` and accepted by `steer_subagent`/`get_subagent_result`/`stop_subagent`. Additive — the type-derived handle is still assigned |
| `subagent_type` | string | no | Agent type to run. Omit it to build a one-off [ephemeral agent](#ephemeral-agents) from the parameters below. Ignored with `resume` |
| `tools` | `string[]` | no | Ephemeral only. `*`, built-in names, `none`, and `ext:` selectors, as in the agent file `tools` field. Default: all built-ins and all extension tools |
| `disallowed_tools` | `string[]` | no | Ephemeral only. Tools to remove, built-in or from an extension |
| `extensions` | `boolean` \| `string[]` | no | Ephemeral only. Default `true` |
| `exclude_extensions` | `string[]` | no | Ephemeral only. Extensions to leave out |
| `skills` | `boolean` \| `string[]` | no | Ephemeral only. Default `true` |
| `allowed_subagents` | `"all"` \| `string[]` | no | Ephemeral only. Default `[]`, which means no nesting. Refused when `policy.ephemeralNesting` is `false` |
| `prompt_mode` | `"append"` \| `"replace"` | no | Ephemeral only. Default `append` |
| `model` | string | no | Model — `provider/modelId` or fuzzy name (`"haiku"`, `"sonnet"`). Resolved tolerantly (`.`/`-` and a trailing date stamp interchangeable) with provider fallback |
| `thinking` | string | no | Thinking level: off, minimal, low, medium, high, xhigh, max (availability depends on pi version and model) |
| `max_turns` | number | no | Max agentic turns; `0` is unlimited. Overrides the agent's frontmatter; omit to use it, then `defaultMaxTurns` |
| `run_in_background` | boolean | no | Overrides the agent's frontmatter; otherwise follows `backgroundByDefault`. `false` blocks and returns the result inline. The parameter description states the default for the setting's value at startup |
| `resume` | string | no | Agent ID to resume a previous session |
| `isolated` | boolean | no | No extension/MCP tools |
| `isolation` | `"off"` \| `"worktree"` | no | `worktree` runs in an isolated git worktree; `off` (the default) does not. Absent from the schema entirely when `worktreeIsolation: false` |
| `inherit_context` | boolean | no | Fork parent conversation into agent |

#### Ephemeral agents

A call with no `subagent_type` runs an agent built from its parameters, and the agent never enters the registry.

- Passing `tools`, `disallowed_tools`, `extensions`, `exclude_extensions`, `skills`, `allowed_subagents`, or `prompt_mode` together with a `subagent_type` is an error that names the parameter.
- The extension refuses `isolated: true` together with `extensions`, `skills`, or an `ext:` entry in `tools`.
- There is no system prompt parameter. `prompt` is the task. `append` reuses the session's system prompt, and `replace` gives the sub-agent preamble and an environment block.
- The defaults are all built-in tools, `extensions: true`, `skills: true`, `allowed_subagents: []`, the session's model, `inherit_context: false`, `isolated: false`, and no worktree. `max_turns` follows `defaultMaxTurns`, and `run_in_background` follows `backgroundByDefault`.
- The extension mints the type as `ephemeral-<8 hex>`, and skips an agent file whose name starts with `ephemeral-` with a warning. Lifecycle events carry the minted type.
- The handle is `name`, else a slug of `description`, else `agent`, with no alias. The name badge is `name`, else the first three words of `description`, title-cased, else `Agent`.
- The extension does not persist the session. The agent is steerable and resumable while its record is in memory, and you cannot reopen it once the extension evicts it.
- The extension checks every value against the [capability policy](#capability-policy).
- The nested `agent` tool takes the same optional type and parameters, and runs the child in the foreground by default. The extension allows a nested ephemeral child only when the parent's `allowed_subagents` is `all`. A caller-supplied value outside the parent's set refuses the spawn. The extension narrows ephemeral defaults.
- In `agentMentions: "model"` mode, the extension refuses the conversation clone's `agent` call when it omits `subagent_type` or names a different type than the mention.

### `get_subagent_result`

Check status and retrieve results from a background agent.

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `agent_id` | string | yes | Agent ID to check |
| `wait` | boolean | no | Wait for completion |
| `verbose` | boolean | no | Include full conversation log |

Cancelling a `wait: true` call (for example, with `Esc`) stops only the wait. The background agent keeps running, and its completion notification still arrives normally.

### `steer_subagent`

Send a steering message to a running agent. The message interrupts after the current tool execution.

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `agent_id` | string | yes | Agent ID to steer |
| `message` | string | yes | Message to inject into agent conversation |

### `stop_subagent`

Stop a running or queued background agent. This is the model's own lever to end a run. A human takes the same action with `x` in FleetView, the conversation viewer, or `/agents`, and `subagents:rpc:stop` gives it to another extension.

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `agent_id` | string | yes | Agent ID to stop. A handle or alias works too |

An already-completed, errored, or otherwise terminal agent reports its status and that the result is still available. This is success, not an error, since the model's intent ("that agent should not be running") is already true.

The reply carries whatever assistant text the agent had streamed before the stop. An agent that stopped before it produced any text says so instead of showing an empty block.

The result arrives later through the ordinary completion notification, but only if the agent finishes. A stopped agent's notification carries whatever partial output it had streamed, which is also what `get_subagent_result` returns afterwards. Stopping does **not** mark the result consumed, because at stop time `get_subagent_result`'s data (`record.result`) does not exist yet.

## Commands

| Command | Description |
| --- | --- |
| `/agents` | Interactive agent management menu — agent types, running agents, settings |

The `/agents` command opens an interactive menu:

```text
Agents (4) — 2 running, 2 done              ← the whole tree, nested included
Agent types (6)                             ← unified list of registered agents
Settings                                    ← every persistent setting (see Persistent Settings)
```

- **Agents** — the whole hierarchy, indented, with nested children under their spawner. The list marks an agent whose owner is gone as `detached`. Select an agent to open its live conversation viewer, where:
  - `Enter` opens the steering composer, and `Enter` again sends a message that redirects the agent. Same mechanism as the `steer_subagent` tool. `Esc`, or an empty submit, returns.
  - `x` (then `x` again to confirm) stops or aborts it, **background** agents included. A global Esc can't unambiguously target those, and still stops a blocking foreground `agent` call instead. A stopped agent reports its partial output and flags it as incomplete, not as a completion. An agent wedged inside a tool call that never returns still frees its concurrency slot. It also fires its completion notification within a few seconds, rather than holding both forever.
  - `m` cycles how much of the transcript renders as Markdown — see [Viewer markdown](#persistent-settings).
- **Agent types** — unified list with source indicators: `•` (project), `◦` (global), `▹` (skill), `✕` (disabled). Each row shows the agent's model. The full description of the highlighted agent appears below the list. The model column flags `(unavailable, fallback: inherit)` when the extension can't resolve a configured model (it would silently inherit the parent model). It shows `(→ provider/id)` when the model resolves to a different provider or version than configured. Select an agent to manage it:
  - **Skill agents**: Eject (export as `.md`), Disable
  - **Custom agents**: Edit, Disable, Delete
  - **Disabled agents**: Enable, Edit, Delete
- **Eject** — copies a skill agent's `.md` file to a project or personal location, so you can customize it
- **Disable/Enable** — toggle agent availability. Disabled agents stay visible in the list (marked `✕`) and can be re-enabled
- **Settings** — change any [persistent setting](#persistent-settings) at runtime

## Graceful Max Turns

Instead of hard-aborting at the turn limit, agents get a graceful shutdown:

1. At `max_turns` — steering message: *"Wrap up immediately — provide your final answer now."*
2. Up to `graceTurns` (default 5) grace turns to finish cleanly
3. Hard abort only after the grace period

| Status | Meaning | Icon |
| --- | --- | --- |
| `completed` | Finished naturally | `✓` green |
| `steered` | Hit limit, wrapped up in time | `✓` yellow |
| `aborted` | Grace period exceeded | `✗` red |
| `stopped` | User-initiated abort | `■` dim |

## Concurrency

There are two independent pools.

**Background** (`maxConcurrent`, default 10). The extension queues excess agents automatically, and they start as running agents complete. The widget shows queued agents as a collapsed count. Since agents run in the background by default, nearly every spawn takes a slot. We raised the limit from 4 so that ordinary parallel fan-outs don't queue.

**Foreground** (`maxConcurrentForeground`, default `0` = unlimited). Off by default, so nothing changes unless you set it. pi dispatches a message's tool calls through `Promise.all`, so several `agent` calls with `run_in_background: false` in one message have always started at once. This setting bounds that, which helps mainly with local models, where parallel agents thrash the prompt cache. A queued foreground agent appears in `/agents → Running agents` as `queued`, and you can stop it there. Its `agent` call says so while it waits and then returns its result normally.

The two are deliberately **not** one limit. A foreground agent blocks the parent anyway. The parent could have done that work itself without paying a slot. Charging it to the background pool would therefore let a saturated pool starve the main session.

The foreground pool does not cover `resume`. A foreground resume reopens an existing session and never reaches the spawn path. Several blocking resumes in one message can still run at once. A *background* resume does take a background slot and queues behind them like any other background agent.

Nested children are outside the pool entirely: a nested child would deadlock behind a parent waiting on it.

## Join Strategies

When background agents complete, they notify the main agent. The **join mode** controls how the extension delivers these notifications. It applies only to background agents.

| Mode | Behavior |
| --- | --- |
| `smart` (default) | 2+ background agents spawned in the same turn are auto-grouped into a single consolidated notification. Solo agents notify individually. |
| `async` | Each agent sends its own notification on completion (original behavior). Best when results need incremental processing. |
| `group` | Force grouping even when spawning a single agent. Useful when you know more agents will follow. |

**Timeout behavior:** When the extension groups agents, a 30-second timeout starts after the first agent completes. If not all agents finish in time, the extension sends a partial notification with completed results. Remaining agents continue with a shorter 15-second re-batch window for stragglers.

**Configuration:**

- `defaultJoinMode` in `subagents.json`, or `/agents` → Settings → Join mode

## Model Scope

**Opt-in:** off by default. Enable via `/agents → Settings → Scope models`.

When on, the extension validates each subagent spawn's effective model against pi's own `enabledModels` list (which you configure via pi's `/scoped-models` UI). pi-subagents reads that list; it doesn't manage it. The extension honors both of pi's settings files: global `~/.pi/agent/settings.json` and project-local `<cwd>/.pi/settings.json`. **Project overrides global** — mirrors pi's `SettingsManager` deep-merge, so the extension respects a tighter per-project scope (hand-edited into the project settings).

**Out-of-scope handling depends on source:**

| Model source | Out-of-scope behavior |
| --- | --- |
| Caller-supplied via `agent({ model: "..." })` | Hard error returned to the orchestrator, listing allowed models |
| Caller-supplied via cross-extension RPC (`subagents:rpc:spawn`, e.g. pi-tasks `TaskExecute`) | Hard error returned to the calling extension, listing allowed models |
| Pinned in agent frontmatter, with no caller `model` | Warning toast + the session model runs instead; the `agent` tool result carries a note |
| Session model (nothing pinned, or the pin does not resolve) | Never checked; the session model runs |
| `agent({ resume })` of a live agent | Never checked; the agent keeps its session and model |

**Spawn paths:** the check runs on every path that starts an agent.

- The `agent` tool and the nested `agent` tool.
- `@handle` mentions, including the clone fallback and tombstone reopens.
- `subagents:rpc:spawn`.
- The registry `spawn`, which still returns only the agent id.

**Design:** `scopeModels` is a guardrail against the orchestrator picking unexpected models at runtime, not a hard policy against user-level config. A frontmatter pin outside the scope gives way to the session model, with a visible warning. The extension hard-checks a caller-supplied `model` whether or not the agent file pins one. Winning the precedence contest against a pin does not buy it a replacement instead of an error.

**Nested spawns** ([nested subagents](#nested-subagents)) apply the same table against the parent's config root. The hard-error and replacement cases are identical, including the toast and the result note.

**Pattern format:** the extension honors only exact `provider/modelId` entries (e.g. `anthropic/claude-haiku-4-5-20251001`). The extension silently drops glob patterns (`*sonnet*`), bare model IDs, and `:thinking` suffixes, which pi itself supports. pi's `/scoped-models` picker writes exact entries, so the limitation is invisible if you configure scope through the UI. Hand-edited globs produce an empty allowed set (scope check becomes a no-op).

**No-op safety:** if `enabledModels` is missing or empty in pi's settings, scope check skips entirely — no false positives, no spurious errors.

## Persistent Settings

Runtime tuning values set via `/agents` → Settings persist across pi restarts:

| Key | Values | Default |
| --- | --- | --- |
| `maxConcurrent` | 1–1024 | `10` |
| `maxConcurrentForeground` | 0–1024, `0` = unlimited | `0` |
| `defaultMaxTurns` | 0–10000, `0` = unlimited | `0` |
| `graceTurns` | 1–1000 | `5` |
| `maxSubagentDepth` | 0–16 | `2` |
| `defaultJoinMode` | `smart` / `async` / `group` | `smart` |
| `backgroundByDefault` | boolean | `true` |
| `scopeModels` | boolean | `false` |
| `strictAgentFiles` | boolean | `false` |
| `outputTranscript` | boolean | `true` |
| `worktreeIsolation` | boolean | `true` |
| `reportUsage` | boolean | `false` |
| `showCost` | boolean | `false` |
| `showModel` | boolean | `false` |
| `viewerMarkdown` | `off` / `assistant` / `all` | `assistant` |
| `fleetView` | boolean | `true` |
| `agentMentions` | `model` / `direct` / `off` | `model` |
| `rememberAgents` | boolean | `true` |
| `widgetMode` | `all` / `background` / `off` | `all` |
| `toolDescriptionMode` | `full` / `compact` / `custom` | `full` |

Two files, merged on load:

- **Global:** `~/.pi/agent/subagents.json` — your machine-wide defaults. Edit by hand; the `/agents` menu never writes here.
- **Project:** `<cwd>/.pi/subagents.json` — per-project overrides. Written by `/agents` → Settings.

### Precedence

Project overrides global on any field present in both. Missing fields fall back to the hardcoded defaults (max concurrency `10`, max foreground concurrency `0` = unlimited, default max turns unlimited, grace turns `5`, nested depth `2`, join mode `smart`).

### Nested depth

`maxSubagentDepth`, default `2`: the hard ceiling on [nested delegation](#nested-subagents), counted from the main session (main = 0, its subagents = 1). `0` or `1` disables nesting project-wide regardless of any agent's `allowed_subagents`. The extension reads it when it builds a subagent session, so a change applies to agents started after it.

### Unresolved agent types

A `subagent_type` that does not resolve to exactly one enabled agent is an error that lists the enabled types. That covers unknown, disabled, and ambiguous types, where two agents differ only by case.

- Only the `agent` tool's message suggests omitting the type to run a one-off agent.
- An empty `type` on `subagents:rpc:spawn` without `agentConfig` is an error envelope.
- A stored reference to a removed type fails when the extension uses it, and the error names the type.
- The extension ignores a key for a removed setting in `subagents.json`.

### Capability policy

An optional `policy` object in `subagents.json` bounds the tools, extensions, and skills of new agents. It is not a `/agents` setting, and `/agents` never edits it.

```json
{
  "policy": {
    "tools": { "allow": ["read", "ext:web"], "deny": ["bash"] },
    "extensions": { "deny": ["risky"] },
    "skills": { "allow": ["review"] },
    "ephemeralNesting": false
  }
}
```

- Each of `tools`, `extensions`, and `skills` takes optional `allow` and `deny` string lists. An omitted list, or no `policy`, allows everything. `ephemeralNesting` defaults to `true`.
- The extension evaluates the global and project files separately. A value must pass both, deny entries from either apply, and `ephemeralNesting: false` in either file turns it off. A project can only narrow.
- `*` is valid only in an allow list.
- Built-in tool names match exactly. `ext:<extension>` and `ext:<extension>/<tool>` select extension tools. A bare name in a deny list that is not a built-in matches any tool of that name. The delegation tools are not governed by `policy.tools`.
- An `allow` list for `tools` with no `ext:` entry and no `*` permits no extension tools.
- Extensions match by canonical name and skills by the name pi assigns, both case-insensitively. A deny entry beats an allow entry.
- A value outside the policy that the caller supplied refuses the spawn with an error that starts `Capability policy:`. The extension filters a value from an agent file instead. Filtering an explicit tool list to empty refuses.
- `ephemeralNesting: false` forces `allowed_subagents: []` on an ephemeral agent and refuses any other caller value.
- The check runs at the `agent` tool, the nested tool, `@handle` starts and tombstone reopens, `subagents:rpc:spawn`, and the registry `spawn`. Resuming a live agent is not re-checked.
- A filtered value notifies the user and adds a note to the `agent` tool result. The extension stores it on the agent's record and shows it in the conversation viewer.
- The extension narrows `skills: true` through the skill loader, and filters named skills before it preloads them. The same scope filters extension tools that register after spawn.
- A denied extension still runs its factory once at load, and a denied skill's `SKILL.md` stays readable through `read` or `bash`. The policy removes tools and bound hooks, not file access.
- The extension reads the policy at each spawn, so an edit applies without a restart.
- A wrong type or shape, `*` in a deny list, an unknown key, or a `subagents.json` that does not parse is a malformed policy. The extension denies every spawn, and a warning names the file and entry. A well-formed entry that names no built-in tool, discovered extension, or discovered skill only warns, as a `policy-warning:` tool activity when an agent starts. The spawn proceeds. Skills come from the default skill directories.
- Saving from `/agents → Settings` writes the project `policy` back unchanged. It refuses, with a warning, when the project file exists and does not parse.
- `subagents:settings_loaded`, `subagents:settings_changed`, and the `subagents:rpc:ping` reply carry `policy: { global, project, ephemeralNesting }` (plus `malformed`, a list of problems, when the policy is malformed). The ping reply is the only copy that is always current.

### Strict agent files

`strictAgentFiles`, default `false`: when on, an unreadable or unparseable [agent file](#custom-agents) aborts extension load at startup and names the file. Otherwise the extension skips it with a warning. A checked-in `.pi/agents/` therefore can't silently fall through to a same-named agent from another location. Startup only: the mid-session reload that runs on each `agent` call keeps warning either way. A bad edit shouldn't kill a session on an unrelated spawn. You can also set it from `/agents → Settings → Strict agent files`.

### Agent mentions setting

`agentMentions`, default `"model"`: whether [`@handle message`](#agent-mentions) at the prompt addresses that subagent instead of the main model. Addressing means messaging, resuming or starting it. The setting also decides whether `@` offers agents alongside pi's file completion. Toggle via `/agents → Settings → Agent mentions`. The change applies live.

- `"model"`: an off-screen clone of this conversation starts an agent that isn't running, via a `<system-reminder>` and a real `agent` call.
- `"direct"`: this extension starts it, immediately and with no model call.
- `"off"`: gates all three actions plus the suggestion list, so `@` means only "attach a file" again and every `@…` prompt reaches the main model verbatim.

`"model"` and `"direct"` differ only in [who starts an agent that isn't running](#starting-a-new-agent). Messaging and resuming are direct in both.

### Background by default

`backgroundByDefault`, default `true`: what an `agent` call that doesn't say means. Toggle via `/agents → Settings → Background by default`; applied live.

- On: the agent runs detached, the call returns its ID immediately, and a completion notification carries a preview of the result (`get_subagent_result` for the full text).
- `false`: restores the previous behaviour, where an unqualified spawn blocked the turn and returned its output inline.
- An explicit `run_in_background` on the call, or in an agent file's frontmatter, overrides this in both directions. The setting only decides what "unspecified" means.
- **Top-level only.** A nested spawn (an agent spawning its own) always defaults to foreground. The extension stops a detached child when its parent settles, and the child has no notification path of its own.

### Remember agents

`rememberAgents`, default `true`: whether subagents persist their pi session, which is what lets [`@handle`](#agent-mentions) reopen an agent's conversation after the extension evicts its in-memory record. Toggle via `/agents → Settings → Remember agents`.

Two visible consequences of the default:

- Top-level subagents write a session file.
- They nest under the session that spawned them in pi's `/resume`.

This excludes agents that another agent spawned. They get no handle, so nothing could reopen their transcript. A custom agent's `persist_session` frontmatter overrides this per agent, in both directions.

With it off, handles expire with their record (roughly ten minutes past completion) and `@reviewer` then starts a fresh agent rather than resuming. That was the behaviour before this setting existed.

### Output transcript

`outputTranscript`, default `true`: the project/global default for writing each subagent's `.output` transcript. Toggle via `/agents → Settings → Output transcript`, or set `false` in `subagents.json` to make transcripts opt-in project-wide. This helps when run transcripts shouldn't sit on disk for backup or DLP tooling to pick up. A custom agent's `output_transcript` frontmatter overrides this per agent. The change applies live at spawn time. Governs only the transcript, not `persist_session`, worktree commits, or memory files.

### Worktree isolation setting

`worktreeIsolation`, default `true`: whether `isolation: "worktree"` may create a worktree at all. With it on, an agent file's `isolation` applies on every spawn path (tool, nested tool, `@handle` mention, RPC, and registry). A file's `isolation: off` overrides a caller's worktree request. With it off, no path creates a worktree and none refuses. Toggle via `/agents → Settings → Worktree isolation`, or set `false` in `subagents.json` on a repo where a copy costs too much time or disk.

When off:

- The extension drops the `agent` tool's `isolation` parameter from the schema entirely, and the bullet describing it leaves the tool description with it. There is nothing to pass, and no context goes to describing it.
- The extension refuses worktrees on every other path too: agent files and cross-extension RPC.
- The `/agents` agent-file generator stops offering the `isolation:` frontmatter field, so a generated agent can't bake in a request that the extension would refuse.
- The extension downgrades a requested worktree to a normal run rather than failing the call, since declining one is the point. There is deliberately no note on the result. That is exactly why the prose has to go when the parameter does.

The refusal applies immediately; the parameter and its prose appear or disappear on the next pi session. See [Turning worktrees off](#turning-worktrees-off).

### Report usage to session

`reportUsage`, default `false`: whether the extension adds subagent spend to *this* session's own totals.

Subagents run in their own pi sessions, so by default pi's footer, statusline and `/cost` count only what the main model spent. A session that delegated most of its work reads as nearly free. Turn it on and each `agent` / `get_subagent_result` / `steer_subagent` / `stop_subagent` result carries the spend accumulated since the last one, and pi folds it into `getSessionStats()`. `/cost` attributes it to the **Tools/summaries** bucket. Toggle via `/agents → Settings → Report usage to session`. The change applies live.

Three things to know about the numbers:

- The extension reports every token component, `cacheRead` included. The cached prefix genuinely is re-read and re-billed on every call. pi counts it the same way for the session's own messages. Withholding it would make a subagent's rows count differently from every other row in one total. The extension's *own* token displays still leave it out. That is a different question: there it inflates a reading of how much work the agent did.
- Cost is pi's own per-message figure, priced from the model's listed rates. A model pi has no rates for contributes zero rather than an estimate.
- The context-window percentage is untouched. pi derives it from assistant messages alone, so a delegating session's context doesn't appear to fill up faster.

Agents that finish in the background have no tool result of their own to ride on, so the next call you make carries their spend. The footer catches up on the following call, not the moment they finish.

### Show cost

`showCost`, default `false`: whether the subagent surfaces print an estimated cost beside their token counts. The surfaces are the widget (running *and* finished lines), [FleetView](#fleetview), the conversation viewer, foreground results, `get_subagent_result`, and completion notifications:

```text
├─ ⠹ reviewer  inspect code · ↻3 · 8.2k token · ~$0.0042 · 4.1s
✓ reviewer  inspect code · ↻8 · 5 tool uses · ~$0.0181 · 12.3s
```

When several background agents finish together, the extension tops their notification with the batch total (`3 agents · 45.1k token · ~$0.042`). You don't have to add the figures up by hand.

The `~` marks it as pi's estimate rather than a billed figure. **The extension shows a cost only when there is one to show.** A model pi has no pricing data for reports zero. `$0.00` beside its tokens would say that someone measured the run and found it free, rather than never measuring it. So the extension prints nothing at all, on every surface.

For the same reason a real cost too small to render reads `<$0.0001`. Figures keep cents at minimum and four decimals at most (`~$0.0042`, `~$0.05`, `~$1.24`) — rounding everything to cents would print the same number for runs that differed fourfold.

Independent of `reportUsage`: this one is what you read, that one is what your session counts. Toggle via `/agents → Settings → Show cost`; applied live.

### Show model

`showModel`, default `false`: whether the widget's running rows name the model driving each agent and the thinking level it is running at:

```text
├─ ⠹ reviewer  inspect code · sonnet 4.6 · thinking: high · ↻3 · 8.2k token · 4.1s
```

Off by default because the row already carries the description, turns, tool uses, tokens and elapsed time. Every character it gains is one the description loses on a narrow terminal. The other surfaces show the pair either way. The `agent` tool result names the model beside its tags. The conversation viewer's `↳` row spells out the canonical `provider/model-id`.

Both places report what the run *actually* used. The extension reads it back from the child session once pi has resolved its defaults and clamped the level to what the model supports. It does not report what the call asked for. Where those differ, the extension keeps the losing side beside the effective value rather than dropping it. The `agent` tool result and the viewer show every field where the caller displaced an agent file's value:

| Field | Reads |
| --- | --- |
| `model` | `opus 4.6 (over pinned anthropic/claude-haiku-4-5)` |
| `thinking` | `high (over low)` |
| `thinking`, clamped by pi | `high (asked xhigh, over low)` |
| `max_turns` | `5 turns (over 20)` |
| `run_in_background` | `background (over foreground)` |

The widget shows model and thinking only. Nested spawns disclose in the widget and the viewer. A caller `model` that does not resolve refuses the spawn rather than falling back to the file's pin.

```text
  ↳ anthropic/claude-haiku-4-5 · thinking: high (asked xhigh, over low) · background (over foreground)
```

Toggle via `/agents → Settings → Show model`; applied live.

### Viewer markdown

`viewerMarkdown`, default `"assistant"`: how much of the [conversation viewer](#ui)'s transcript the viewer renders as Markdown rather than shows verbatim.

```text
off        every line literal, as before this setting existed
assistant  assistant text rendered; tool results verbatim and dim   (default)
all        tool results rendered too
```

Scoped rather than all-or-nothing because the two kinds of content have different contracts. Assistant text *is* Markdown — the model writes it that way, and the viewer was the only surface showing its source.

A tool result is whatever bytes the tool produced. A Markdown pass over one rewrites things that occur constantly in real output. `# section` in a shell script loses its `#`. A `---` line becomes a setext heading. The pass re-fences indented output, and it redraws `| a | b |` as a box-drawing table. Each of those reads as the *tool* having misbehaved, which is why `all` is opt-in.

The extension suppresses two rewrites outright rather than leaving them to the mode, because they change *data* rather than layout. Ordered-list markers keep their source numbering (`3) 7) 9)` stays, instead of becoming `3. 4. 5.`). The extension does not normalise backslash escapes.

Turn `all` on for tools that genuinely emit Markdown, and off again for a diff or a log. `m` in the viewer cycles the three and persists the choice, so the key and this setting are the same value. The footer shows which is in force as `m raw` / `m md` / `m md+`.

Code fences are syntax-highlighted using pi's own Markdown theme. That is also why fenced code is the one part of a result *not* dimmed under `all`. Result prose still is, so the transcript keeps its hierarchy.

Applied live. Also settable from `/agents → Settings → Viewer markdown`.

### Tool description

`toolDescriptionMode`, default `"full"`: which agent tool description the LLM sees. `"full"` is the rich prompt; `"compact"` is ~75% smaller — one-line agent type list, terse usage notes — for small/local models where tool-spec tokens are expensive. Per-option details stay in the parameter descriptions in every mode (the parameter schema is never customizable). Applies on the next pi session.

`"custom"` registers your own description from `<cwd>/.pi/agent-tool-description.md` (project) or `<agentDir>/agent-tool-description.md` (global; project wins). The extension reads the file once at tool registration, so edits also apply on the next pi session. Dynamic parts stay live via placeholders — a static agent list would go stale the moment you add a custom agent:

```markdown
Launch an autonomous agent. Available types:
{{typeList}}

Custom agents live in .pi/agents/ or {{agentDir}}/agents/.
```

Placeholders:

- `{{typeList}}`: full per-agent descriptions.
- `{{compactTypeList}}`: first sentence each.
- `{{agentDir}}`.
- `{{isolationGuideline}}`: expands with its own leading newline and a `-` bullet marker when worktree isolation is on, and is empty when [worktree isolation](#turning-worktrees-off) is off. Place them directly after your last rule line.

The extension leaves unknown placeholders verbatim and prints a stderr warning. A missing or empty file falls back to `"full"` with a warning.

Note the usual trust umbrella: a project-level file shapes the orchestrator's prompt, same as project agents and extensions do.

### Fleet view

`fleetView`, default `true`: whether the [FleetView](#fleetview) tree renders below the editor. Toggle via `/agents → Settings → Fleet view`; applied live.

### Widget

`widgetMode`, default `"all"`: which agents the above-editor widget shows. Toggle via `/agents → Settings → Widget`; applied live.

- `"all"`: every agent.
- `"background"`: hides foreground agents, which already render inline.
- `"off"`: hides the widget.

### Example — global defaults for a beefy machine

```bash
mkdir -p ~/.pi/agent
cat > ~/.pi/agent/subagents.json <<'EOF'
{
  "maxConcurrent": 16,
  "graceTurns": 10
}
EOF
```

Every project now starts with concurrency 16 and grace 10, without ever touching the menu. Individual projects can still override via `/agents` → Settings.

### Failure behavior

- Missing file: silent.
- Malformed JSON: logs a `[pi-subagents] Ignoring malformed settings at …` warning to stderr.
- Invalid or out-of-range field values: dropped per-field.
- Write failures: downgrade the `/agents` toast to a warning with `(session only; failed to persist)`.

## Events

The extension emits agent lifecycle events via `pi.events.emit()` so other extensions can react:

| Event | When | Key fields |
| --- | --- | --- |
| `subagents:created` | `agent`-tool background spawn, or a detached resume — **not** cross-extension RPC or `@handle` spawns, which are first seen at `subagents:started` | `id`, `type`, `description`, `isBackground` (always `true`) |
| `subagents:started` | Agent transitions to running (including queued→running) | `id`, `type`, `description` |
| `subagents:completed` | Agent finished successfully (background and foreground) | `id`, `type`, `description`, `status`, `durationMs`, `tokens` (display total, `{ input, output, total }` — see the note below), `usage` (the run's spend as a pi `Usage`: token components including `cacheRead`, plus `cost.total` in USD; absent when nothing was spent), `toolUses`, `result` |
| `subagents:failed` | Agent errored, stopped, or aborted (background and foreground) | identical payload to `subagents:completed` — the same formatter builds both, so `error` and `status` are present on that row too, just empty |
| `subagents:steered` | Steering message accepted — fires for a *queued* steer as well as a delivered one | `id`, `message` |
| `subagents:compacted` | Agent's session successfully compacted | `id`, `type`, `description`, `reason` (`"manual"` / `"threshold"` / `"overflow"`), `tokensBefore`, `compactionCount` |
| `subagents:ready` | RPC handlers registered and armed — fired on session start; not emitted in a session that excludes pi-subagents | `{}` (empty object) |
| `subagents:settings_loaded` | Persisted settings applied at extension init | `settings` (merged global + project), `policy` (`{ global, project, ephemeralNesting }`) |
| `subagents:settings_changed` | `/agents` → Settings mutation took effect | `settings`, `persisted` (`boolean` — `false` on write failure), `policy` (`{ global, project, ephemeralNesting }`) |

The extension emits the four agent-lifecycle events (`subagents:started`, `:completed`, `:failed`, `:compacted`) for **top-level agents only**. Nested subagents emit nothing at all; they report through the parent that owns them.

`tokens.total` = `input + output + cacheWrite`. The total excludes `cacheRead`. Each turn's `cacheRead` is the cumulative cached prefix re-read on that one API call. Summing per-message would over-count it as a measure of work. Use `contextUsage.percent` (which the widget shows as `(NN%)`) for current context size.

`usage` answers the other question: what the provider billed. It does include `cacheRead`, because the prefix really is re-read and re-charged on every call. It is a pi `Usage`, the same shape pi puts on `ToolResultEvent` and `AssistantMessage`. So `usage.cost.total` is where a listener already expects the money, and anything pi adds to `Usage` arrives without a change here. Neither field derives from the other; `tokens` is a view model, `usage` is the data.

## Cross-Extension RPC

Other pi extensions can spawn and stop subagents programmatically via the `pi.events` event bus, without importing this package directly.

All RPC replies use a standardized envelope: `{ success: true, data?: T }` on success, `{ success: false, error: string }` on failure.

**Full reference:** [`docs/rpc.md`](docs/rpc.md) covers:

- the complete spawn-option surface (including the fields that the extension silently strips)
- every error string
- the completion-notification race
- the `Symbol.for("pi-subagents:manager")` registry
- what protocol version `2` does and does not promise

### Discovery

Listen for `subagents:ready` to know when RPC handlers are available:

```typescript
pi.events.on("subagents:ready", () => {
  // RPC handlers are registered — safe to call ping/spawn/stop
});
```

`subagents:ready` fires only when pi-subagents is actually loaded **and bound** in the current session. A session that excludes it (via an agent's `extensions:`) emits no `subagents:ready` and does not answer the RPC channels. It acts exactly as if pi-subagents were not installed. Treat "no `subagents:ready`" as "not available here" and give discovery a timeout rather than waiting indefinitely.

### Ping

Check whether pi loaded the subagents extension and get the protocol version:

```typescript
const requestId = crypto.randomUUID();
const unsub = pi.events.on(`subagents:rpc:ping:reply:${requestId}`, (reply) => {
  unsub();
  if (reply.success) console.log("Protocol version:", reply.data.version, reply.data.policy);
});
pi.events.emit("subagents:rpc:ping", { requestId });
```

### Spawn

Spawn a subagent and receive its ID:

```typescript
const requestId = crypto.randomUUID();
const unsub = pi.events.on(`subagents:rpc:spawn:reply:${requestId}`, (reply) => {
  unsub();
  if (!reply.success) {
    console.error("Spawn failed:", reply.error);
  } else {
    console.log("Agent ID:", reply.data.id);
  }
});
pi.events.emit("subagents:rpc:spawn", {
  requestId,
  type: "worker",
  prompt: "Do something useful",
  options: { description: "My task", isBackground: true },
});
```

The reply is `{ id, filtered?, modelReplaced? }`. `modelReplaced` names the out-of-scope model that [Model Scope](#model-scope) replaced with the session model. It appears only after a replacement. `filtered` lists what the [capability policy](#capability-policy) removed from an agent file's values. A caller-supplied tool, extension, or skill outside the policy fails the spawn with an error that starts `Capability policy:`, and so does a malformed policy. The registry `spawn` still returns the id and throws the same errors.

`options` is the manager's spawn-option object, not the `agent` tool's parameter schema. The background flag is `isBackground`. The tool's snake_case `run_in_background` passes through verbatim and the manager ignores it.

Every RPC spawn returns its id immediately and runs detached either way. What `isBackground` does and does not change:

- `isBackground: true` makes the agent occupy one of the `maxConcurrent` slots, and queue behind them when they are full.
- Leaving it unset starts the agent immediately regardless of the limit.
- `maxConcurrentForeground` never applies here whatever `isBackground` says: it bounds only spawns where a caller blocks inline, and every RPC spawn runs detached.
- It does not affect `subagents:created`, which is never emitted for an RPC spawn at all — the first event you see for one is `subagents:started`.

A top-level RPC spawn renders in the widget and FleetView while it runs. It shows the same live tool activity and turn counter an `agent`-tool spawn gets. The widget's default `background` mode drops only an explicit `isBackground: false` spawn, the way it drops a foreground `agent` call. Nested spawns stay hidden from both.

`options.model` accepts either a `Model` object (e.g. `ctx.model`) or a `"provider/modelId"` string. The extension resolves strings against `ctx.modelRegistry` at the RPC boundary, so cross-extension callers can forward serializable values without losing auth context. Resolution is fuzzy, so a bare `"sonnet"` can land on a provider you never named.

With [Model Scope](#model-scope) on, the extension refuses an override that resolves outside `enabledModels`. The error envelope lists the allowed models, exactly as for a caller-supplied `agent({ model })`. `null` means unset: the agent inherits, same as omitting the field.

`options.agentConfig` carries the agent definition inline instead of naming a registered type. Only `systemPrompt` is required, and omitted fields default the way omitted frontmatter does. `type` then only names the run: the extension does not resolve it, and the definition never enters the registry, so the `agent` tool and `/agents` never see it. See [`docs/rpc.md`](docs/rpc.md#inline-agent-definitions).

`options.cwd` runs the agent in a different working directory than the parent session. It takes an absolute path to an existing directory — anything else returns an error envelope; `null` means unset.

- Its tools operate there and the prompt's environment block describes it.
- **`.pi` config still loads from the parent session's project.** The target directory's `.pi` extensions never execute, and its agents/skills/settings are not picked up.

Combined with `isolation: "worktree"`:

- The extension creates the worktree *from* the target directory's repo.
- The agent works at the equivalent subdirectory inside the copy (a monorepo-package cwd stays scoped to that package).
- The resulting `pi-agent-*` branch lands in that repo — the completion message names it.
- On session end, the extension prunes worktree registrations in every repo that received one. Only a hard crash can leave a stale entry (then: `git worktree prune` in the target repo).

### Stop

Stop a running agent by ID:

```typescript
const requestId = crypto.randomUUID();
const unsub = pi.events.on(`subagents:rpc:stop:reply:${requestId}`, (reply) => {
  unsub();
  if (!reply.success) console.error("Stop failed:", reply.error);
});
pi.events.emit("subagents:rpc:stop", { requestId, agentId: "agent-id-here" });
```

`abort()` itself only fires the run's `AbortController` and marks the record `"stopped"`. Releasing its pool slot, stopping any nested children, flushing its output file, and firing the completion notification happen once the run's own promise settles. For an agent wedged inside a tool call that never returns, that might be never.

A grace-period timer now forces that settle tail after a few seconds if the real one hasn't happened. A stop through this channel therefore reliably frees its slot and notifies even for a wedged agent. It no longer leaks the slot or withholds the notification forever.

The forced tail also copies the streamed response text into `record.result` when no result exists, so the notification carries partial output instead of "No output.". A responsive agent settles through its own promise well inside that window and never touches the forced path.

### Consume

Tell the extension that the model has seen an agent's result, so it does not deliver the completion notification on top of it:

```typescript
pi.events.emit("subagents:rpc:consume", { requestId: crypto.randomUUID(), agentId: "agent-id-here" });
```

This is the bus-side half of what `get_subagent_result` does when it returns a result. A caller that joins an agent on `subagents:completed` and reports the result itself should consume it. Otherwise the notification lands after the parent has already answered, and it costs a turn to dismiss.

Fire-and-forget is the intended use. The reply carries nothing to act on. The channel is outside the `subagents:rpc:ping` version handshake, so a caller can send it unconditionally. An older extension that has no handler simply keeps notifying.

The extension refuses to consume a running or unknown agent (`success: false`) and changes nothing. A running agent has no result for anyone to read, and its notification is still the caller's only signal that it finished.

Each `requestId` has its own reply channel, so concurrent requests don't interfere.

## Worktree Isolation

Set `isolation: worktree` to run an agent in a temporary git worktree:

```js
agent({ subagent_type: "refactor", prompt: "...", isolation: "worktree" })
```

The agent gets a full, isolated copy of the repository. The extension removes the worktree directory on completion either way. What differs is whether a branch stays behind:

- **No changes:** the extension cleans up the worktree automatically and leaves no branch
- **Changes made:** the extension commits changes to a new branch (`pi-agent-<id>`), and the result names the branch and the `git merge` command for it. The branch is the only artifact. The worktree path is gone, so nothing points into it
- **Agent committed its own work:** the extension creates the branch at the agent's HEAD, preserving its commits (it commits uncommitted leftovers on top first)

The agent's system prompt names the worktree as an isolated copy and tells it to work only there. This holds even if other instructions name the main checkout. Otherwise an inherited parent prompt or a task prompt mentioning the project path walks it straight back out of the copy. This is a directive, not a sandbox. An agent with shell access can still `cd` out, so don't rely on `isolation` alone to protect the main checkout.

The automatic preservation commit uses `--no-verify`, so local pre-commit hooks can't block it. The commit is local-only and never pushed, and pre-push/server-side hooks still apply.

If the extension cannot create the worktree, the `agent` call fails with a clear error instead of running unisolated. Typical causes: not a git repo, no commits, or `git worktree add` failing. `isolation: "worktree"` is a strict guarantee, not a hint. The extension reports the call as a failed tool call, not as a subagent that ran and returned that message. The model therefore doesn't retry it as if the agent had merely reported a problem. Initialize git and commit at least once, or omit `isolation`.

A worktree is a *copy*, so the agent cannot see uncommitted or staged changes in the main checkout. Never use it to review a working-tree or staged diff: the agent finds an empty `git diff` and reports nothing wrong.

### Turning worktrees off

Three levers, from narrowest to broadest:

- **Per call** — omit `isolation`, or pass `isolation: "off"`. The explicit value exists because some models fill every optional parameter that the tool offers them. With `worktree` as the only legal value they had no way to decline one (#231, #184).
- **Per agent** — `isolation: off` in an agent file. Frontmatter is authoritative, so this refuses a worktree even when the caller passes `isolation: "worktree"` — the only way to override a caller.
- **Per project** — `"worktreeIsolation": false` in `subagents.json`. Use it on a repo large enough that a copy costs real time and disk.
  - The `agent` tool's `isolation` parameter disappears from the schema entirely, along with the usage-note bullet that describes it. So it costs the model no context, and the model cannot pass it.
  - The extension refuses worktree creation on every other path too: agent files and cross-extension RPC.
  - The extension builds the schema and the description at tool registration, so they appear or disappear in the next pi session. The refusal itself takes effect immediately.

  The extension gates schema and prose together on purpose. Leaving the bullet in would teach the model to pass a field that the schema no longer declares. The extension would accept it silently, then drop it. A refused worktree carries no note on the result. The model would then have every reason to go on reporting a `pi-agent-*` branch that the extension never created. A custom tool description should use the `{{isolationGuideline}}` placeholder rather than hardcoding the bullet, for the same reason.

## Skill Preloading

You can preload skills by name and inject them into the agent's system prompt:

```yaml
---
skills: api-conventions, error-handling
---
```

**Discovery roots** (checked in this order, first match wins):

| Scope | Path | Source |
| --- | --- | --- |
| Project | `<cwd>/.pi/skills/` | Pi-standard |
| Project | `<cwd>/.agents/skills/` | [Agent Skills spec](https://agentskills.io/integrate-skills) |
| User | `$PI_CODING_AGENT_DIR/skills/` (default `~/.pi/agent/skills/`) | Pi-standard |
| User | `~/.agents/skills/` | [Agent Skills spec](https://agentskills.io/integrate-skills) |
| User | `~/.pi/skills/` | Legacy (pre-Pi) |

**Per root, a skill named `foo` resolves to the first of:**

- `<root>/foo.md` — flat file at the top level
- `<root>/foo/SKILL.md` — directory skill (top-level)
- `<root>/*/.../foo/SKILL.md` — directory skill, found by recursive descent

Recursion skips dotfile directories and `node_modules`. The extension treats a directory that itself contains a `SKILL.md` as a single skill and doesn't descend into it. Traversal sorts in byte order for deterministic resolution across filesystems.

**Security:** the extension rejects symlinks at every layer (root, flat file, skill directory, `SKILL.md` inside a skill directory). This is an intentional deviation from Pi, which follows symlinks. The extension rejects skill names with path-traversal characters (`..`, `/`, `\`, spaces, leading dot, >128 chars).

## Tool Denylist

Block specific tools from an agent even if extensions provide them:

```yaml
---
tools: read, bash, grep, write
disallowed_tools: write, edit
---
```

This is useful for creating agents that inherit extension tools but should not have write access.

## Architecture

```text
docs/                 # Long-form guides (README links out to them)
  rpc.md              # Cross-extension integration: pi.events, subagents:rpc:*, manager registry
test/                 # vitest suite; e2e/ and perf/ subdirectories
src/
  index.ts            # Extension entry: builds shared state and wires the feature modules
  types.ts            # Type definitions (AgentConfig, AgentRecord, etc.)
  lifecycle-events.ts # `subagents:*` event payload shape
  usage.ts            # Token usage shapes, accumulators, session-stats readers, withUsageReporting

  agents/             # What an agent is: definitions, registry, per-agent file edits
    custom-agents.ts  # Load user-defined agents from .pi/agents/, .agents/agents/, global agents, and skill-embedded agents
    agent-types.ts    # Unified agent registry (user and skill agents), tool name resolution
    ephemeral-agent.ts # Build the one-off agent an `agent` call with no subagent_type runs
    agent-file-toggle.ts # Locate/edit an agent's .md: enabled: toggle, eject to frontmatter

  session/            # One child session: how it is built, run, and read
    agent-runner.ts   # Session creation, execution, graceful max_turns, steer/resume
    session-text.ts   # Read response text, final-turn failure and transcript from a session
    extension-scope.ts # Extension matching, extensions:/ext: parsing, live tool-scope enforcement
    child-context.ts  # AsyncLocalStorage flag marking work done for a child session
    context.ts        # Parent conversation context for inherit_context
    prompts.ts        # Config-driven system prompt builder
    skill-loader.ts   # Preload skills (Pi-standard + Agent Skills spec layouts)
    agent-session-shutdown.ts # Graceful shutdown of a child AgentSession

  manager/            # Agent records over time: spawn, queue, settle, complete
    agent-manager.ts  # Agent lifecycle, concurrency queue, completion notifications
    agent-manager-rules.ts # Spawn eligibility and spawn input validation
    agent-spawn.ts    # Spawn records and the inline spawn contract
    agent-start.ts    # Agent startup, worktree setup, and run settlement
    agent-resume.ts   # Inline and detached agent-session resumes
    agent-retention.ts # Completed record eviction and resumable handles
    background-resume.ts # Detached resume wiring: transcript, tracking, batching, UI refresh
    group-join.ts     # Group join manager: batched completion notifications with timeout
    completion-notifier.ts # When completion nudges fire: hold window, group join, batching
    notification-format.ts # Task-notification XML and notification details
    xml.ts            # Escaping for the task-notification XML payloads

  tool/               # Model-facing tool surface: the agent tool, child tools, result rendering
    agent-tool.ts     # agent tool definition: schema, rendering hooks, execute dispatch
    agent-tool-description.ts # agent tool description text sent to the model (full, compact, custom)
    agent-tool-foreground.ts # Foreground Agent run: blocking spawn with streamed progress
    agent-tool-background.ts # Background Agent spawn: detached start, batch join, launch text
    agent-tool-resume.ts # Agent resume by ID, detached or blocking
    agent-tool-render.ts # agent tool call/result rendering and the running-status block
    agent-control-tools.ts # get_subagent_result, steer_subagent, stop_subagent tools
    agent-call-resolution.ts # agent tool params -> resolved invocation (dispatch, model, scope, details base)
    invocation-config.ts # Shared tool-parameter schemas (isolation, join, thinking, ...)
    tool-result.ts    # Tool result text shape and AgentDetails building
    ephemeral-params.ts # Schema of the seven ephemeral-agent parameters, shared by the agent tool and the nested tool
    nested-tools.ts   # Delegation tools handed to subagents (nested spawn/collect/steer)
    abortable.ts      # Race a wait against Esc without cancelling the background child
    status-note.ts    # Honest status note + salvaged partial output for non-normal outcomes
    activity-tracker.ts # Spawn callbacks that only repaint

  triggers/           # Every path that starts an agent without the agent tool
    mention.ts        # `@handle message` grammar: suggestion triggers and send parsing
    mention-input.ts  # `@handle message` input hook: steer, resume or start the named agent
    mention-clone.ts  # Run a mention's turn in a cloned conversation, off the main chat
    cross-extension-rpc.ts # RPC handlers for cross-extension spawn/ping via pi.events
    spawn-funnel.ts   # Trust boundary for programmatic spawns (RPC, mentions, registry)

  config/             # How a run is configured: settings, defaults, model choice
    settings.ts       # Persistent settings (~/.pi/agent/subagents.json + .pi/subagents.json)
    runtime-settings.ts # In-memory settings state, snapshot and settings-write toasts
    settings-paths.ts # Paths of the global and project subagents.json
    capability-policy-config.ts # Read and validate the `policy` key of the global and project subagents.json
    capability-policy.ts # checkCapabilityPolicy: match declared tools, extensions, and skills against the policy
    policy-unknown-entries.ts # Name the policy entries that match no known tool, extension, or skill
    runner-defaults.ts # Process-wide run defaults: max turns, grace turns, rememberAgents
    model-resolver.ts # Model resolution: exact provider/modelId with fuzzy fallback
    enabled-models.ts # Read pi's enabledModels settings (project over global)
    model-scope.ts    # scopeModels allowlist policy, shared by top-level and nested tools
    thinking-levels.ts # Advertised thinking levels, used by the agent tool

  platform/           # Process and filesystem facades
    env.ts            # Environment detection (git, platform)
    worktree.ts       # Git worktree isolation (create, cleanup, prune)
    output-file.ts    # Streaming output file transcripts for agent sessions

  ui/
    agent-color.ts        # Hex color parsing and badge rendering
    agent-widget.ts       # Persistent widget: spinners, activity, status icons, theming
    widget-layout.ts      # Pure widget body layout: overflow prioritization and tree-connector fix-up
    agent-format.ts       # Display helpers: token/cost/duration formatters, activity text, Theme and AgentDetails types
    agent-tree.ts         # Pure projection: records → flat pre-order rows with depth
    fleet-list.ts         # FleetView: navigable agent tree below the editor
    notification-renderer.ts # How the subagent-notification message block renders
    notification-block.ts # Pure text formatting for the notification block (stats, preview, batch total)
    conversation-viewer.ts # Live conversation overlay for viewing agent sessions
    viewer-keys.ts        # Viewer scroll keys resolved through user keybindings
    agent-mention.ts      # `@` roster (running, resumable, and startable agents) + popup rows
    select-item.ts        # Collision-safe ctx.ui.select wrapper (numbered rows)
    settings-menu.ts      # /agents → Settings menu
    agents-menu.ts        # /agents command: menu, agent lists and detail, eject/disable/enable
```

## License

MIT — see [LICENSE](LICENSE).
