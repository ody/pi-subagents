# Writing agents

An agent file is a Markdown file with YAML frontmatter. The frontmatter `name` is the agent's type: what `subagent_type` passes, what `@handle` addresses, and what lifecycle events carry. `display_name` only changes the UI label.

## Agent files

The extension discovers agents from four locations, and the higher priority wins:

| Priority | Location | Scope |
| --- | --- | --- |
| 1 (highest) | `.pi/agents/<name>.md` | Project: pi's config dir, authoritative, and where `/agents` writes |
| 2 | `.agents/agents/<name>.md` | Project: the shared cross-tool `.agents` workspace, same convention as `.agents/skills/` |
| 3 | `$PI_CODING_AGENT_DIR/agents/<name>.md` (default `~/.pi/agent/agents/<name>.md`) | Global: available everywhere |
| 4 (lowest) | `$PI_CODING_AGENT_DIR/skills/.../<skill>/agents/<name>.md` | Skill: agents a skill ships for its own use |

Project-level agents override global ones with the same name, so you can customize a global agent for a specific project.

- If both project locations define the same name, **`.pi/agents/` wins**. `.pi` stays the project authority, and `.agents/agents/` is an additional read location for projects that keep their agent assets in the `.agents` workspace.
- The global location follows pi's `PI_CODING_AGENT_DIR` env var. Set it to relocate all pi state: agents, skills and settings.
- An agent's name is its frontmatter `name`, falling back to the filename. Two files can claim the same name. The later load wins, and the warning names the file that took over.

A skill can ship agents in an `agents/` directory next to its `SKILL.md`. The skill can then dispatch work into a clean context without asking the user to install agent files. The extension finds skills the way pi does: any directory under `$PI_CODING_AGENT_DIR/skills/` that holds a `SKILL.md`, at any depth, following symlinks.

Rules for skill agents:

- Any user location overrides a skill agent of the same name.
- Two skills shipping the same name log a warning. The skill found later wins: the walk is breadth-first, sorted by name at each level.
- `/agents` never edits a skill's file. **Eject** copies it to a user location, and **Disable** writes a user stub that shadows it. See [The `/agents` menu](ui.md#the-agents-menu).

The extension skips an unreadable or unparseable agent file instead of failing. A warning names the file and the error. If it was overriding a same-named agent, a second line names the file that loads instead. Set [`strictAgentFiles`](settings.md#strict-agent-files) to fail startup on a broken file instead.

## Example

`.pi/agents/auditor.md`:

```markdown
---
color: "#dc2626"
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

Spawn it by its name:

```js
agent({ subagent_type: "auditor", prompt: "Review the auth module", description: "Security audit" })
```

## Frontmatter fields

All fields are optional. Omitted fields take the defaults in the table.

| Field | Default | Description |
| --- | --- | --- |
| `name` | filename | **The agent's type**: what `subagent_type` and `@handle` address. See [Name and color rules](#name-and-color-rules) |
| `description` | filename | Agent description shown in tool listings |
| `display_name` | the type | Label shown in the UI (widget, agent list, badges). Cosmetic only, and independent of `name`. A file that sets only `name` badges as its type, unchanged |
| `color` | none | Background color for the agent name badge. See [Name and color rules](#name-and-color-rules) |
| `tools` | every built-in | Which tools the agent can call. Built-in names (`read, grep, …`), `*` / `all` (all built-ins), `none`, and `ext:<extension>` / `ext:<extension>/<tool>` selectors for extension tools. See [Tool and extension scoping](#tool-and-extension-scoping) |
| `extensions` | `true` | Which extensions to load. `true` (all defaults), `false` (none), or an explicit list: `[mcp, "/abs/path.ts", "*"]`. Alias: `inherit_extensions` |
| `exclude_extensions` | none | Extension denylist applied after `extensions:`. Exclude wins. Plain names only (case-insensitive), no paths or `*`. Useful with `extensions: true` to drop one extension (for example `pi-notify`) |
| `skills` | `true` | `true` inherits the parent's skills; `false` inherits none. A comma-separated list preloads **only** those skills into the system prompt and does not inherit the rest. Alias: `inherit_skills`. See [Skill preloading](#skill-preloading) |
| `disallowed_tools` | none | Comma-separated tools to deny even if extensions provide them. See [Tool denylist](#tool-denylist) |
| `isolation` | none | `worktree` runs in an isolated git worktree. `off` refuses one even when the caller passes `isolation: "worktree"`, because frontmatter is authoritative. `none`, `no` and `false` are spellings of `off`. See [Worktree isolation](worktrees.md) |
| `model` | inherit parent | Model as `provider/modelId` or shorthand (`"haiku"`, `"sonnet 4.5"`). An explicit version or snapshot date must match the model. See [Model resolution](#model-resolution) |
| `thinking` | inherit | `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`. Availability depends on your pi version and model; pi clamps unsupported levels down |
| `max_turns` | unlimited | Max agentic turns before graceful shutdown. `0` or omit for unlimited. A caller `max_turns` overrides it |
| `persist_session` | [`rememberAgents`](settings.md#remember-agents) | Persist this subagent as a normal pi session instead of keeping the session in memory only. Overrides the `rememberAgents` default in both directions. The subagent records its spawning session as parent, so it nests under it in `/resume`. Its `.output` transcript is still written either way unless `output_transcript` is `false` |
| `output_transcript` | [`outputTranscript`](settings.md#output-transcript) | Write this subagent's `.output` transcript. When set, it overrides the `outputTranscript` default. `false` writes no transcript file or path. Governs only the transcript: independent of `persist_session` and `isolation: worktree` |
| `session_dir` | pi default | Optional session directory when `persist_session: true`. Omitted uses pi's normal session location, and relative paths resolve from the agent cwd. A session outside the parent's session directory (this override, or `isolation: worktree`) appears separately in the list, so it shows as a root instead of nesting |
| `allowed_subagents` | none | Opt in to scoped nested `agent`, `agent_models`, `agent_get_result`, `agent_steer`, and `agent_stop` tools. Omitted, empty, `none` or `false` means no nesting. `all` (or `"*"` / `true`) means any enabled agent. A comma-separated list means only those types. See [Nested subagents](#nested-subagents) |
| `prompt_mode` | `replace` | `replace`: the body is the full system prompt, with no AGENTS.md or CLAUDE.md inheritance. `append`: the extension appends the body to the parent's prompt, which inherits the parent's AGENTS.md or CLAUDE.md. The extension tags a `replace` agent `(bare)` in the widget, the viewer, and the tool result |
| `inherit_context` | `false` | Fork the parent conversation into the agent |
| `run_in_background` | none | Default this agent to background (`true`) or foreground (`false`). A caller value overrides it. Omit to follow [`backgroundByDefault`](settings.md#background-by-default) |
| `isolated` | `false` | Hermetic specialist mode: forces `extensions: false` and `skills: false`, and drops `ext:` selectors. Only built-in tools. Distinct from `isolation: worktree`, which isolates the filesystem |
| `enabled` | `true` | `false` disables an agent, which is useful for hiding a skill agent per project |

## Name and color rules

`name`:

- The filename does not have to match, so `blubb.md` with `name: code-review` dispatches as `code-review`. Omit it and the extension uses the filename.
- Any value works except one containing `:`, which plugin-scoped identifiers reserve. The extension skips such a file with a warning.
- Two files may declare the same name. The later load wins, as a filename clash always did.

`color` sets the badge in the agent tool header, the widget, and the conversation viewer. The only accepted value is a quoted six-digit hex string such as `"#8B5CF6"`. Color names are not accepted.

Badge text is black or white, whichever clears 4.5:1 against the rendered background. Invalid values render no badge and preserve each surface's existing theme foreground.

## Caller overrides

The caller can override four fields of a named agent for one run: `model`, `thinking`, `max_turns`, and `run_in_background`. Precedence is the `agent` tool parameter, then frontmatter, then the default: the session model, pi's default thinking level, [`defaultMaxTurns`](settings.md#turn-limits), and [`backgroundByDefault`](settings.md#background-by-default). Nested calls default to foreground.

A caller `max_turns` of `0` means unlimited and is not re-resolved from the file. Every other field binds the agent: `inherit_context`, `isolated` and `isolation` only fill what the file leaves unspecified, and `isolation: off` still refuses a worktree.

`model` is the exception. A `model` passed to the `agent` tool takes effect even against a pin. So `model:` in an agent file means "this agent's model unless the caller says otherwise". Three consequences:

- The extension discloses the displaced pin. The widget, the tool-result header and the conversation viewer render `opus 4.6 (over pinned anthropic/claude-haiku-4-5)`.
- The tool schema does not advertise the capability. The `model` parameter tells the model to set it only when the user named one. It says nothing about pins or precedence, so it is a user-driven override rather than something the orchestrator reaches for on its own.
- A caller model that does not resolve is a hard error. The extension refuses the spawn rather than quietly demoting it to the pin. An out-of-scope caller model gets the same treatment under [Model scope](settings.md#model-scope).

## Model resolution

The extension resolves a `model:` pin and a caller `model` against the models pi reports as available, through one deterministic matcher. A blank or whitespace-only caller `model` counts as absent, so a frontmatter pin applies. `/agents → Agent types` shows the same resolved target as the override disclosure, snapshot date included.

A concrete `Model` object and a live `resume` bypass string resolution. A tombstone reopen re-resolves the pin it restores.

The matcher takes candidates in three tiers, and the first tier with a candidate wins:

1. **Literal key.** A `provider/modelId` value present in the available pool.
2. **Normalized ID.** The full ID matches after lowercasing and treating `.` and `-` as equal, or the base ID matches when the input omits a snapshot date.
3. **Whole-token shorthand.** Every whitespace or hyphen separated token appears in the ID, or in the display name. Tokens from different fields never combine. An explicit version must match the ID's complete ordered version, and an explicit trailing `-YYYYMMDD` must match the ID's snapshot date.

A qualified input scans the named provider first. It scans the full pool with the text after the first `/` only when the named provider has no eligible candidate, never on ambiguity. An empty, whitespace-only or date-only model part never matches.

Candidates at the winning tier are equivalent only when their IDs match after removing a trailing snapshot date. Distinct base IDs are ambiguous. For an undated input, an undated ID wins, then the newest snapshot, then the lexically smallest `provider/id`; pool order never decides.

With [Model scope](settings.md#model-scope) on, the exact `enabledModels` entries disambiguate the shorthand tier only. They never redirect a literal or normalized match.

A caller `model` that does not resolve refuses the spawn. A pin that does not resolve leaves the model unset, so the agent inherits the session model. `/agents → Agent types` marks that pin `(unavailable, fallback: inherit)`. A caller `model` that displaces a pin shows the resolved pin in the `(over pinned …)` disclosure.

A refusal lists the accepted models, one `provider/id` line each, sorted lexically. The accepted set is the scoped set when [Model scope](settings.md#model-scope) bounds the run, and pi's available models otherwise. [`agent_models`](agent-tool.md#agent_models) reports the same set before a spawn.

This is distinct from [Model scope](settings.md#model-scope) enforcement, which matches the `enabledModels` allowlist by *exact* entry.

## Tool and extension scoping

`extensions:` decides **which extensions load**. `tools:` decides **which tools surface to the LLM**. They compose:

```yaml
# Default (both omitted): all extensions load, every built-in surfaces

tools: read, grep, find           # narrow to listed built-ins; extensions still load
tools: "*"                        # every built-in (alias: `all`)
tools: none                       # zero built-ins (alias: `""`)
tools: "*, ext:mcp/search"        # built-ins plus one extension tool

extensions: false                 # no extensions load
extensions: [mcp]                 # only mcp loads
extensions: ["*", "/abs/foo.ts"]  # all defaults plus one path-loaded extension

exclude_extensions: pi-notify     # everything except pi-notify (with extensions: true)

# Specialist: load one extension, expose only one of its tools, keep built-ins
extensions: [mcp]
tools: "*, ext:mcp/search"

isolated: true                    # hermetic: built-ins only, no extensions, skills or context
```

Rules the examples do not make obvious:

- `extensions:` is the sole loading authority. `ext:foo` in `tools:` narrows what surfaces; it cannot load `foo` on its own. Mismatches fire `extension-error:…` warnings.
- Any `ext:` entry flips extension tools to an explicit allowlist. Unnamed extensions still load and their handlers fire, but they expose no tools. So `tools: "*, ext:mcp/search"` exposes only `search` from `mcp`, and nothing from any other extension.
- Extension names match case-insensitively (`[Mcp]` equals `[mcp]`). Tool names in `ext:foo/bar` stay case-sensitive.
- Extensions that register tools **lazily** work too. MCP-backed extensions typically cannot enumerate their tools until their servers connect, so they register from `session_start` or `before_agent_start` rather than at load. The extension re-derives subagent scoping as tools appear, so these surface normally, and `ext:` selectors keep narrowing correctly no matter when a tool shows up.
- Extensions bound into a subagent see **both ends** of that session's lifecycle. `session_start` fires when the agent starts. `session_shutdown` fires with reason `quit` when the extension disposes of its session: on quit, and when it evicts the record about ten minutes after the agent finishes. Release per-session resources there, because anything left armed outlives the session it belongs to. Handlers get three seconds on quit, after which teardown proceeds regardless.
- An installed **package** extension matches by its package short name (`@scope/pi-subagents` matches `[pi-subagents]`), in addition to its path-derived name. A package whose entry is `src/index.ts` also answers to `[src]`. Prefer the package name; the path-derived one is incidental.
- Plain `tools:` typos fail loudly: `tools: reed, grep` fires `tools-error:…` instead of silently producing an under-tooled agent.
- `exclude_extensions:` wins over `extensions:` and over `ext:` selectors. An excluded extension never loads, and a `tools: ext:` entry cannot pull it back. Plain names only, no paths and no `*`. A name matching nothing fires an `extension-error:…` warning.
- `exclude_extensions:` is **not a sandbox**. Excluded extensions' factory code still executes once during loading. Exclusion suppresses their tools and their bound lifecycle hooks, because `pi.on` handlers fire only for extensions bound to the session. It does not suppress other load-time side effects: a factory that subscribes directly to the shared `pi.events` bus stays live. Do not rely on it to contain an untrusted extension.
- Array and string forms are equivalent: `[a, b]` equals `"a, b"`.

The agent tool description lists every available agent with a `(Tools: …)` suffix, and the orchestrator reads that suffix when it decides where to route work. The suffix describes **built-in scope only**. The extension resolves extension tools when the agent runs, and cannot enumerate them when it builds the description:

| `tools:` | Suffix |
| --- | --- |
| omitted, `*`, or `all` | `*` |
| a list of built-ins | that list, for example `read, grep` |
| `none` with `isolated: true` or `extensions: false` | `none` |
| `none`, or only `ext:` entries, with extensions loading | `no built-ins, extension tools only` |

The last two rows are separate because zero built-ins is not zero tools. `tools: none` alongside `extensions:` still surfaces every extension tool, so calling it `none` would understate what the agent can do. Note that `*` does not enumerate extension tools either: an agent with `tools: "*, ext:mcp/search"` advertises `*`.

## Nested subagents

Nested delegation is default-off. Set `allowed_subagents` only on a non-isolated custom agent that owns a real fan-out responsibility:

```yaml
---
tools: read, grep, find
extensions: false
allowed_subagents: support-file-finder, support-callsite-tracer   # or `all`
---
```

`allowed_subagents` is runtime-enforced, and takes three forms:

- A comma-separated list restricts nesting to those types.
- `all` (or `"*"` / `true`, matching how `extensions:` and `skills:` take booleans) allows any enabled agent.
- Omitted, empty, `none`, or `false` means the extension injects no nested tools at all.

The extension rejects unknown, disabled, and out-of-list types, and validates a nested `model:` against [Model scope](settings.md#model-scope) exactly like a top-level spawn.

**A nested child never exceeds its parent.** The extension records the parent's effective tools, extensions and skills on its record when it builds the session. Those values already include the [capability policy](settings.md#capability-policy) and the parent's own ceiling, so the bound is transitive.

- The extension compares a child's values with the parent's using the policy's expansion rules. Wildcards, `true`, and whole-extension selectors expand and narrow, and a child's `skills: true` under a parent list narrows to that list.
- The parent's `disallowed_tools` and `exclude_extensions` apply to the child.
- The extension narrows a file value or default that exceeds the parent. It adds a warning to the user and a note in the nested tool result.
- A child's `allowed_subagents` is a subset of its parent's, and `all` only when the parent has `all`. The extension narrows a file value with a warning, and the main session counts as `all`.
- The extension refuses a nested spawn whose parent record has no recorded set.
- The same set filters extension tools that register after spawn.
- Top-level, `@handle` and RPC spawns have no parent, so only the policy bounds them.

The read-only agent above therefore cannot obtain writes through its children, but `allowed_subagents` still decides which types it may start.

Result, resume, and steering operations are ownership-scoped, so a parent can control only its own children. Nested records stay internal to that parent for every *programmatic* surface: top-level tools, lifecycle events, the [RPC channels](rpc.md), and `@handle` resolution. When a parent finishes, stops, or ends a resumed turn, the extension stops its nested children with it.

Three things survive that boundary:

- Nested agents write their own `.output` transcript, subject to the same `output_transcript` gate. The extension files it under the root session's directory alongside their ancestors', so you can still inspect a nested run after the fact.
- Their token usage folds into every ancestor's totals up to the top-level agent: lifecycle events, completion notifications, `/agents`. Nested spend therefore stays attributable at any depth.
- The extension labels a nested result that ends `stopped`, `aborted` or `steered` as partial, the same guarantee top-level results carry.

The **human** surfaces are not part of that ownership boundary. A nested child appears indented under its owner in `/agents → Agents` and, while running, in the above-editor widget. You can open, steer and stop it from any of them. Ownership scoping keeps siblings and other extensions out of each other's agents. It does not hide an agent from the person running the session.

The hard cap is [`maxSubagentDepth`](settings.md#nested-depth), which defines how depth counts and which values turn nesting off. The cap bounds how *deep* nesting goes, not how *wide*.

- An agent already at the cap gets no nested tools at all, not even `agent_get_result`, since it can never own a child.
- A child must independently set `allowed_subagents` to delegate again.
- Isolated agents never receive nested tools.

A parent's only limit on concurrent children is that each spawn costs it a turn. Pair `allowed_subagents` with a `max_turns` on that agent if you want a hard ceiling on its fan-out. See [Concurrency](settings.md#concurrency) for why nested children take no pool slot.

A subagent session never activates this extension. That keeps a child from building a second agent manager, and it is why the extension injects nested tools directly instead. A subagent therefore also gets none of the extension's other surfaces: no `/agents` command, no cross-extension RPC handlers, no `agent:ready` event.

## Skill preloading

Preload skills by name and inject them into the agent's system prompt:

```yaml
---
skills: api-conventions, error-handling
---
```

The extension checks discovery roots in this order, and the first match wins:

| Scope | Path | Source |
| --- | --- | --- |
| Project | `<cwd>/.pi/skills/` | Pi standard |
| Project | `<cwd>/.agents/skills/` | [Agent Skills spec](https://agentskills.io/integrate-skills) |
| User | `$PI_CODING_AGENT_DIR/skills/` (default `~/.pi/agent/skills/`) | Pi standard |
| User | `~/.agents/skills/` | [Agent Skills spec](https://agentskills.io/integrate-skills) |
| User | `~/.pi/skills/` | Legacy, pre-pi |

Per root, a skill named `foo` resolves to the first of:

- `<root>/foo.md`: a flat file at the top level.
- `<root>/foo/SKILL.md`: a directory skill at the top level.
- `<root>/*/.../foo/SKILL.md`: a directory skill, found by recursive descent.

Recursion skips dotfile directories and `node_modules`. The extension treats a directory that itself contains a `SKILL.md` as a single skill and does not descend into it. Traversal sorts in byte order, for deterministic resolution across filesystems.

The extension rejects symlinks at every layer: root, flat file, skill directory, and `SKILL.md` inside a skill directory. This is an intentional deviation from pi, which follows symlinks. The extension rejects skill names with path-traversal characters: `..`, `/`, `\`, spaces, a leading dot, and more than 128 characters.

## Tool denylist

Block specific tools from an agent even if extensions provide them:

```yaml
---
tools: read, bash, grep, write
disallowed_tools: write, edit
---
```

This is useful for agents that inherit extension tools but should not have write access.

## Unresolved agent types

A `subagent_type` that does not resolve to exactly one enabled agent is an error that lists the enabled types. That covers unknown, disabled, and ambiguous types, where two agents differ only by case.

- Only the `agent` tool's message suggests omitting the type to run a one-off agent.
- An empty `type` on `agent:rpc:spawn` without `agentConfig` is an error envelope.
- A stored reference to a removed type fails when the extension uses it, and the error names the type.
- The extension ignores a key for a removed setting in `subagents.json`.
