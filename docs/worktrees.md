# Worktree isolation

Set `isolation: worktree` to run an agent in a temporary git worktree:

```js
agent({ subagent_type: "refactor", prompt: "...", isolation: "worktree" })
```

The agent gets a full, isolated copy of the repository. The extension removes the worktree directory on completion, unless preserving the work fails. What differs is whether a branch stays behind:

- **No changes:** the extension cleans up the worktree and leaves no branch.
- **Changes made:** the extension commits them to a new branch (`pi-agent-<id>`), and the result names the branch and the `git merge` command for it. The branch is the only artifact; the worktree path is gone, so nothing points into it.
- **Agent committed its own work:** the extension creates the branch at the agent's HEAD and preserves its commits, after committing uncommitted leftovers on top.

The cleanup outcome reaches the record on every ending: a completed run, a failed run, and a stopped run. Each one gains the branch, the failure, or the worktree path in `record.result`. A forced stop reports the worktree state at stop time. When the run ends later, the extension appends the cleanup outcome to `record.result` and sends no second notification.

The agent's system prompt names the worktree as an isolated copy and tells it to work only there. This holds even if other instructions name the main checkout. Otherwise an inherited parent prompt, or a task prompt that mentions the project path, walks it straight back out of the copy. This is a directive, not a sandbox. An agent with shell access can still `cd` out, so do not rely on `isolation` alone to protect the main checkout.

A worktree is a *copy*, so the agent cannot see uncommitted or staged changes in the main checkout. Never use it to review a working-tree or staged diff: the agent finds an empty `git diff` and reports nothing wrong.

## Commits and preservation

The automatic preservation commit uses `--no-verify` and `--no-gpg-sign`, so local hooks and signing config (a missing agent, for example) cannot block it. Git creates the commit without a signature and without hooks. Re-sign it before you push. The commit is local-only and never pushed, and pre-push and server-side hooks still apply.

Preservation covers tracked edits and untracked files that `.gitignore` does not match. Ignored files never reach the branch, and they are disposable: a successful removal deletes them with the worktree. An agent that writes only ignored output leaves no branch.

## Failures

If the commit or the branch step fails, the extension keeps the worktree on disk. The result reports the git error and the worktree path, and never reports "no changes".

Cleanup refuses an attached worktree or a HEAD that does not descend from the saved base. It leaves the worktree and its lease on disk for manual recovery.

An unexpected cleanup exception does the same. The result carries `hasChanges: true`, the worktree path, and the error, so a lost worktree is never reported as clean.

A worktree path that is gone before cleanup produces an unknown-changes outcome. The result names the path and says it no longer exists, so its change state is unknown. It never reports "no changes", and the extension creates no branch.

A worktree that survives `git worktree remove` produces a removal error. The result names the path and the git error. A branch saved before removal stays in the outcome, so one result can name both the branch and the removal failure. A clean worktree that stays behind keeps `hasChanges: false` and gains only the path and the error.

The extension removes a worktree in two cases only. Either a branch points at the agent's work, or the worktree has no changes and HEAD equals the base.

If the extension cannot create the worktree, the `agent` call fails with a clear error instead of running unisolated. Typical causes are a directory that is not a git repository, a repository with no commits, or a failing `git worktree add`.

`isolation: "worktree"` is a strict guarantee, not a hint. The extension reports the call as a failed tool call, not as a subagent that ran and returned that message. The model therefore does not retry it as if the agent had merely reported a problem. Initialize git and commit at least once, or omit `isolation`.

## Resume and reopen

A retained worktree supports a resume. A persisted isolated run stores its worktree path, branch, base commit, ownership token, repo path, and working directory in its `agent:record` entry. A later `@handle` reopen runs in that same worktree and uses the same cleanup lifecycle.

Git locks each agent worktree with its ownership token and cleanup state. An exclusive lease prevents another pi process from using the same worktree. The extension refuses a resume once removal succeeded, and leaves the prior result and its worktree note intact.

A permitted resume keeps that path and uses the same cleanup lifecycle. Its cleanup saves or removes the worktree again, and writes that outcome to the result. A resumed run can then resume again only if its own cleanup keeps the path.

The reopen refuses an entry with a missing or mismatched lock. It also refuses a missing worktree, unknown isolation state, or cleanup that may not have finished. No refusal runs the conversation in the parent checkout.

A crash can leave the lease behind. After confirming that no process or tool still uses the worktree, remove the lease file named in the refusal. The extension never removes a stale lease automatically.

## Turning worktrees off

Three levers, from narrowest to broadest:

- **Per call:** omit `isolation`, or pass `isolation: "off"`. The explicit value exists because some models fill every optional parameter the tool offers. With `worktree` as the only legal value, they had no way to decline one.
- **Per agent:** `isolation: off` in an [agent file](agents.md#frontmatter-fields). Frontmatter is authoritative, so this refuses a worktree even when the caller passes `isolation: "worktree"`. It is the only way to override a caller.
- **Per project:** [`"worktreeIsolation": false`](settings.md#worktree-isolation) in `subagents.json`. Use it on a repo large enough that a copy costs real time and disk.

With worktree isolation off project-wide:

- The `agent` tool's `isolation` parameter disappears from the schema entirely, along with the usage-note bullet that describes it. It costs the model no context, and the model cannot pass it.
- The extension refuses worktree creation on every other path too: agent files and cross-extension RPC. It downgrades a request to a normal run rather than failing the call, and adds no note to the result.
- The extension builds the schema and the description at tool registration, so they appear or disappear in the next pi session. The refusal itself takes effect immediately.

The extension gates schema and prose together on purpose. Leaving the bullet in would teach the model to pass a field that the schema no longer declares. The extension would accept it silently and then drop it. A refused worktree carries no note on the result. The model would then have every reason to go on reporting a `pi-agent-*` branch that the extension never created.

A custom tool description should use the `{{isolationGuideline}}` placeholder rather than hardcoding the bullet, for the same reason. See [Tool description](settings.md#tool-description).
