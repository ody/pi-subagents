# @ody/pi-subagents

A [pi](https://pi.dev) extension that brings autonomous sub-agents to pi. Each agent runs in its own session, with its own tools, system prompt, model, and thinking level. Run agents in the background, block on them, steer them mid-run, resume them later, and define your own agent types.

## What you get

- **Four tools.** `agent` starts a run, `agent_get_result` reads it, `agent_steer` redirects it, and `agent_stop` ends it. See [The agent tools](docs/agent-tool.md).
- **Background by default.** A spawn returns an id and notifies on completion. Two concurrency pools bound background and foreground work. See [Background and foreground](docs/agent-tool.md#background-and-foreground).
- **Custom agent types.** Define agents in `.pi/agents/<name>.md`, with frontmatter for tools, extensions, skills, model, thinking level, and nesting. See [Writing agents](docs/agents.md).
- **Nested subagents.** An agent can own scoped copies of the tools for its own children, within a depth cap. See [Nested subagents](docs/agents.md#nested-subagents).
- **Agent mentions.** Type `@reviewer also check the RPC path` to message, resume, or start that agent without spending a turn in the main conversation. See [Agent mentions](docs/ui.md#agent-mentions).
- **Live UI.** An above-editor widget, a selectable row per agent, and a conversation viewer with steering and stopping. See [UI and mentions](docs/ui.md).
- **Git worktree isolation.** An agent can work in a temporary copy of the repository, and its changes land on a branch. See [Worktree isolation](docs/worktrees.md).
- **One settings file per layer.** Global and project `subagents.json` files, a capability policy, and model scope. See [Settings reference](docs/settings.md).
- **Integrations.** Lifecycle events on `pi.events`, plus five request/reply channels for other extensions. See [Integration](docs/rpc.md).

## Install

Install from git:

```bash
pi install git:github.com/ody/pi-subagents
```

Or load a local checkout:

```bash
pi install /path/to/pi-subagents
```

Or load the extension entry for development:

```bash
pi -e ./src/index.ts
```

Requires pi **1.0.0 or newer**. The `peerDependencies` range declares it, so npm flags an older pi at install time.

### Other hosts

The maintainers develop and test this extension against pi. Third-party adapters report running it elsewhere, and their authors maintain them independently. We do not test them here, CI does not cover them, and compatibility may break with any release.

## Quick start

The main agent spawns sub-agents with the `agent` tool:

```js
agent({
  subagent_type: "reviewer",
  prompt: "Find all files that handle authentication",
  description: "Find auth files",
})
```

Agents run in the background by default. The call returns an id immediately, and a completion notification carries a preview of the result. Call `agent_get_result` for the full text. Pass `run_in_background: false` to block until the agent finishes and get its output inline.

Define the `reviewer` type in `.pi/agents/reviewer.md` first, or omit `subagent_type` to run a [one-off agent](docs/agent-tool.md#ephemeral-agents) built from the call's parameters.

## Documentation

| Page | Covers |
| --- | --- |
| [docs/agent-tool.md](docs/agent-tool.md) | The four tools and their parameters, ephemeral agents, background and foreground calls, join strategies, resume, graceful turn limits, run statuses, result rendering, and transcripts |
| [docs/agents.md](docs/agents.md) | Agent files, discovery order, frontmatter fields, name and color rules, caller overrides, tool and extension scoping, nested subagents, skill preloading, the denylist, and unresolved types |
| [docs/ui.md](docs/ui.md) | The Agents widget, selection mode, the conversation viewer, agent mentions, the `/agents` menu, and completion notifications |
| [docs/settings.md](docs/settings.md) | The settings table, layer rules and precedence, the per-setting reference, the capability policy, and model scope |
| [docs/worktrees.md](docs/worktrees.md) | Isolated runs, preservation commits, cleanup failures, resume and reopen, and the ways to turn worktrees off |
| [docs/rpc.md](docs/rpc.md) | Lifecycle events, the `agent:rpc:*` channels, spawn options, error codes, protocol versions, and availability |
| [docs/decisions/](docs/decisions/) | Architecture decision records, which are the current truth for this repository |

## License

MIT, see [LICENSE](LICENSE).
