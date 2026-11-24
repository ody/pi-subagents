# AGENTS.md

pi extension providing sub-agents (`agent` tool, `/agents` menu), packaged as `@ody/pi-subagents`. TypeScript, vitest, biome.

## Decision records and backlog

- `docs/decisions/*.md` is current truth. Follow it. Ignore `docs/decisions/drafts/` unless asked to work on a draft.
- Format, drafts, and superseding: [ADR 0001](docs/decisions/0001-decision-records.md).
- Backlog: GitHub issues at `github.com/ody/pi-subagents`, driven with the GitHub MCP server (`mcp__github`). Labels: `task`, `bug`, `chore`.

## Rules index

Each entry: the rule an agent must not break, and its ADR.

- **Upstream.** Hard fork: never merge, rebase onto, cherry-pick from, or add a remote for the upstream repository. Never keep or shape code, docs, or tests for upstream or Claude Code compatibility. [ADR 0002](docs/decisions/0002-hard-fork-from-upstream.md)
- **No workflows.** Never add workflow orchestration to this repo, and never change `agent:rpc:*` channels or lifecycle events for top-level agents while removing it. [ADR 0003](docs/decisions/0003-no-workflow-orchestration.md)
- **File structure.** Split source files along cohesion seams, never to hit a number. Over 500 lines needs a `Size:` header reason, and 800 lines or 40 KB is the cap. Never create `utils.ts`, `part2.ts` or one-caller fragments, and never compress code to fit. [ADR 0004](docs/decisions/0004-source-file-structure.md)
- **Directory structure.** Every `src/` file lives in the concern directory that owns it, never in a layer or `core/`, `utils/`, `helpers/`, `misc/` or `part2/`, and `test/` bans those names too. A module test lives in the `test/` directory named for its module's `src/` group. A test of a `src/` root module and a repository test stay at the `test/` root. Any other test goes to the group it imports the most from. An end-to-end test lives in `test/e2e/`. A `src/` group and a `test/` support directory each hold two or more files. [ADR 0006](docs/decisions/0006-source-directory-structure.md)
- **Ownership.** `isTopLevelAgent` scopes programmatic control only -- model-facing tools, `@handle`, `agent:rpc:*`, lifecycle events, notifications and the concurrency pools -- never UI visibility, which shows every agent. Nested agents reach only their own children. [ADR 0007](docs/decisions/0007-agent-ownership.md)
- **Capability policy.** Every new agent session gets its tools, extensions, and skills from a `checkCapabilityPolicy` verdict, and `spawnAgent` throws without one. Never add a spawn path that skips it, and a project `policy` can only narrow the global one. [ADR 0011](docs/decisions/0011-agent-capability-policy.md), [ADR 0022](docs/decisions/0022-capability-policy-configuration.md)
- **Delegation ceiling.** A nested agent never exceeds its parent's tools, extensions, skills, or `allowed_subagents`, and never nests past `maxSubagentDepth`. [ADR 0013](docs/decisions/0013-agent-delegation-ceiling.md)
- **Ephemeral agents.** An agent call with no `subagent_type` builds an ephemeral agent that never enters the registry, and its values pass the capability policy. [ADR 0023](docs/decisions/0023-ephemeral-agents.md)
- **Bus names.** Every name the extension puts on `pi.events` or writes into a session starts with `agent:`, and no earlier name has an alias. [ADR 0043](docs/decisions/0043-agent-event-namespace.md)
- **Bus-only surface.** Other extensions and hosts reach the extension only through `agent:rpc:*`, `agent:*` events and `agent:record`. Never publish a `globalThis` object or any other side channel. [ADR 0044](docs/decisions/0044-bus-only-integration-surface.md)
- **RPC spawn options.** `agent:rpc:spawn` accepts only the keys in `RPC_SPAWN_OPTIONS`, and never adds an internal `SpawnOptions` field. [ADR 0045](docs/decisions/0045-rpc-spawn-option-allowlist.md)
- **RPC versioning.** A breaking change bumps `version` and resets `features`, an additive change appends one feature name, and every failure reply carries a `code`. [ADR 0046](docs/decisions/0046-rpc-versioning-and-error-codes.md)
- **Provider failures.** `agent:failed` carries `failure: { stage: "provider" }` only when the run's last assistant message has `stopReason: "error"`. Never classify from display text, and never add a `kind` without structured provider evidence. [ADR 0051](docs/decisions/0051-provider-stage-failures.md)
- **Tool names.** Every registered tool name is lowercase, and is `agent` or starts with `agent_`. [ADR 0042](docs/decisions/0042-tool-names.md)
- **No default agents.** Never ship an agent definition, a fallback agent, or an agent creation wizard in the extension. [ADR 0017](docs/decisions/0017-no-shipped-default-agents.md)
- **Host tools.** Text the extension injects into a model's context, including results, notifications and the append-mode bridge, never names a host tool to use. [ADR 0020](docs/decisions/0020-host-facing-text-names-no-host-tools.md)
- **Settings layers.** A menu change writes one key to the layer it shows. Never copy an inherited value into a file, and never write a file that fails to parse. [ADR 0021](docs/decisions/0021-settings-layers-and-menu.md)
- **Model scope.** With `scopeModels` on, every spawn path runs on an in-scope model, and the session model is never checked. [ADR 0024](docs/decisions/0024-model-scope-at-every-spawn.md)
- **Mentions.** Never treat input from another extension as a mention, and never fall back to a direct start after the clone's tool refuses a call. [ADR 0025](docs/decisions/0025-agent-mentions.md)
- **Background default.** The nested `agent` tool never reads `backgroundByDefault`. [ADR 0026](docs/decisions/0026-background-by-default.md)
- **Session persistence.** A nested agent never persists a session. [ADR 0027](docs/decisions/0027-remember-agents.md)
- **Agent id.** An agent's id is one uuidv7 that `spawnAgent` mints and passes as the id of the agent's pi session. Never mint a second id for an agent. [ADR 0048](docs/decisions/0048-agent-id-is-session-id.md)
- **Durable handles.** Tombstones are a function of the active branch's `agent:record` entries, no record carries over a session switch, and the extension never prunes child session files. [ADR 0049](docs/decisions/0049-durable-agent-handles.md)
- **Usage reporting.** Subagent usage reaches pi's totals only as `usage` on tool results, and only with `reportUsage` on. [ADR 0028](docs/decisions/0028-report-usage-to-session.md)
- **Worktree switch.** With `worktreeIsolation` off, no path creates a worktree, and a worktree request downgrades without refusal. [ADR 0029](docs/decisions/0029-worktree-isolation-switch.md)
- **Worktree ownership.** `src/platform/worktree.ts` owns worktree creation, preservation, and removal. Never remove Git-visible work before a branch preserves it, and never resume into a removed worktree. [ADR 0047](docs/decisions/0047-worktree-code-ownership.md)
- **Worktree reopen.** A tombstone reopen runs only after the extension verifies isolation state and worktree ownership. Unknown state, a removed worktree, a held lease, or possibly active cleanup refuses it. [ADR 0052](docs/decisions/0052-verified-worktree-reopen.md)
- **Status presentation.** Every surface takes an agent's status icon and class from the one mapping in `src/ui/agent-format.ts`, and outcome rules use the class. [ADR 0036](docs/decisions/0036-agent-status-presentation.md)
- **Agents widget.** The widget is the only widget that lists agents, draws at most 12 lines, and shows nested agents only while running. [ADR 0037](docs/decisions/0037-agents-widget.md)
- **Widget selection.** `↓` at an empty prompt selects in the Agents widget. No separate fleet list or `fleetView` setting exists. [ADR 0038](docs/decisions/0038-agents-widget-selection.md)
- **Conversation viewer.** The viewer renders with pi's own message components and has no other rendering mode. Both entry points open it through one function. [ADR 0039](docs/decisions/0039-conversation-viewer.md)
- **Viewer input.** The viewer follows the agent by default. `Esc` never stops an agent; only `x` twice does. Steer and stop work only while the agent is running or queued. [ADR 0040](docs/decisions/0040-conversation-viewer-input.md)
- **Completion notifications.** A notification carries model text and a user render separately, never the full result, and always starts a turn. [ADR 0041](docs/decisions/0041-completion-notifications.md)
- **Model override.** Model-facing text never shows an agent's configured `model` or how model values rank. Every `model` parameter says to set it only when the user named a model. [ADR 0031](docs/decisions/0031-model-override-only-when-user-names-model.md)
- **Agent fit.** Delegation text says to pass `subagent_type` only when a type's description fits the job, else build an ephemeral agent. It never says every call needs a type. [ADR 0032](docs/decisions/0032-registered-agent-only-when-it-fits.md)
- **Settle tail.** Every run that leaves `queued` or `running` settles exactly once through `settleRun`, except under `abortAll`. Never add a second settle path, and never replace a `stopped` status. [ADR 0033](docs/decisions/0033-agent-runs-settle-once.md)
- **Shutdown entry.** A shutdown writes one `stopped` `agent:record` entry per running or queued top-level agent, and a late settle of that run writes none. [ADR 0050](docs/decisions/0050-record-interrupted-agents-at-shutdown.md)
- **Stopping.** Every stop goes through `abort()` with a `stopCause`, except `abortAll`. `agent_stop` never marks a result consumed. [ADR 0034](docs/decisions/0034-stopping-an-agent.md)
- **Consumption and retention.** A completion notification never consumes a result, and only a new run clears consumption. The sweep never removes a record whose notification is pending. [ADR 0035](docs/decisions/0035-result-consumption-and-retention.md)
- **No comments.** Files under `src/` and `test/` carry no comments, only `Size:` headers, `biome-ignore` reasons and a shebang. Never add a comment, or carry its prose in a string or variable. [ADR 0010](docs/decisions/0010-no-code-comments.md)
- **Git hooks.** Pre-commit checks live in tracked `.githooks/` and stay fast. Never run the full suite in the hook, skip it with `--no-verify`, or edit git config. [ADR 0005](docs/decisions/0005-git-hooks.md)

## Commands

- Full check before finishing: `npm run check` (biome lint, `tsc --noEmit`, vitest).
- One test file: `npx vitest run test/<name>.test.ts`. Prefer this over the whole suite while iterating.
- E2E only: `npm run test:e2e`.
- Fix lint: `npm run lint:fix`.
- Try the extension from a checkout: `pi -e ./src/index.ts`.

## Code style

- Biome's formatter is off. Match the surrounding code. Biome lint is the only style enforcement.
- `test/file-size.test.ts` enforces file size, and `test/complexity.test.ts` enforces function complexity over 30. [ADR 0004](docs/decisions/0004-source-file-structure.md)
- No comments in `src/` or `test/`, except `Size:` headers, `biome-ignore` reasons and a shebang. Say it with names, types and test titles. [ADR 0010](docs/decisions/0010-no-code-comments.md)
- No `any` unless unavoidable.
- Top-level imports only. No `await import()` and no `import("pkg").Type`.
- Inline single-line helpers that have only one call site.
- Check `node_modules` for types from `@earendil-works/pi-*` and `@sinclair/typebox`. Do not guess them.
- If a type error comes from an outdated dependency, upgrade it. Do not remove or downgrade code to make it compile.
- Do not preserve backward compatibility unless asked.

## Dependencies

- Packages pi provides at runtime (`@earendil-works/pi-*`, `typebox`, `@sinclair/typebox`) go in `peerDependencies`, never `dependencies`. A copy under `dependencies` can load a second runtime module and break schema and `instanceof` checks.
- `typebox` and `@sinclair/typebox` peers use `"*"`. `@earendil-works/pi-*` peers use `>=1.0.0`.
- The pi floor is `>=1.0.0` by choice: we test nothing older. Never add shims, version gates, or comments for pi below it. Revisit when CI returns.
- Pinned copies for typecheck and tests go in `devDependencies`, at or above the floor.
- Third-party runtime packages pi does not provide stay in `dependencies`.

## Testing

- Add or update tests for the behavior you change.
- A test that loses its purpose because the code it guards is gone gets deleted, not bent to fit.
- `vitest.config.mts` inlines `@earendil-works/pi-*` so the faux-provider e2e tests share one pi-ai instance. Do not remove that setting.

## Documentation

Update the doc in the same change as the behavior.

- `README.md`: features, install, tool parameters, commands, settings and defaults, and event table. It is the source of truth for defaults and setting names.
- `docs/rpc.md`: `pi.events` lifecycle events and the `agent:rpc:*` channels. Renaming an event, channel, or reply field is a docs change.
