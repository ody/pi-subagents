# Settings reference

Runtime tuning values live in two JSON files and take effect without a restart, except where a section says otherwise. The `/agents` menu edits the same keys.

## Settings table

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
| `agentMentions` | `model` / `direct` / `off` | `model` |
| `rememberAgents` | boolean | `true` |
| `widgetMode` | `all` / `background` / `off` | `all` |
| `toolDescriptionMode` | `full` / `compact` / `custom` | `full` |

The `policy` object is not a setting row. See [Capability policy](#capability-policy).

## Settings layers

Two files, merged on load. Every key is valid in both layers.

- **Global:** `~/.pi/agent/subagents.json` — your machine-wide defaults.
- **Project:** `<cwd>/.pi/subagents.json` — per-project overrides.

`/agents` → Settings edits either file.

- The header reads `Scope: global | project`, and the footer advertises `tab scope`. `tab` switches layers at any time.
- The menu opens on the project layer when `<cwd>/.pi/subagents.json` exists, and on the global layer when it does not.
- The global layer shows the global file's value, or the default for an unset key. A change writes the global file. When the project overrides that key, the notification says the change does not reach this project.
- The project layer shows the effective value of every row, and a change writes the project file. It marks each row by source:
  - `(project)`: the project file sets the key, and the global file does not.
  - `(overrides global)`: both files set the key.
  - `(inherited)`, dimmed: the project file does not set the key.
- A change on the project layer makes that key a project override.
- `r` on a row removes that key from the layer's file. A project row then inherits, and a global row returns to the default. The running session takes the inherited value at once. `r` on a row the layer does not set does nothing, and the footer advertises it.
- `r` on a project file that holds a full snapshot removes one key at a time and leaves the rest.
- A layer file that exists and does not parse shows its parse error. That layer stays read-only until you fix the file.

A menu change writes one key to one file. It keeps every other key in that file, including unknown keys and the whole `policy`. It never writes a file that exists and does not parse, and it warns with the file name instead. After the write, the extension recomputes the effective settings from both files and applies them live.

### Precedence

Project overrides global on any field present in both. A menu change never copies an inherited global value into the project file, so a later edit to the global file still applies. A project file that already holds a full snapshot stays as it is, and every key in it is an override. Missing fields fall back to the defaults in the table above.

### Failure behaviour

- Missing file: silent.
- Malformed JSON: logs a `[pi-subagents] Ignoring malformed settings at …` warning to stderr.
- Invalid or out-of-range field values: dropped per-field.
- Write failures: downgrade the `/agents` toast to a warning with `(session only; failed to persist)`.

## Per-setting reference

### Concurrency

`maxConcurrent` and `maxConcurrentForeground` bound two independent pools. Menu rows: Max concurrency, Max foreground concurrency.

`maxConcurrent` bounds background agents. The extension queues excess agents automatically, and they start as running agents complete. The widget shows queued agents as a collapsed count. Since agents run in the background by default, nearly every spawn takes a slot. The limit is high enough that ordinary parallel fan-outs do not queue.

`maxConcurrentForeground` bounds blocking agents. Values above `0` bound them; `0` means unlimited. pi dispatches a message's tool calls through `Promise.all`, so several `agent` calls with `run_in_background: false` in one message start at once. This setting bounds that, which helps mainly with local models, where parallel agents thrash the prompt cache.

A queued foreground agent appears in `/agents → Agents` as `queued`, and you can stop it there. Its `agent` call says so while it waits and then returns its result normally.

The two are deliberately **not** one limit. A foreground agent blocks the parent anyway, and the parent could have done that work itself without paying a slot. Charging it to the background pool would therefore let a saturated pool starve the main session.

Foreground resumes count against `maxConcurrentForeground`. A foreground resume of a top-level agent takes a foreground slot and queues when the pool is full, like a foreground spawn. A *background* resume takes a background slot and queues behind other background agents. A resume uses the pool of its own call, not the pool of the agent's earlier runs.

Nested children occupy no concurrency slot, in either pool. Their parent already holds one, and queueing them behind it would deadlock a parent waiting on its own child.

### Turn limits

`defaultMaxTurns` is the ceiling for an `agent` call that passes no `max_turns` and names no agent file with its own `max_turns`. `0` means unlimited. Menu row: Default max turns. See [Graceful max turns](agent-tool.md#graceful-max-turns).

`graceTurns` is how many extra turns an agent gets to wrap up after it reaches its limit. Menu row: Grace turns. The extension reads it per run.

### Nested depth

`maxSubagentDepth` is the hard ceiling on [nested delegation](agents.md#nested-subagents), counted from the main session (main = 0, its subagents = 1). Menu row: Nested depth.

`0` or `1` disables nesting project-wide regardless of any agent's `allowed_subagents`. The extension reads it when it builds a subagent session, so a change applies to agents started after it.

### Join mode

`defaultJoinMode` picks how background completions reach the main agent. Menu row: Join mode. The modes are in [Join strategies](agent-tool.md#join-strategies).

### Background by default

`backgroundByDefault` decides what an `agent` call that omits `run_in_background` means. Menu row: Background by default; applied live. A change registers the `agent` tool again, so the `run_in_background` parameter description states the new default.

- On: the agent runs detached, the call returns its ID immediately, and a completion notification carries a preview of the result (`agent_get_result` for the full text).
- Off: an unqualified spawn blocks the turn and returns its output inline.
- An explicit `run_in_background` on the call, or in an agent file's frontmatter, overrides this in both directions. The setting only decides what "unspecified" means.
- **Top-level only.** A nested spawn (an agent spawning its own) always defaults to foreground. The extension stops a detached child when its parent settles, and the child has no notification path of its own.

### Agent mentions

`agentMentions` decides whether [`@handle message`](ui.md#agent-mentions) at the prompt addresses that subagent instead of the main model. Menu row: Agent mentions; the change applies live.

Addressing means messaging, resuming or starting an agent. The setting also decides whether `@` offers agents alongside pi's file completion.

| Value | An agent that is not running |
| --- | --- |
| `model` | An off-screen clone of this conversation starts it, via a `<system-reminder>` and a real `agent` call |
| `direct` | The extension starts it immediately, with no model call |
| `off` | Nothing: `@` means only "attach a file" again, and every `@…` prompt reaches the main model verbatim |

`model` and `direct` differ only in [who starts an agent that is not running](ui.md#starting-a-new-agent). Messaging and resuming are direct in both modes.

### Remember agents

`rememberAgents` decides whether subagents persist their pi session, which is what lets [`@handle`](ui.md#agent-mentions) reopen an agent's conversation after the extension evicts its in-memory record. Menu row: Remember agents.

Two visible consequences of the default:

- Top-level subagents write a session file.
- They nest under the session that spawned them in pi's `/resume`.

This excludes agents that another agent spawned. They get no handle, so nothing could reopen their transcript. It also excludes an inline `agent:rpc:spawn` agent, which persists only when its `agentConfig` sets `persistSession: true`. A custom agent's `persist_session` frontmatter overrides this per agent, in both directions.

With it off, handles expire with their record (roughly ten minutes past completion) and `@reviewer` then starts a fresh agent rather than resuming.

### Output transcript

`outputTranscript` is the default for writing each subagent's `.output` transcript. Menu row: Output transcript; the change applies at spawn time. Set it to `false` to make transcripts opt-in project-wide. This helps when run transcripts should not sit on disk for backup or DLP tooling to pick up.

A custom agent's `output_transcript` frontmatter overrides this per agent. This setting governs only the transcript, not `persist_session`, worktree commits, or memory files. See [Tool results and transcripts](agent-tool.md#tool-results-and-transcripts).

### Worktree isolation

`worktreeIsolation` decides whether `isolation: "worktree"` may create a worktree at all. Menu row: Worktree isolation.

With it on, an agent file's `isolation` applies on every spawn path (tool, nested tool, `@handle` mention, and RPC). A file's `isolation: off` overrides a caller's worktree request. With it off, no path creates a worktree and none refuses. Use it on a repo where a copy costs too much time or disk. See [Turning worktrees off](worktrees.md#turning-worktrees-off).

### Model scope

`scopeModels` validates each spawn's effective model against pi's `enabledModels` list. Menu row: Scope models; off means no check at all. See [Model scope](#model-scope).

### Strict agent files

`strictAgentFiles` decides what a broken [agent file](agents.md#agent-files) does at startup. Menu row: Strict agent files.

When on, an unreadable or unparseable agent file aborts extension load and names the file. Otherwise the extension skips it with a warning. A checked-in `.pi/agents/` therefore cannot silently fall through to a same-named agent from another location.

This covers startup only. The mid-session reload that runs on each `agent` call keeps warning either way: a bad edit should not kill a session on an unrelated spawn.

### Report usage to session

`reportUsage` decides whether the extension adds subagent spend to *this* session's own totals. Menu row: Report usage to session; the change applies live.

Subagents run in their own pi sessions, so by default pi's footer, statusline and `/cost` count only what the main model spent. A session that delegated most of its work reads as nearly free. With it on, each `agent` / `agent_get_result` / `agent_steer` / `agent_stop` result carries the spend accumulated since the last one, and pi folds it into `getSessionStats()`. `/cost` attributes it to the **Tools/summaries** bucket.

Three things to know about the numbers:

- The extension reports every token component, `cacheRead` included. The cached prefix genuinely is re-read and re-billed on every call. pi counts it the same way for the session's own messages. Withholding it would make a subagent's rows count differently from every other row in one total. The extension's *own* token displays still leave it out: there it inflates a reading of how much work the agent did.
- Cost is pi's own per-message figure, priced from the model's listed rates. A model pi has no rates for contributes zero rather than an estimate.
- The context-window percentage does not change. pi derives it from assistant messages alone, so a delegating session's context does not appear to fill up faster.

Agents that finish in the background have no tool result of their own to ride on, so the next call you make carries their spend. The footer catches up on the following call, not the moment they finish.

### Show cost

`showCost` decides whether the subagent surfaces print an estimated cost beside their token counts. Menu row: Show cost; applied live. The surfaces are the widget (running *and* finished lines), the conversation viewer, foreground results, `agent_get_result`, and completion notifications.

```text
├─ ⠹ reviewer  inspect code · ↻3 · 8.2k token · ~$0.0042 · 4.1s
✓ reviewer  inspect code · ↻8 · 5 tool uses · ~$0.0181 · 12.3s
```

When several background agents finish together, the extension tops their notification with the batch total (`3 agents · 45.1k token · ~$0.042`). You do not have to add the figures up by hand.

The `~` marks it as pi's estimate rather than a billed figure. **The extension shows a cost only when there is one to show.** A model pi has no pricing data for reports zero, and `$0.00` beside its tokens would say that someone measured the run and found it free. So the extension prints nothing at all, on every surface.

For the same reason a real cost too small to render reads `<$0.0001`. Figures keep cents at minimum and four decimals at most (`~$0.0042`, `~$0.05`, `~$1.24`). Rounding everything to cents would print the same number for runs that differed fourfold.

This setting is independent of `reportUsage`: this one is what you read, that one is what your session counts.

### Show model

`showModel` decides whether the widget's running rows name the model driving each agent and the thinking level it runs at. Menu row: Show model; applied live.

```text
├─ ⠹ reviewer  inspect code · sonnet 4.6 · thinking: high · ↻3 · 8.2k token · 4.1s
```

It is off by default because the row already carries the description, turns, tool uses, tokens and elapsed time. Every character it gains is one the description loses on a narrow terminal. The other surfaces show the pair either way. The `agent` tool result names the model beside its tags, and the conversation viewer's `↳` row spells out the canonical `provider/model-id`.

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

### Widget

`widgetMode` decides which agents the above-editor widget shows. Menu row: Widget; applied live. See [Agents widget](ui.md#agents-widget).

### Tool description

`toolDescriptionMode` decides which `agent` tool description the LLM sees. Menu row: Tool description. It applies on the next pi session. Per-option details stay in the parameter descriptions in every mode; the parameter schema is never customizable.

| Value | Description |
| --- | --- |
| `full` | The rich prompt |
| `compact` | ~75% smaller: a one-line agent type list and terse usage notes, for small or local models where tool-spec tokens are expensive |
| `custom` | Your own description from `<cwd>/.pi/agent-tool-description.md` (project) or `<agentDir>/agent-tool-description.md` (global; project wins) |

`custom` reads the file once at tool registration, so edits also apply on the next pi session. Dynamic parts stay live via placeholders, because a static agent list would go stale the moment you add a custom agent:

```markdown
Launch an autonomous agent. Available types:
{{typeList}}

Custom agents live in .pi/agents/ or {{agentDir}}/agents/.
```

| Placeholder | Expands to |
| --- | --- |
| `{{typeList}}` | Full per-agent descriptions |
| `{{compactTypeList}}` | The first sentence of each |
| `{{agentDir}}` | The global pi agent directory |
| `{{isolationGuideline}}` | The worktree usage bullet, with its own leading newline and `-` marker, when worktree isolation is on; empty when it is off. Place it directly after your last rule line |

The extension leaves unknown placeholders verbatim and prints a stderr warning. A missing or empty file falls back to `full` with a warning.

A project-level file shapes the orchestrator's prompt, under the same trust umbrella as project agents and extensions.

## Capability policy

An optional `policy` object in `subagents.json` bounds the tools, extensions, and skills of new agents. `/agents` edits one key of it, `ephemeralNesting`. You edit the `allow` and `deny` lists by hand.

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
- The check runs at the `agent` tool, the nested tool, `@handle` starts and tombstone reopens, and `agent:rpc:spawn`. Resuming a live agent is not re-checked.
- A filtered value notifies the user and adds a note to the `agent` tool result. The extension stores it on the agent's record and shows it in the conversation viewer.
- The extension narrows `skills: true` through the skill loader, and filters named skills before it preloads them. The same scope filters extension tools that register after spawn.
- A denied extension still runs its factory once at load, and a denied skill's `SKILL.md` stays readable through `read` or `bash`. The policy removes tools and bound hooks, not file access.
- The extension reads the policy at each spawn, so an edit applies without a restart.
- A wrong type or shape, `*` in a deny list, an unknown key, or a `subagents.json` that does not parse is a malformed policy. The extension denies every spawn, and a warning names the file and entry. A well-formed entry that names no built-in tool, discovered extension, or discovered skill only warns, as a warning toast once per agent start. The spawn proceeds. Skills come from pi's full resource discovery: the default skill directories, `settings.json` skill paths, and installed packages. Discovery runs only when the policy has a skill entry.
- A change from `/agents → Settings` keeps the `policy` of the file it writes. It refuses, with a warning, when that file exists and does not parse.
- The `Ephemeral nesting` row appears in both layers and writes `policy.ephemeralNesting` only. It leaves every other part of `policy` as it was, and `r` removes the key.
- The row shows the effective value. On the project layer it refuses to turn on while the global file has it off, because a project can only narrow.
- A change fires `agent:settings_changed` with the `policy` payload. The event carries `policy: { global, project, ephemeralNesting }` (plus `malformed`, a list of problems, when the policy fails to parse). See [Settings events](rpc.md#settings-events).

## Model scope

`scopeModels` is off by default. Enable it via `/agents → Settings → Scope models`.

When on, the extension validates each subagent spawn's effective model against pi's own `enabledModels` list (which you configure via pi's `/scoped-models` UI). pi-subagents reads that list; it does not manage it. The extension honors both of pi's settings files: global `~/.pi/agent/settings.json` and project-local `<cwd>/.pi/settings.json`. **Project overrides global**, mirroring pi's `SettingsManager` deep-merge, so the extension respects a tighter per-project scope.

The exact entries also help [model resolution](agents.md#model-resolution) decide a shorthand. If only one in-scope candidate matches a shorthand pin or caller model, it wins. The entries never redirect a literal or normalized match. A blank caller `model` counts as absent, so a frontmatter pin applies.

Every refusal lists the accepted set, one `provider/id` line each, sorted lexically. The accepted set is the models in scope when the check bounds the run, and pi's full available catalog otherwise. [`agent_models`](agent-tool.md#agent_models) reports the same set without a spawn.

The check runs after resolution, and an out-of-scope result never retries another candidate. Out-of-scope handling depends on source:

| Model source | Out-of-scope behaviour |
| --- | --- |
| Caller-supplied via `agent({ model: "..." })` | Hard error returned to the orchestrator, listing the accepted models |
| Caller-supplied via cross-extension RPC (`agent:rpc:spawn`) | Hard error returned to the calling extension, listing the accepted models |
| Pinned in agent frontmatter, with no caller `model` | Warning toast and the session model runs instead; the `agent` tool result carries a note |
| Session model (nothing pinned, or the pin does not resolve) | Never checked; the session model runs |
| `agent({ resume })` of a live agent | Never checked; the agent keeps its session and model |

The check runs on every path that starts an agent:

- The `agent` tool and the nested `agent` tool.
- `@handle` mentions, including the clone fallback and tombstone reopens.
- `agent:rpc:spawn`.

`scopeModels` is a guardrail against the orchestrator picking unexpected models at runtime, not a hard policy against user-level config. A frontmatter pin outside the scope gives way to the session model, with a visible warning. The extension hard-checks a caller-supplied `model` whether or not the agent file pins one. Winning the precedence contest against a pin does not buy it a replacement instead of an error.

Nested spawns apply the same table against the parent's config root. The hard-error and replacement cases are identical, including the toast and the result note.

The extension honors only exact `provider/modelId` entries (for example `anthropic/claude-haiku-4-5-20251001`). It silently drops glob patterns (`*sonnet*`), bare model IDs, and `:thinking` suffixes, which pi itself supports. pi's `/scoped-models` picker writes exact entries, so the limitation is invisible if you configure scope through the UI. Hand-edited globs produce an empty allowed set, and the scope check becomes a no-op.

If `enabledModels` is missing or empty in pi's settings, the scope check skips entirely: no false positives, no spurious errors.

## Example: global defaults for a beefy machine

```bash
mkdir -p ~/.pi/agent
cat > ~/.pi/agent/subagents.json <<'EOF'
{
  "maxConcurrent": 16,
  "graceTurns": 10
}
EOF
```

Every project now starts with those values, without ever touching the menu. Individual projects can still override them via `/agents` → Settings.
