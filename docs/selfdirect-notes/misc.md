# Notes: cluster misc (#81, #85, #86, #87, #88)

## Decisions

- **#81 where the warning fires.** `runAgent` emits it as a `policy-warning:` tool activity, once per agent start. No other path has the discovered extensions.
- **#81 known sets.** Known tools: built-ins, the four subagent tools, and tools of discovered extensions. Extensions come from the loader's `extensionsOverride`, which `runAgent` wraps only when a policy entry exists. Skills come from pi's default skill directories.
- **#81 cost.** Discovery runs only when the policy has at least one entry. Extension and extension-tool entries are not judged when `extensions: false` loads nothing.
- **#85 description.** The extension fixes the `run_in_background` description at registration from the loaded setting. A live menu change shows after restart, like `toolDescriptionMode`.
- **#86 driving the setter.** The test uses the real `/agents` command and a fake `ctx.ui.custom`. No other code path calls `setReportUsageFlag`.
- **#87 funnel.** A new `resolveIsolation` in `src/tool/invocation-config.ts` serves both the tool resolver and the funnel. The funnel applies a file's `isolation` over a caller's value and downgrades when the switch is off.
- **#87 mention resume.** A mention resume also applies the file's `isolation: worktree`, because the resume goes through `spawnResolved`.
- **#88.** The mention paragraph in the README now describes the clone's `<system-reminder>`. The `agentMentionReminder` text stays the same.

## Unresolved

- `npm run lint` fails on `src/tool/agent-tool-resume.ts:22` (complexity 18, max 15). The error predates these commits and sits outside this cluster.
- A skill that comes only from a pi package is not in the default skill directories. A policy entry naming it gets a false warning.
- No test drives `subagents:rpc:spawn` end to end for the worktree switch. RPC and registry share `spawnTopLevel`, which the funnel tests cover.
