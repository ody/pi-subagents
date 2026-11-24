# @ody/pi-subagents

A [pi](https://pi.dev) extension that lets the main agent hand work to sub-agents. Each sub-agent runs in its own session, with its own tools, model, and system prompt. Your main conversation stays small.

## Install

```bash
pi install git:github.com/ody/pi-subagents
```

This extension needs pi 1.0.0 or newer. To try a local checkout without installing, run `pi -e ./src/index.ts` from the repository.

## Run your first agent

Ask pi in plain words:

```text
Use a sub-agent to find every file that handles authentication and summarize what each one does.
```

The main agent calls the `agent` tool. With no `subagent_type`, the call builds a one-off agent from its own parameters, so you need no file:

```js
agent({
  prompt: "Find every file that handles authentication and summarize each one",
  description: "Find auth files",
})
```

Here is what you see:

- **While it runs.** An Agents widget above the editor shows the run, with its tool uses and token count. Press `↓` at an empty prompt to select a row.
- **When it ends.** The run goes to the background by default. A notification shows a preview of the result, and the main agent reads the full text with `agent_get_result`.
- **To watch or steer.** Type `/agents` and select the run to open its conversation. `Enter` steers it, and pressing `x` twice stops it.

### Make a reusable agent

Save a Markdown file as `.pi/agents/auditor.md`:

```markdown
---
description: Security reviewer
tools: read, grep, find
---

You are a security auditor. Report findings with file paths, line numbers, and severity.
```

The main agent starts it with `subagent_type: "auditor"`. You can also type `@auditor check the auth module` in the prompt. See [Writing agents](docs/agents.md) for every field.

## How this extension thinks about sub-agents

- **You write the agents.** The extension ships no agent definitions and no default agent. Every type comes from a file you own.
- **Use a type only when it fits.** A call that names no type builds a one-off agent. The main agent picks a registered type only when its description matches the job.
- **Delegation stays inside what the owner holds.** A sub-agent never gets more tools, extensions, or skills than its parent. Nesting stays off until an agent's `allowed_subagents` allows it, and a depth setting limits it.
- **Settings can only narrow.** A capability policy limits every agent session. A project policy narrows the global one, and never widens it.
- **Ownership limits control, not visibility.** The main agent steers and stops only the agents it started. You see every agent in the UI, nested ones included.
- **Background is the default.** A run detaches and notifies you when it ends. Use `run_in_background: false` when the next step needs the answer.
- **Nothing orchestrates for you.** There is no workflow engine. The main agent decides what to delegate and when, and other extensions integrate over the event bus only.
- **A run settles once.** Every run ends in one final status, and a stopped run records who stopped it.

The decision records in [docs/decisions/](docs/decisions/) hold the reasoning and are the current truth for this repository.

## Go deeper

| You want to | Read |
| --- | --- |
| Know every `agent` parameter, join mode, resume rule, or run status | [The agent tools](docs/agent-tool.md) |
| Write an agent file, scope its tools, nest agents, or preload skills | [Writing agents](docs/agents.md) |
| Use the widget, the conversation viewer, `@mentions`, or the `/agents` menu | [UI and mentions](docs/ui.md) |
| Change a default, set a capability policy, or limit models | [Settings reference](docs/settings.md) |
| Run agents in isolated git worktrees | [Worktree isolation](docs/worktrees.md) |
| Connect another extension through events or `agent:rpc:*` channels | [Integration](docs/rpc.md) |

## License

MIT, see [LICENSE](LICENSE).
