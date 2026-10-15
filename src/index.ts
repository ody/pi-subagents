/**
 * pi-agents — A pi extension providing Claude Code-style autonomous sub-agents.
 *
 * Tools:
 *   Agent             — LLM-callable: spawn a sub-agent
 *   get_subagent_result  — LLM-callable: check background agent status/result
 *   steer_subagent       — LLM-callable: send a steering message to a running agent
 *
 * Commands:
 *   /agents                 — Interactive agent management menu
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { defineTool, type ExtensionAPI, type ExtensionCommandContext, type ExtensionContext, getAgentDir } from "@earendil-works/pi-coding-agent";
import { Container, Text } from "@earendil-works/pi-tui";
import { Type } from "@sinclair/typebox";
import { createActivityTracker } from "./activity-tracker.js";
import { hasAgentBadge, renderAgentName } from "./agent-color.js";
import { registerAgentControlTools } from "./agent-control-tools.js";
import { AgentManager } from "./agent-manager.js";
import { isTopLevelAgent } from "./agent-manager-rules.js";
import { BUILTIN_TOOL_NAMES, getAgentConfig, getAvailableTypes, getConfig, registerAgents, resolveSpawnType, resolveType, setDefaultsDisabled, setFallbackSubagent } from "./agent-types.js";
import { createBackgroundResume } from "./background-resume.js";
import { inChildSessionContext } from "./child-context.js";
import { CompletionNotifier } from "./completion-notifier.js";
import { type RpcHandle, registerRpcHandlers } from "./cross-extension-rpc.js";
import { loadCustomAgents } from "./custom-agents.js";
import { SUBAGENT_TOOL_NAMES } from "./extension-scope.js";
import { isolationParam, resolveAgentInvocationConfig, resolveJoinMode } from "./invocation-config.js";
import { buildEventData } from "./lifecycle-events.js";
import { describeMention, handleBase, isReservedHandle, parseMention, resolveHandleToType, stripAgentPrefix } from "./mention.js";
import { runMentionClone } from "./mention-clone.js";
import { describeModel, getModelLabelFromConfig, resolveModel } from "./model-resolver.js";
import { checkModelScope, setScopeModelsEnabled } from "./model-scope.js";
import { setMaxSubagentDepth } from "./nested-tools.js";
import { createOutputFilePath, getOutputTranscriptDefault, setOutputTranscriptDefault, streamToOutputFile, writeInitialEntry } from "./output-file.js";
import { getDefaultMaxTurns, normalizeMaxTurns, setDefaultMaxTurns, setGraceTurns, setRememberAgents } from "./runner-defaults.js";
import { createSettingsPersistence } from "./runtime-settings.js";
import { SubagentScheduler } from "./schedule.js";
import { resolveStorePath, ScheduleStore } from "./schedule-store.js";
import { applyAndEmitLoaded, loadSettings, type SettingsAppliers, type ToolDescriptionMode } from "./settings.js";
import { createSpawnFunnel } from "./spawn-funnel.js";
import { getForegroundOutcomeNote, partialOutputSuffix } from "./status-note.js";
import { THINKING_LEVELS } from "./thinking-levels.js";
import { buildDetails, formatLifetimeTokens, textResult } from "./tool-result.js";
import { type AgentActivity, type AgentConfig, type AgentInvocation, type AgentMentionMode, type AgentRecord, type JoinMode, type SubagentType, type ViewerMarkdownMode, type WidgetMode } from "./types.js";
import { createMentionProvider, mentionRoster, type TypeInfo } from "./ui/agent-mention.js";
import {
  type AgentDetails,
  AgentWidget,
  buildInvocationTags,
  describeActivity,
  fgPreservingNestedStyles,
  formatCost,
  formatMs,
  formatTurns,
  getDisplayName,
  getPromptModeLabel,
  SPINNER,
  type Theme,
  type UICtx,
} from "./ui/agent-widget.js";
import { registerAgentsCommand } from "./ui/agents-menu.js";
import { showCreateWizard } from "./ui/create-agent-wizard.js";
import { FleetList, type FleetUICtx } from "./ui/fleet-list.js";
import { registerNotificationRenderer } from "./ui/notification-renderer.js";
import { showSettings } from "./ui/settings-menu.js";
import { getLifetimeCost, PendingUsagePool, withUsageReporting } from "./usage.js";
import { isWorktreeIsolationEnabled, setWorktreeIsolationEnabled } from "./worktree.js";

// ---- Shared helpers ----

export function renderRunningAgentStatus(
  frame: string,
  statsText: string,
  activity: string,
  theme: Pick<Theme, "fg">,
): Container {
  const container = new Container();
  container.addChild(new Text(theme.fg("accent", frame) + (statsText ? " " + statsText : ""), 0, 0));
  container.addChild(new Text(theme.fg("dim", `  ⎿  ${activity}`), 0, 0));
  return container;
}

/**
 * Format an agent's tool scope for the Agent tool description.
 *
 * This suffix describes BUILT-IN scope only — extension tools are resolved when
 * the agent runs (extensions can register asynchronously), so they cannot be
 * enumerated while the description is being built. That is why an agent with
 * `tools: "*, ext:mcp/search"` renders "*" and always has.
 *
 * Two distinctions matter, both of them capability claims the orchestrator acts on:
 *
 * - absent vs empty. `builtinToolNames: undefined` means the agent never narrowed
 *   its tools (the shipped defaults); `[]` is what `tools: none` and an `ext:`-only
 *   `tools:` parse to, and the runtime really does hand those agents no built-ins.
 *   Rendering both "*" tells the orchestrator a tool-less agent can run `bash`.
 * - empty-with-extensions vs empty-without. Zero built-ins does NOT imply zero
 *   tools: `tools: none` alongside `extensions:` still surfaces every extension
 *   tool (see test/fixtures/.pi/agents/tools-none.md, which expects three). Calling
 *   that "none" understates the agent instead of overstating it — better, but still
 *   wrong, and it would route work away from the only agent able to do it. "none"
 *   is therefore reserved for agents that genuinely can call nothing: `isolated`
 *   agents and those with `extensions: false`.
 */
export function formatToolsSuffix(cfg: AgentConfig | undefined): string {
  const tools = cfg?.builtinToolNames;
  if (!tools) return "*";
  if (tools.length === 0) {
    // `isolated` overrides extensions to false in the runner, so both mean the
    // agent has no extension tools either — and then it truly has nothing.
    const noExtensionTools = cfg?.isolated === true || cfg?.extensions === false;
    return noExtensionTools ? "none" : "no built-ins, extension tools only";
  }
  const isFullSet =
    tools.length === BUILTIN_TOOL_NAMES.length
    && BUILTIN_TOOL_NAMES.every((t) => tools.includes(t));
  return isFullSet ? "*" : tools.join(", ");
}

export default function (pi: ExtensionAPI) {
  // Child AgentSessions load normal extensions. Re-entering this extension there
  // would create another manager and leak handlers. Nested orchestration is
  // injected as scoped custom tools by the existing manager instead.
  if (inChildSessionContext()) return;

  // Read directly rather than waiting for applyAndEmitLoaded below: this decides
  // the initial load, which happens hundreds of lines before settings are applied.
  let strictAgentFiles = loadSettings(process.cwd()).strictAgentFiles === true;

  /** Reload agents from project/global custom agent dirs and merge with defaults (called on init and each Agent invocation). */
  const reloadCustomAgents = (strict = false) => {
    const userAgents = loadCustomAgents(process.cwd(), strict);
    registerAgents(userAgents);
  };

  // Initial load — the only strict one. A bad edit mid-session must not kill the
  // session on the next unrelated spawn, so every later reload keeps warning.
  reloadCustomAgents(strictAgentFiles);

  // ---- Widget ----

  // ---- Usage reporting (both off by default; see SubagentsSettings) ----
  const settings = createRuntimeSettings();
  const setReportUsage = (b: boolean): void => { settings.setReportUsageFlag(b); };
  const isShowCostEnabled = () => settings.showCost;
  const setShowCost = (b: boolean): void => { settings.setShowCostFlag(b); };
  const isShowModelEnabled = () => settings.showModel;
  const setShowModel = (b: boolean): void => { settings.setShowModelFlag(b); };
  const getViewerMarkdown = () => settings.viewerMarkdown;
  const setViewerMarkdown = (m: ViewerMarkdownMode): void => { settings.setViewerMarkdownMode(m); };
  /**
   * The viewer's `m` key, from either entry point: set the mode and persist it,
   * so the key and `/agents → Settings` stay one setting rather than one per
   * entry point. `ctx` carries only the warning a failed write notifies with,
   * and the fleet list may be acting without one.
   */
  function chooseViewerMarkdown(mode: ViewerMarkdownMode, ctx?: ExtensionCommandContext): void {
    setViewerMarkdown(mode);
    settingsPersist.persist(ctx, `Viewer markdown set to ${mode}`);
  }
  const pendingUsage = new PendingUsagePool();

  // ---- Register custom notification renderer ----
  registerNotificationRenderer(pi, { settings });

  const manager = new AgentManager((record) => {
    // Owned (nested) children report only through their owner: the parent's
    // scoped tools. Keep them out of top-level lifecycle, transcript,
    // notification, and UI channels.
    if (!isTopLevelAgent(record)) return;

    // Emit lifecycle event based on terminal status
    const isError = record.status === "error" || record.status === "stopped" || record.status === "aborted";
    const eventData = buildEventData(record);
    if (isError) {
      pi.events.emit("subagents:failed", eventData);
    } else {
      pi.events.emit("subagents:completed", eventData);
    }

    // Persist final record for cross-extension history reconstruction
    pi.appendEntry("subagents:record", {
      id: record.id, type: record.type, description: record.description,
      status: record.status, result: record.result, error: record.error,
      startedAt: record.startedAt, completedAt: record.completedAt,
    });

    notifier.onAgentComplete(record);
  }, undefined, (record) => {
    if (!isTopLevelAgent(record)) return;
    // Agent-tool spawns refresh these surfaces in their tool handler, but RPC
    // and scheduler spawns enter through the manager directly.
    if (currentCtx?.hasUI) {
      widget.ensureTimer();
      widget.update();
      fleet.ensureTimer();
      fleet.update();
    }
    // Emit started event when agent transitions to running (including from queue)
    pi.events.emit("subagents:started", {
      id: record.id,
      type: record.type,
      description: record.description,
    });
  }, (record, info) => {
    if (!isTopLevelAgent(record)) return;
    // Emit compacted event when agent's session compacts (preserves count on record).
    pi.events.emit("subagents:compacted", {
      id: record.id,
      type: record.type,
      description: record.description,
      reason: info.reason,
      tokensBefore: info.tokensBefore,
      compactionCount: record.compactionCount,
    });
  }, (_record, usage) => {
    // Every assistant message from every agent — nested included, exactly once.
    // Parked here until a tool result can carry it back to the parent session;
    // see `PendingUsagePool`. Skipped entirely when the feature is off, so no
    // pool grows in a session that will never drain it.
    if (settings.reportUsage) pendingUsage.add(usage);
  });

  // Settings writes: one snapshot source, one emit, two toasts.
  const settingsPersist = createSettingsPersistence(
    settings,
    { manager },
    (event, payload) => pi.events.emit(event, payload),
  );

  // Expose manager via Symbol.for() global registry for cross-package access.
  // Standard Node.js pattern for cross-package singletons (used by OpenTelemetry, etc.).
  // Documented for callers in docs/rpc.md ("The manager registry").
  //
  // Claim the slot only if it's free: subagent sessions re-activate this
  // extension in the same process (session.bindExtensions in agent-runner.ts),
  // and unconditionally overwriting would point the registry at a short-lived
  // child manager — and the child's shutdown would then delete the root
  // session's entry. The first activation (the root session) wins; child
  // activations leave it alone.
  const MANAGER_KEY = Symbol.for("pi-subagents:manager");
  const { spawnResolved, spawnTopLevel, resolveAgentRef } = createSpawnFunnel({ manager, reloadCustomAgents });

  const registryEntry = {
    waitForAll: () => manager.waitForAll(),
    hasRunning: () => manager.hasRunning(),
    spawn: spawnTopLevel,
    getRecord: (id: string) => {
      const record = manager.getRecord(id);
      return record !== undefined && isTopLevelAgent(record) ? record : undefined;
    },
  };
  const ownsManagerRegistry = (globalThis as any)[MANAGER_KEY] === undefined;
  if (ownsManagerRegistry) {
    (globalThis as any)[MANAGER_KEY] = registryEntry;
  }

  // --- Cross-extension RPC via pi.events ---
  let currentCtx: ExtensionContext | undefined;
  // RPC handlers + the `subagents:ready` broadcast are wired on `session_start`
  // (a bound lifecycle event), not at factory time. pi runs every extension
  // factory before the `extensions:` filter and only fires lifecycle events for
  // survivors, so a child session that filtered pi-subagents out never reaches
  // session_start — and must not advertise or answer RPC it can't service
  // (currentCtx would stay undefined → spawn always "No active session"). Gating
  // here makes a filtered session behave like an absent one (#142).
  let rpcHandle: RpcHandle | undefined;
  /** Whether the `@handle` autocomplete wrapper has been stacked on pi's provider. */
  let mentionProviderRegistered = false;

  // ---- Subagent scheduler ----
  // Session-scoped: store is constructed inside session_start once sessionId
  // is available. Mirrors pi-chonky-tasks's session-scoped task store —
  // schedules reset on /new, restore on /resume.
  const scheduler = new SubagentScheduler();

  function startScheduler(ctx: ExtensionContext) {
    try {
      const sessionId = ctx.sessionManager?.getSessionId?.();
      if (!sessionId) return;  // sessionId not yet available — try again on next event
      const path = resolveStorePath(ctx.cwd, sessionId);
      const store = new ScheduleStore(path);
      scheduler.start(pi, ctx, manager, store);
      pi.events.emit("subagents:scheduler_ready", { sessionId, jobCount: store.list().length });
    } catch (err) {
      // Scheduling is non-essential — log and move on so the rest of the
      // extension keeps working if e.g. .pi/ is unwritable.
      console.warn("[pi-subagents] Failed to start scheduler:", err);
    }
  }

  // Capture ctx from session_start for RPC spawn handler + start the scheduler.
  // This also wires the RPC handlers and broadcasts readiness — on the first
  // bound session_start, so a filtered-out activation never advertises (#142).
  pi.on("session_start", async (_event, ctx) => {
    currentCtx = ctx;
    if (ctx.hasUI) {
      widget.setUICtx(ctx.ui);
      fleet.setUICtx(ctx.ui as any);
    }
    manager.clearCompleted(true);
    // Guard mirrors the `!scheduler.isActive()` pattern below: session_start
    // fires once per activation, but a double-bind must not leak listeners.
    if (!rpcHandle) {
      rpcHandle = registerRpcHandlers({
        events: pi.events,
        pi,
        getCtx: () => currentCtx,
        manager: {
          spawn: spawnTopLevel,
          awaitStartup: (id) => manager.awaitStartup(id),
          getRecord: (id) => manager.getRecord(id),
          // Unguarded on purpose: the stop handler now runs the top-level check
          // itself off `getRecord`, and reports the refusal instead of the
          // "Agent not found" a false from here used to be read as.
          abort: (id) => manager.abort(id),
          consumeResult: (id) => {
            const record = resolveAgentRef(id);
            // Same guard as get_subagent_result: a running agent has no result
            // to consume, and its notification is still the caller's only
            // signal that it finished.
            if (!record || record.parentAgentId) return false;
            if (record.status === "running" || record.status === "queued") return false;
            record.resultConsumed = true;
            notifier.cancelNudge(record.id);
            return true;
          },
        },
      });
      // Broadcast readiness so extensions loaded alongside us can discover us.
      // Emitting after all factories have run (rather than at factory time)
      // also avoids the race where a consumer loaded after us misses the event.
      pi.events.emit("subagents:ready", {});
    }
    if (isSchedulingEnabled() && !scheduler.isActive()) startScheduler(ctx);
    // Stack `@handle` suggestions on pi's built-in autocomplete. Registered at
    // most once per activation: pi appends wrappers to a list it never prunes,
    // so a second call would layer a duplicate provider on the first. TUI only
    // — print mode has no such method, and RPC mode's is a no-op.
    if (ctx.mode === "tui" && !mentionProviderRegistered) {
      mentionProviderRegistered = true;
      ctx.ui.addAutocompleteProvider(current =>
        createMentionProvider(
          current,
          // Plain text, not renderAgentName: the same label FleetView and the
          // widget show, but the autocomplete description cannot carry ANSI.
          () => mentionRoster(manager, mentionTypes(), type => getConfig(type).displayName),
          isAgentMentionsEnabled,
        ),
      );
    }
  });

  /** Agent types `@` can start, in the shape the roster wants. */
  const mentionTypes = (): TypeInfo[] =>
    getAvailableTypes().map(name => ({ name, description: getAgentConfig(name)?.description ?? name }));

  /**
   * `@handle message` typed at the prompt addresses that agent instead of the
   * main model — Claude Code's prompt mention, same grammar (see mention.ts).
   *
   * The handle names the *agent*, not one process, so one syntax covers its
   * whole lifecycle: message it while it runs, resume it once it has finished,
   * start it if it never ran. Everything that isn't an agent mention falls
   * through untouched, which is what keeps `@src/foo.ts summarize this`, a bare
   * `@handle`, and ordinary prose working. A delivered mention costs no
   * main-model turn; the answer arrives through the ordinary completion
   * notification either way.
   */
  pi.on("input", async (event, ctx) => {
    // Never hijack text the extension layer itself submitted (pi.sendMessage,
    // scheduled prompts) — only something a person typed can be a mention.
    if (event.source === "extension" || !isAgentMentionsEnabled()) return { action: "continue" };
    // Claiming the turn is TUI only, matching the `@` completion that teaches
    // the syntax. Pi defaults `session.prompt()` to source "interactive", so a
    // headless `pi -p "@explore …"` reaches here too — and claiming it would
    // answer with silence, which the background hold cannot fix: `handled`
    // returns from prompt() before any turn starts, so the loop that patch wraps
    // never runs (it holds subagents spawned by the Agent tool MID-turn, a
    // different path). The agent would detach, `ctx.ui.notify` is a no-op
    // outside the TUI, and print mode would exit having printed nothing.
    //
    // `model` mode has none of that problem: it queues a reminder and lets the
    // turn run, so the answer is the model's own, printed as usual. It is the
    // only branch allowed to act headlessly; everything else falls through to
    // the main model exactly as it did before mentions existed.
    const canDispatchDirectly = ctx.mode === "tui";
    if (!canDispatchDirectly && getAgentMentionMode() !== "model") return { action: "continue" };

    const mention = parseMention(event.text);
    if (!mention) return { action: "continue" };

    // `@main` addresses the main conversation, never a subagent — the one name
    // `assignHandle` refuses to allocate. An explicit escape hatch for text
    // that would otherwise read as a mention, so the prefix is dropped and the
    // rest goes to the model with its attachments intact.
    if (isReservedHandle(mention.handle)) {
      return { action: "transform", text: mention.message, ...(event.images && { images: event.images }) };
    }

    // As typed first, so an agent actually called `agent-foo` wins over Claude
    // Code's `@agent-` + `foo` spelling rather than being shadowed by it.
    const alias = stripAgentPrefix(mention.handle);
    const resolved = manager.resolveMention(mention.handle)
      ?? (alias ? manager.resolveMention(alias) : undefined);

    // Steering and resuming are direct in every mode, so headless they are not
    // available at all. Falling through here rather than dropping to the start
    // path below matters: the handle names an agent that already exists, and
    // asking the model to start another one is not what was typed.
    if (resolved && !canDispatchDirectly) return { action: "continue" };

    if (resolved?.kind === "live") {
      const record = resolved.record;
      const target = `@${record.alias ?? record.handle ?? mention.handle}`;

      if (record.status === "running" || record.status === "queued") {
        // Steering interrupts after the current tool call, exactly like the
        // steer_subagent tool. Un-consume the result so the agent's reply to
        // this message is still relayed even if the LLM read its last answer.
        record.resultConsumed = false;
        manager.steer(record.id, mention.message);
        pi.events.emit("subagents:steered", { id: record.id, message: mention.message });
        ctx.ui.notify(`Sent to ${target}`, "info");
        return { action: "handled" };
      }

      if (record.session) {
        // Both derived from the record's OWN type: a mention names an existing
        // agent, so its frontmatter is what governs — `output_transcript: false`
        // must keep holding, since record.outputFile is the sole gate every
        // downstream consumer keys off and a resume must not re-open it.
        const config = getAgentConfig(record.type);
        const resumedRecord = await startBackgroundResume(ctx, record, mention.message, {
          outputTranscript: config?.outputTranscript ?? getOutputTranscriptDefault(),
          maxTurns: normalizeMaxTurns(config?.maxTurns ?? getDefaultMaxTurns()),
        });
        ctx.ui.notify(
          resumedRecord ? `Resuming ${target}` : `Could not resume ${target} — it is still running.`,
          resumedRecord ? "info" : "warning",
        );
        return { action: "handled" };
      }
      // A live record with no session never got far enough to continue, so it
      // falls through to the start-fresh path below, like Claude's
      // `no_transcript`.
    }

    // Evicted, but its conversation is still on disk: reopen it. This is an
    // ordinary spawn carrying a session file, so the new record picks up the
    // widget, fleet row, transcript and completion notification unchanged —
    // and `reclaim` hands it back the names the tombstone was holding.
    if (resolved?.kind === "tombstone") {
      const entry = resolved.entry;
      const target = `@${entry.alias ?? entry.handle}`;

      // Checked here rather than left to SessionManager.open: that runs inside
      // runAgent, whose rejection lands on the record as an agent error, not in
      // the catch below. A `/new` in another pi window or a manual delete makes
      // the conversation unrecoverable (Claude Code's `not_reachable`), so drop
      // the entry — a row that can only ever fail is worse than none — and say
      // so rather than quietly sending this message to an unrelated agent.
      if (!existsSync(entry.sessionFile)) {
        manager.dropTombstone(entry.handle);
        ctx.ui.notify(`Could not resume ${target} — its session is gone.`, "warning");
        return { action: "handled" };
      }

      // The Agent tool deliberately falls back to general-purpose for a type it
      // cannot resolve (#183), which covers a deleted file AND a merely
      // disabled one. A resume must not inherit that: reopening this
      // conversation under a different agent's prompt and tools is not
      // continuing it, and the new record would re-tombstone under the
      // substitute, so the handle would never find its way back.
      reloadCustomAgents();
      const dispatch = resolveSpawnType(entry.type);
      if (!dispatch.ok || dispatch.fellBackFrom !== undefined) {
        // The tombstone stays: re-enabling the agent makes the handle work
        // again, which a drop would foreclose.
        ctx.ui.notify(`Could not resume ${target} — the ${entry.type} agent is no longer available.`, "warning");
        return { action: "handled" };
      }

      try {
        // spawnResolved, not spawnTopLevel: the latter strips
        // `resumeSessionFile` and `reclaim` as untrusted. This path is the
        // exception — both come from a tombstone this extension wrote.
        const id = spawnResolved(pi, ctx, dispatch.type, mention.message, {
          description: entry.description,
          reclaim: { handle: entry.handle, alias: entry.alias },
          resumeSessionFile: entry.sessionFile,
          isBackground: true,
        });
        // The agent may still be starting — wait, so a startup failure lands in
        // the catch below instead of being announced as a resume.
        await manager.awaitStartup(id);
        // The tombstone deliberately stays. `resolveMention` prefers the live
        // record holding these same names, so it cannot shadow the resume — and
        // if this run dies before establishing its own session, the original
        // transcript is still the right thing for the next mention to reopen.
        // Once the resumed record is evicted it overwrites this entry in place,
        // keyed by the same handle, so nothing accumulates.
        ctx.ui.notify(`Resuming ${target}`, "info");
      } catch (err) {
        // The type is already settled above, so what is left is a spawn-time
        // failure: a strict worktree-isolation error, an unusable cwd.
        ctx.ui.notify(
          `Could not resume ${target}: ${err instanceof Error ? err.message : String(err)}`,
          "warning",
        );
      }
      return { action: "handled" };
    }

    // No agent under that handle — but the name may still be an agent type, in
    // which case the mention starts one.
    const typeHandle = mention.handle;
    const type = resolveHandleToType(typeHandle, getAvailableTypes())
      ?? (alias ? resolveHandleToType(alias, getAvailableTypes()) : undefined);
    if (!type) return { action: "continue" };

    // Claude Code never starts the agent itself: `@agent-<type>` becomes an
    // attachment asking the main model to do it, and the model writes the
    // agent's prompt from the conversation rather than forwarding the typed
    // text. That buys a real `Agent` tool call — transcript, per-tool widget
    // detail, tool-use-id correlation, join grouping — and a prompt with the
    // context a cold spawn lacks.
    //
    // It also costs a visible turn, spent narrating a decision the user already
    // made by typing the handle. So the turn is taken by a clone of this
    // conversation instead (mention-clone.ts): same messages, same system
    // prompt, off-screen, holding only the `Agent` tool. Nothing reaches the
    // chat, and what it starts is an ordinary top-level agent.
    if (getAgentMentionMode() === "model") {
      const label = `@${handleBase(type)}`;
      // "Prompting", not "Starting": in this mode nothing starts until the
      // off-screen clone has taken a whole model turn writing the agent's
      // prompt, and that wait is the one thing the chat cannot show. `direct`
      // says "Started" because by then it has. The distinction tells the user
      // which of the two they are waiting on.
      ctx.ui.notify(`Prompting ${label}…`, "info");
      // Not awaited: the clone runs a full model turn, and prompt() is blocked
      // until this hook returns. The user gets their prompt back immediately
      // and the agent appears in the widget when it starts.
      void runMentionClone({ ctx, type, message: mention.message, agentTool: registeredAgentTool })
        .then(async (result) => {
          if (result.spawned) return;
          // A clone that could not run must not swallow the mention: start the
          // agent the direct way rather than leaving the user with a toast and
          // nothing running.
          try {
            const id = spawnTopLevel(pi, ctx, type, mention.message, {
              description: describeMention(mention.message),
              isBackground: true,
            });
            // Same reason as the direct path below: the agent may still be
            // starting, and a failure there must reach this catch.
            await manager.awaitStartup(id);
            ctx.ui.notify(`Started ${label} directly — ${result.error}`, "warning");
          } catch (err) {
            ctx.ui.notify(
              `Could not start ${label}: ${err instanceof Error ? err.message : String(err)}`,
              "error",
            );
          }
        });
      return { action: "handled" };
    }

    try {
      // Nothing else to pass: runAgent resolves model, thinking and max turns
      // from the agent's own config when the spawn omits them, and the
      // manager's onStart/onComplete callbacks own the widget, the fleet list
      // and the completion notification — the same contract the scheduler and
      // cross-extension RPC spawns run under.
      const id = spawnTopLevel(pi, ctx, type, mention.message, {
        description: describeMention(mention.message),
        isBackground: true,
      });
      // The agent may still be starting (a worktree copy is an awaited git
      // call) — report a failure that lands there as a failed start, not as a
      // "Started" toast for an agent that never ran.
      await manager.awaitStartup(id);
      ctx.ui.notify(`Started @${handleBase(type)}`, "info");
    } catch (err) {
      ctx.ui.notify(`Could not start @${handleBase(type)}: ${err instanceof Error ? err.message : String(err)}`, "error");
    }
    return { action: "handled" };
  });

  pi.on("session_before_switch", () => {
    manager.clearCompleted(true);
    scheduler.stop();
  });

  // On shutdown, abort all agents immediately and clean up.
  // If the session is going down, there's nothing left to consume agent results.
  pi.on("session_shutdown", async () => {
    rpcHandle?.unsubSpawn();
    rpcHandle?.unsubStop();
    rpcHandle?.unsubPing();
    rpcHandle?.unsubConsume();
    rpcHandle = undefined;
    currentCtx = undefined;
    // Only release the global slot if this activation claimed it — a child
    // session's shutdown must not delete the root session's registry entry.
    if (ownsManagerRegistry && (globalThis as any)[MANAGER_KEY] === registryEntry) {
      delete (globalThis as any)[MANAGER_KEY];
    }
    scheduler.stop();
    manager.abortAll();
    notifier.dispose();
    fleet.dispose();
    // Awaited: it emits `session_shutdown` into every retained child session so
    // extensions bound there can release what they armed in `session_start` (#242).
    // pi awaits this handler, and the process exits right after — unawaited, those
    // handlers would never run. Internally bounded, so a hung one can't strand quit.
    await manager.dispose(pi);
  });

  // Live widget: show running agents above editor.
  // widgetMode (default "background") selects what the widget shows: "all" =
  // every agent; "background" = hide foreground (they already render inline as
  // the Agent tool result, so showing them here too is a duplicate, #118), keep
  // everything else; "off" = hide the widget entirely. Read live at render time.
  /**
   * The in-memory settings state, with its setters. Callers that mutate state
   * through `SettingsAppliers` go through this object; the small wrappers above
   * and below give the rest of the factory the names it has always used.
   */
  function createRuntimeSettings(): {
    reportUsage: boolean; showCost: boolean; showModel: boolean;
    viewerMarkdown: ViewerMarkdownMode; widgetMode: WidgetMode; fleetView: boolean;
    agentMentionMode: AgentMentionMode; defaultJoinMode: JoinMode; backgroundByDefault: boolean;
    schedulingEnabled: boolean; toolDescriptionMode: ToolDescriptionMode; strictAgentFiles: boolean;
    setReportUsageFlag(b: boolean): void; setShowCostFlag(b: boolean): void;
    setShowModelFlag(b: boolean): void; setViewerMarkdownMode(m: ViewerMarkdownMode): void;
    setWidgetModeFlag(m: WidgetMode): void; setFleetView(b: boolean): void;
    setAgentMentionMode(m: AgentMentionMode): void; setJoinMode(m: JoinMode): void;
    setBgDefault(b: boolean): void; setScheduling(b: boolean): void;
    setToolDescMode(m: ToolDescriptionMode): void; setStrictAgentFiles(b: boolean): void;
  } {
    return {
      reportUsage: false,
      showCost: false,
      showModel: false,
      viewerMarkdown: "assistant",
      widgetMode: "all",
      fleetView: true,
      agentMentionMode: "model",
      defaultJoinMode: "smart",
      backgroundByDefault: true,
      schedulingEnabled: true,
      toolDescriptionMode: "full",
      strictAgentFiles,
      setReportUsageFlag(b) {
        this.reportUsage = b;
        // Whatever accumulated while it was on is stale the moment it goes off:
        // draining it later would bill the parent for a window the user opted out
        // of, in one lump, on some unrelated later tool call.
        if (!b) pendingUsage.drain();
      },
      setShowCostFlag(b) { this.showCost = b; widget.update(); fleet.update(); },
      setShowModelFlag(b) { this.showModel = b; widget.update(); },
      setViewerMarkdownMode(m) { this.viewerMarkdown = m; },
      setWidgetModeFlag(m) { this.widgetMode = m; widget.update(); },
      setFleetView(b) { this.fleetView = b; fleet.setEnabled(b); },
      setAgentMentionMode(m) { this.agentMentionMode = m; },
      setJoinMode(m) { this.defaultJoinMode = m; },
      setBgDefault(b) { this.backgroundByDefault = b; },
      setScheduling(b) { this.schedulingEnabled = b; },
      setToolDescMode(m) { this.toolDescriptionMode = m; },
      setStrictAgentFiles(b) { this.strictAgentFiles = b; },
    };
  }

  function getWidgetMode(): WidgetMode { return settings.widgetMode; }
  const widget = new AgentWidget(manager, getWidgetMode, isShowCostEnabled, isShowModelEnabled);
  function setWidgetMode(m: WidgetMode): void { settings.setWidgetModeFlag(m); }

  // Claude Code-style FleetView: navigable list of main + subagents below the editor.
  // The last two arguments keep a conversation overlay opened here identical to
  // one opened from `/agents`: same setting on the way in, same persist out.
  const fleet = new FleetList(manager, isShowCostEnabled, getViewerMarkdown,
    (mode) => chooseViewerMarkdown(mode, currentCtx as unknown as ExtensionCommandContext | undefined));
  function setFleetViewEnabled(b: boolean): void { settings.setFleetView(b); }

  // ---- Completion notifications ----
  const notifier = new CompletionNotifier({ pi, manager, widget, fleet, settings });

  // Claude Code-style `@handle message` prompt mentions. Read live by both the
  // `input` hook and the stacked autocomplete provider, so the toggle applies
  // immediately — the provider itself can never be unregistered (pi's wrapper
  // list is append-only), it just delegates everything when this is off.
  function getAgentMentionMode(): AgentMentionMode { return settings.agentMentionMode; }
  function setAgentMentionMode(mode: AgentMentionMode): void { settings.setAgentMentionMode(mode); }
  // `model` and `direct` differ only in who starts a not-yet-running agent, so
  // everything that just asks "are mentions live at all" — the suggestion list,
  // the steer and resume branches — reads this instead of the mode.
  function isAgentMentionsEnabled(): boolean { return settings.agentMentionMode !== "off"; }

  // Project/global default for writing the subagent .output transcript lives in
  // output-file.ts (both spawn paths read it). A custom agent's
  // `output_transcript` frontmatter overrides it per spawn; when the frontmatter
  // is silent, this default applies. Read live at spawn time.

  // ---- Join mode configuration ----
  function setDefaultJoinMode(mode: JoinMode) { settings.setJoinMode(mode); }

  // What an unqualified top-level spawn means. Defaults to background,
  // following Claude Code; `backgroundByDefault: false` restores the previous
  // foreground default. Nested spawns ignore this — see nested-tools.ts.
  function getBackgroundByDefault(): boolean { return settings.backgroundByDefault; }
  function setBackgroundByDefault(b: boolean) { settings.setBgDefault(b); }

  // Master switch for the schedule subagent feature. Defaults to enabled.
  // Read once at extension init (before tool registration) so the Agent tool's
  // param schema reflects the persisted setting. Runtime toggles via /agents
  // → Settings short-circuit the menu entry + the execute-time addJob path
  // immediately, but the schema-level removal only takes effect on next
  // extension load (next pi session). Documented in README.
  function isSchedulingEnabled(): boolean { return settings.schedulingEnabled; }
  function setSchedulingEnabled(b: boolean) { settings.setScheduling(b); }

  // ---- Disable default agents configuration ----
  // When enabled, the three hardcoded default agents (general-purpose, Explore,
  // Plan) are not registered. User-defined agents from project/global custom
  // agent dirs are completely unaffected — only DEFAULT_AGENTS are suppressed.
  // Defaults to false; opt-in via `/agents → Settings` or subagents.json.
  // State lives in agent-types.ts (isDefaultsDisabled) because registerAgents
  // needs it; this wrapper just re-registers after flipping it.
  function setDisableDefaultAgents(b: boolean): void {
    setDefaultsDisabled(b);
    reloadCustomAgents(); // re-register with new setting
  }

  // ---- Agent tool description mode ----
  // "full" (default) keeps the rich Claude Code-style description; "compact"
  // swaps in a ~75% smaller one for small/local models (#91). Read once at
  // tool registration — flipping it applies on the next pi session.
  function getToolDescriptionMode(): ToolDescriptionMode { return settings.toolDescriptionMode; }
  function setToolDescriptionMode(mode: ToolDescriptionMode): void { settings.setToolDescMode(mode); }

  const startBackgroundResume = createBackgroundResume({ pi, manager, notifier, widget, fleet, settings });

  // Grab UI context from first tool execution + clear lingering widget on new turn
  pi.on("tool_execution_start", async (_event, ctx) => {
    widget.setUICtx(ctx.ui as UICtx);
    fleet.setUICtx(ctx.ui as unknown as FleetUICtx);
    widget.onTurnStart();
  });

  /** Build the full type list text dynamically from available agents only. */
  const buildTypeListText = () => {
    const available = getAvailableTypes();

    return available.map((name) => {
      const cfg = getAgentConfig(name);
      const modelSuffix = cfg?.model ? ` (${getModelLabelFromConfig(cfg.model)})` : "";
      const toolsSuffix = ` (Tools: ${formatToolsSuffix(cfg)})`;
      return `- ${name}: ${cfg?.description ?? name}${modelSuffix}${toolsSuffix}`;
    }).join("\n");
  };

  /** First sentence of an agent description — for the compact type list. */
  const firstSentence = (text: string): string => {
    const match = text.match(/^.*?[.!?](?=\s|$)/s);
    return (match ? match[0] : text).replace(/\s+/g, " ").trim();
  };

  /** Compact type list: one line per agent, first sentence only. */
  const buildCompactTypeListText = () =>
    getAvailableTypes().map((name) => {
      const cfg = getAgentConfig(name);
      return `- ${name}: ${firstSentence(cfg?.description ?? name)} (Tools: ${formatToolsSuffix(cfg)})`;
    }).join("\n");

  // Apply persisted settings on startup and emit `subagents:settings_loaded`.
  // Global + project merged; missing → defaults; corrupt file emits a warning
  // to stderr and falls back to defaults.
  const appliers: SettingsAppliers = {
    setMaxConcurrent: (n) => manager.setMaxConcurrent(n),
    setMaxConcurrentForeground: (n) => manager.setMaxConcurrentForeground(n),
    setDefaultMaxTurns,
    setGraceTurns,
    setDefaultJoinMode,
    setBackgroundByDefault,
    setSchedulingEnabled,
    setScopeModels: setScopeModelsEnabled,
    setStrictAgentFiles: (b) => { strictAgentFiles = b; },
    setDisableDefaultAgents: setDisableDefaultAgents,
    setToolDescriptionMode: setToolDescriptionMode,
    setFleetView: setFleetViewEnabled,
    setAgentMentions: setAgentMentionMode,
    setRememberAgents,
    setWidgetMode: setWidgetMode,
    setOutputTranscript: setOutputTranscriptDefault,
    setWorktreeIsolation: setWorktreeIsolationEnabled,
    setMaxSubagentDepth: setMaxSubagentDepth,
    setFallbackSubagent: setFallbackSubagent,
    setReportUsage,
    setShowCost,
    setShowModel,
    setViewerMarkdown,
  };
  applyAndEmitLoaded(appliers, (event, payload) => pi.events.emit(event, payload));

  // ---- Agent tool ----

  // Schedule param + its guideline are gated on `schedulingEnabled` (read once
  // at registration; flipping the setting later requires next pi session for
  // the schema to update). Defining the shape once and spreading it via Partial
  // preserves Type.Object's inference when present and produces a
  // `schedule`-free schema when absent — zero LLM-context cost in disabled mode.
  const scheduleParamShape = {
    schedule: Type.Optional(
      Type.String({
        description:
          'Opt-in only — fire later instead of now. Omit to run immediately (the default, almost always correct). ' +
          'Formats: 6-field cron ("0 0 9 * * 1" = 9am Mon), interval ("5m"/"1h"), one-shot ("+10m" or ISO). ' +
          'Forces run_in_background; incompatible with inherit_context and resume. Returns job ID.',
      }),
    ),
  };
  const scheduleParam: Partial<typeof scheduleParamShape> =
    isSchedulingEnabled() ? scheduleParamShape : {};

  const scheduleGuideline = isSchedulingEnabled()
    ? `\n- Use \`schedule\` only when the user explicitly asked for scheduled / recurring / delayed execution (e.g. "every Monday", "in an hour"). Don't auto-schedule from vague intent like "monitor X" — run once now or ask.`
    : "";

  // Same trade as scheduleParam/scheduleGuideline above: `isolationParam` drops
  // the field from the schema when the project set `worktreeIsolation: false`,
  // so the prose has to go with it. Left in, it would teach the model to pass a
  // parameter that isn't declared — accepted (TypeBox sets no
  // `additionalProperties: false`) and then silently dropped by the resolver.
  // With no per-result note by design, the model would have every reason to go
  // on reporting a `pi-agent-*` branch that was never created.
  const isolationGuideline = isWorktreeIsolationEnabled()
    ? `\n- Use isolation: "worktree" to give the agent its own git worktree (safe parallel file modifications); leave it unset, or pass "off", for none. The worktree is removed when the agent finishes; if it made changes, they are committed to a branch and the branch is named in the result.`
    : "";

  const isolationCompactGuideline = isWorktreeIsolationEnabled()
    ? `\n- isolation: "worktree" gives the agent its own git worktree (removed on completion); changes land on a branch named in the result.`
    : "";

  // Compact Agent tool description (#91, `toolDescriptionMode: "compact"`) —
  // the same load-bearing facts as the full version at ~75% fewer tokens, for
  // small/local models. Per-option details live in the param descriptions.
  const compactAgentToolDescription = `Launch an autonomous agent for complex, multi-step tasks. Agent types:
${buildCompactTypeListText()}

Custom agents: .pi/agents/<name>.md (project) or ${getAgentDir()}/agents/<name>.md (global).

Notes:
- description: 3-5 words (shown in UI). Prompts must be self-contained — the agent has not seen this conversation.
- Parallel work: one message, multiple Agent calls — they run concurrently.
- Subagents run in the background by default; you'll be notified when one completes. Pass run_in_background: false only when your very next action depends on the result and nothing else could usefully happen while it runs. Never fabricate or predict a pending agent's results — if the user asks before the notification arrives, say it's still running.
- The result is not shown to the user — summarize it for them. Verify an agent's claimed code changes before reporting work done.
- resume continues a previous agent by ID; steer_subagent messages a running one.${isolationCompactGuideline}`;

  const fullAgentToolDescription = `Launch a new agent to handle complex, multi-step tasks autonomously. Each agent type has specific capabilities and tools available to it.

Available agent types and the tools they have access to:
${buildTypeListText()}

Custom agents can be defined in .pi/agents/<name>.md (project) or ${getAgentDir()}/agents/<name>.md (global) — they are picked up automatically. Project-level agents override global ones. Creating a .md file with the same name as a default agent overrides it.

When using the Agent tool, specify a subagent_type parameter to select which agent type to use.

## When not to use

If the target is already known, use a direct tool — \`read\` for a known path, \`grep\`/\`find\` for a specific symbol or string. Reserve this tool for open-ended questions that span the codebase, or tasks that match an available agent type.

## Usage notes

- Always include a short (3-5 word) description summarizing what the agent will do (shown in UI).
- When you launch multiple agents for independent work, send them in a single message with multiple tool uses so they run concurrently. If the user specifies that they want you to run agents "in parallel", you MUST send a single message with multiple Agent tool use content blocks.
- When the agent is done, it returns a single message back to you. The result is not visible to the user — to show the user, send a text message with a concise summary.
- Trust but verify: an agent's summary describes what it intended to do, not necessarily what it did. When an agent writes or edits code, check the actual changes before reporting the work as done.
- Agents run in the background by default. When an agent runs in the background, you will be automatically notified when it completes — do NOT sleep, poll, or proactively check on its progress. Continue with other work or respond to the user instead.
- **Foreground vs background**: Pass \`run_in_background: false\` only when your very next action depends on the agent's result and nothing else could usefully happen while it runs — e.g., a research agent whose finding gates the edit you're about to make. Otherwise let it run in the background (the default) — this includes fire-and-forget work, independent investigations, and anything where the user might hand you something else in the meantime. Wanting the result "next" is not enough on its own.
- **Don't race**: after launching a background agent, you know nothing about its results. Never fabricate or predict them in any format — not as prose, summary, or structured output. The completion notification arrives in a later turn; it is never something you write yourself. If the user asks before it lands, say the agent is still running — give status, not a guess.
- Use resume with an agent ID to continue a previous agent's work. A new (non-resume) Agent call starts a fresh agent with no memory of prior runs, so the prompt must be self-contained.
- Use steer_subagent to send mid-run messages to a running background agent.
- Clearly tell the agent whether you expect it to write code or just to do research (search, file reads, etc.), since it is not aware of the user's intent.
- If an agent's description says it should be used proactively, try to use it without the user having to ask for it first.
- Use model to specify a different model (as "provider/modelId", or fuzzy e.g. "haiku", "sonnet").
- Use thinking to control extended thinking level.
- Use inherit_context if the agent needs the parent conversation history.${isolationGuideline}${scheduleGuideline}

## Writing the prompt

Brief the agent like a smart colleague who just walked into the room — it hasn't seen this conversation, doesn't know what you've tried, doesn't understand why this task matters.
- Explain what you're trying to accomplish and why.
- Describe what you've already learned or ruled out.
- Give enough context about the surrounding problem that the agent can make judgment calls rather than just following a narrow instruction.
- If you need a short response, say so ("report in under 200 words").
- Lookups: hand over the exact command. Investigations: hand over the question — prescribed steps become dead weight when the premise is wrong.

Terse command-style prompts produce shallow, generic work.

**Never delegate understanding.** Don't write "based on your findings, fix the bug" or "based on the research, implement it." Those phrases push synthesis onto the agent instead of doing it yourself. Write prompts that prove you understood: include file paths, line numbers, what specifically to change.`;

  // `toolDescriptionMode: "custom"` — user-authored description with live
  // dynamic parts. Project file wins over global; missing/empty falls back to
  // "full" (a stale fallback beats a blank tool description). Only the prose
  // is customizable — the parameter schema stays code-owned.
  const renderToolDescriptionTemplate = (template: string): string => {
    const vars: Record<string, () => string> = {
      typeList: buildTypeListText,
      compactTypeList: buildCompactTypeListText,
      agentDir: getAgentDir,
      isolationGuideline: () => isolationGuideline,
      scheduleGuideline: () => scheduleGuideline,
    };
    // Replacement callback (not a string) — agent descriptions may contain `$&` etc.
    return template.replace(/\{\{(\w+)\}\}/g, (raw, name: string) => {
      if (vars[name]) return vars[name]();
      console.warn(`[pi-subagents] agent-tool-description.md: unknown placeholder ${raw} left as-is`);
      return raw;
    });
  };

  const loadCustomToolDescription = (): string | undefined => {
    for (const path of [
      join(process.cwd(), ".pi", "agent-tool-description.md"),
      join(getAgentDir(), "agent-tool-description.md"),
    ]) {
      try {
        if (!existsSync(path)) continue;
        const text = readFileSync(path, "utf-8").trim();
        if (text) return renderToolDescriptionTemplate(text);
        console.warn(`[pi-subagents] ${path} is empty — ignoring`);
      } catch (err) {
        console.warn(`[pi-subagents] failed to read ${path}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    return undefined;
  };

  const agentToolDescription = (() => {
    const mode = getToolDescriptionMode();
    if (mode === "compact") return compactAgentToolDescription;
    if (mode === "custom") {
      const custom = loadCustomToolDescription();
      if (custom) return custom;
      console.warn('[pi-subagents] toolDescriptionMode is "custom" but no agent-tool-description.md found — using "full"');
    }
    return fullAgentToolDescription;
  })();

  // Held rather than registered inline: the mention clone reuses this exact
  // definition, so the agent it starts is an ordinary top-level spawn instead
  // of a second implementation that has to be kept in step with this one.
  const agentTool = defineTool({
    name: SUBAGENT_TOOL_NAMES.AGENT,
    label: "Agent",
    description: agentToolDescription,
    promptSnippet: "Launch autonomous sub-agents for complex multi-step tasks",
    promptGuidelines: [
      "Use Agent with specialized agents when the task matches an agent type's description. Subagents are valuable for parallelizing independent queries or for protecting the main context window from excessive results, but should not be used excessively when not needed. Importantly, avoid duplicating work that subagents are already doing — if you delegate research to a subagent, do not also perform the same searches yourself.",
      "For broad codebase exploration or research, spawn Agent with an appropriate subagent_type (e.g. Explore). Otherwise handle it yourself when the target is already known.",
      "When an agent runs in the background, you will be notified on completion — do not poll or sleep waiting for it. Continue with other work instead.",
      "Trust but verify: an agent's summary describes intent, not outcome. When an agent writes or edits code, check the actual changes before reporting work as done.",
    ],
    parameters: Type.Object({
      prompt: Type.String({
        description: "The task for the agent to perform.",
      }),
      description: Type.String({
        description: "A short (3-5 word) description of the task (shown in UI).",
      }),
      name: Type.Optional(
        Type.String({
          description:
            'Optional memorable name for this agent, e.g. "auth-audit", so it can be addressed as `@name` at the prompt and by steer_subagent / get_subagent_result. Letters, digits, `_` and `-`. Worth setting when several agents of the same type run at once; omit for one-off work. The agent stays reachable by its type either way.',
        }),
      ),
      subagent_type: Type.String({
        description: `The type of specialized agent to use. Available types: ${getAvailableTypes().join(", ")}. Custom agents from .pi/agents/*.md (project) or ${getAgentDir()}/agents/*.md (global) are also available.`,
      }),
      model: Type.Optional(
        Type.String({
          description:
            'Optional model override. Accepts "provider/modelId" or fuzzy name (e.g. "haiku", "sonnet"). Only set this when the user named a model in their request; otherwise omit.',
        }),
      ),
      thinking: Type.Optional(
        Type.String({
          description: `Thinking level: ${THINKING_LEVELS.join(", ")}. Overrides agent default.`,
        }),
      ),
      max_turns: Type.Optional(
        Type.Number({
          description: "Maximum number of agentic turns before stopping. Omit for unlimited (default).",
          minimum: 1,
        }),
      ),
      run_in_background: Type.Optional(
        Type.Boolean({
          description: "Defaults to true — the agent runs detached, returning its ID immediately, and you are notified on completion. Set false only when your very next action depends on the result; the call then blocks and returns the agent's full output inline.",
        }),
      ),
      resume: Type.Optional(
        Type.String({
          description: "Optional agent ID to resume from. Continues from previous context. Resumes detached like any other spawn; pass run_in_background: false to block and get the result inline. An agent can only be resumed once its current run has finished — use steer_subagent to reach one mid-run.",
        }),
      ),
      isolated: Type.Optional(
        Type.Boolean({
          description: "If true, agent gets no extension/MCP tools — only built-in tools.",
        }),
      ),
      inherit_context: Type.Optional(
        Type.Boolean({
          description: "If true, fork parent conversation into the agent. Default: false (fresh context).",
        }),
      ),
      ...isolationParam(isWorktreeIsolationEnabled()),
      ...scheduleParam,
    }),

    // ---- Custom rendering: Claude Code style ----

    renderCall(args, theme, context) {
      // A badge closes its own background, which would clear the tool block's row tint
      // for the rest of the line, so the badge restores it. The tint is opened here too:
      // the TUI's Box paints it, but HTML export takes it from CSS, and restoring a
      // background the line never opened is what banded the export before. The line is
      // deliberately left open — Box.applyBackgroundToLine pads to width and *then*
      // wraps, so closing here would leave that padding untinted, and HTML export closes
      // any open span per line anyway. No badge means no tint, so an uncolored agent
      // renders exactly the line it always did.
      const rowBackground = hasAgentBadge(args.subagent_type)
        ? theme.getBgAnsi(context.isPartial ? "toolPendingBg" : context.isError ? "toolErrorBg" : "toolSuccessBg")
        : "";
      const desc = args.description ?? "";
      const name = renderAgentName(args.subagent_type, theme, {
        fallbackColor: "toolTitle",
        restoreBackground: rowBackground,
        bold: true,
      });
      return new Text(rowBackground + "▸ " + name + (desc ? "  " + theme.fg("muted", desc) : ""), 0, 0);
    },

    renderResult(result, { expanded, isPartial }, theme, renderContext) {
      const details = result.details as AgentDetails | undefined;
      const text = result.content[0]?.type === "text" ? result.content[0].text : "";
      // Pi reports pre-execution failures (extension block, abort, argument
      // validation) as `{ content: [reason], details: {} }` with isError set —
      // no status to render, so show the reason instead of inventing one (#199).
      if (renderContext.isError || !details?.status) {
        return new Text(text, 0, 0);
      }

      // Helper: build "haiku · thinking: high · ↻5≤30 · 3 tool uses · 33.8k tokens" stats string
      const stats = (d: AgentDetails) => {
        const parts: string[] = [];
        if (d.modelName) parts.push(d.modelName);
        if (d.tags) parts.push(...d.tags);
        if (d.turnCount != null && d.turnCount > 0) {
          parts.push(formatTurns(d.turnCount, d.maxTurns));
        }
        if (d.toolUses > 0) parts.push(`${d.toolUses} tool use${d.toolUses === 1 ? "" : "s"}`);
        if (d.tokens) parts.push(d.tokens);
        if (settings.showCost) {
          const costText = formatCost(d.cost ?? 0);
          if (costText) parts.push(costText);
        }
        return parts.map(p => fgPreservingNestedStyles(theme, "dim", p)).join(" " + theme.fg("dim", "·") + " ");
      };

      // ---- While running (streaming) ----
      if (isPartial || details.status === "running") {
        const frame = SPINNER[details.spinnerFrame ?? 0];
        const s = stats(details);
        return renderRunningAgentStatus(frame, s, details.activity ?? "thinking…", theme);
      }

      // ---- Background agent launched ----
      if (details.status === "background") {
        return new Text(theme.fg("dim", `  ⎿  Running in background (ID: ${details.agentId})`), 0, 0);
      }

      // ---- Completed / Steered ----
      if (details.status === "completed" || details.status === "steered") {
        const duration = formatMs(details.durationMs);
        const isSteered = details.status === "steered";
        const icon = isSteered ? theme.fg("warning", "✓") : theme.fg("success", "✓");
        const s = stats(details);
        let line = icon + (s ? " " + s : "");
        line += " " + theme.fg("dim", "·") + " " + theme.fg("dim", duration);

        if (expanded) {
          const resultText = result.content[0]?.type === "text" ? result.content[0].text : "";
          if (resultText) {
            const lines = resultText.split("\n").slice(0, 50);
            for (const l of lines) {
              line += "\n" + theme.fg("dim", `  ${l}`);
            }
            if (resultText.split("\n").length > 50) {
              line += "\n" + theme.fg("muted", "  ... (use get_subagent_result with verbose for full output)");
            }
          }
        } else {
          const doneText = isSteered ? "Wrapped up (turn limit)" : "Done";
          line += "\n" + theme.fg("dim", `  ⎿  ${doneText}`);
        }
        return new Text(line, 0, 0);
      }

      // ---- Stopped (user-initiated abort) ----
      if (details.status === "stopped") {
        const s = stats(details);
        let line = theme.fg("dim", "■") + (s ? " " + s : "");
        line += "\n" + theme.fg("dim", "  ⎿  Stopped");
        return new Text(line, 0, 0);
      }

      // Anything left ("queued", or a status added later) has no rendering of
      // its own — the turn-limit wording below must not be the catch-all.
      if (details.status !== "error" && details.status !== "aborted") {
        return new Text(text, 0, 0);
      }

      // ---- Error / Aborted (hard max_turns) ----
      const s = stats(details);
      let line = theme.fg("error", "✗") + (s ? " " + s : "");

      if (details.status === "error") {
        line += "\n" + theme.fg("error", `  ⎿  Error: ${details.error ?? "unknown"}`);
      } else {
        line += "\n" + theme.fg("warning", "  ⎿  Aborted (max turns exceeded)");
      }

      return new Text(line, 0, 0);
    },

    // ---- Execute ----

    execute: async (toolCallId, params, signal, onUpdate, ctx) => {
      // Ensure we have UI context for widget rendering
      widget.setUICtx(ctx.ui as UICtx);

      // Reload custom agents so new project/global .md files are picked up without restart
      reloadCustomAgents();

      const rawType = params.subagent_type as SubagentType;
      // Single decision point for dispatch (#183): unknown, disabled and
      // case-ambiguous types are refused here, BEFORE anything spawns, so a
      // background or scheduled call can't start running the wrong agent while
      // the caller is still unaware. `fallbackSubagent` decides whether an
      // unresolvable type falls back or fails closed.
      const dispatch = resolveSpawnType(rawType);
      // `resume` replays a stored session and ignores `subagent_type` entirely,
      // but the parameter is required by the schema — so gating it here would
      // make a live agent unresumable the moment its type is deleted, disabled,
      // or gains a case-clashing sibling. Only a real spawn is gated.
      if (!dispatch.ok && !params.resume) return textResult(dispatch.message);
      const subagentType = dispatch.ok ? dispatch.type : rawType;
      // What the caller actually asked for, named once: `fellBackFrom` is "" for
      // a blank request, so reading it inline invites the `??`-vs-`||` slip that
      // once persisted an empty type into a scheduled job.
      const requestedType = (dispatch.ok && dispatch.fellBackFrom) || subagentType;
      // Computed at resolution rather than after the run, so the background and
      // schedule branches carry it too — previously it existed only on the
      // foreground path. Resume deliberately doesn't: it replays the stored
      // session and ignores `subagent_type` entirely, so a note about type
      // substitution would be describing something that didn't happen.
      const fallbackNote = dispatch.ok && dispatch.fellBackFrom !== undefined
        ? `Note: Unknown agent type "${dispatch.fellBackFrom}" — using ${resolveType(subagentType) ? subagentType : "the fallback agent config"}.\n\n`
        : "";

      const displayName = getDisplayName(subagentType);

      // Get agent config (if any)
      const customConfig = getAgentConfig(subagentType);

      const resolvedConfig = resolveAgentInvocationConfig(customConfig, params, {
        worktreeAllowed: isWorktreeIsolationEnabled(),
        defaultRunInBackground: getBackgroundByDefault(),
      });

      // Caller-supplied model first; the agent file's pin is the fallback. An
      // unresolvable caller spelling is a hard error rather than a quiet demotion
      // to the pin — same policy as an out-of-scope caller model.
      let model = ctx.model;
      if (resolvedConfig.modelInput) {
        const resolved = resolveModel(resolvedConfig.modelInput, ctx.modelRegistry);
        if (typeof resolved === "string") {
          if (resolvedConfig.modelFromParams) return textResult(resolved);
          // config-specified: silent fallback to parent
        } else {
          model = resolved;
        }
      }

      // Scope validation: the effective resolved model is checked against the
      // user's enabledModels list. Policy (hard error vs warn-and-proceed) lives
      // in model-scope.ts so the nested delegation tools apply the same rule.
      const scopeVerdict = checkModelScope({
        model,
        cwd: ctx.cwd,
        modelRegistry: ctx.modelRegistry,
        callerSupplied: resolvedConfig.modelFromParams,
        agentLabel: customConfig?.displayName ?? subagentType,
        modelInput: resolvedConfig.modelInput,
      });
      if (scopeVerdict.kind === "error") return textResult(scopeVerdict.message);
      if (scopeVerdict.kind === "warn") ctx.ui.notify(scopeVerdict.message, "warning");

      const thinking = resolvedConfig.thinking;
      const inheritContext = resolvedConfig.inheritContext;
      const runInBackground = resolvedConfig.runInBackground;
      const isolated = resolvedConfig.isolated;
      const isolation = resolvedConfig.isolation;
      // Whether this spawn writes its .output transcript. Per-agent
      // frontmatter (`output_transcript`) wins; otherwise the project/global
      // default applies. `attachTranscript` below is the SOLE gate — every
      // downstream consumer keys off record.outputFile being set, so no spawn
      // path can re-enable the transcript by accident.
      const outputTranscript = customConfig?.outputTranscript ?? getOutputTranscriptDefault();
      const attachTranscript = (rec: AgentRecord | undefined, agentId: string): void => {
        if (!rec || !outputTranscript) return;
        rec.outputFile = createOutputFilePath(ctx.cwd, agentId, ctx.sessionManager.getSessionId());
        writeInitialEntry(rec.outputFile, agentId, params.prompt, ctx.cwd);
      };

      // Unconditional, not "only when it differs from the parent": a thinking
      // level reads as a property of a model, and an agent that inherited the
      // parent's model used to show the level with nothing to attach it to.
      // This is the pre-session snapshot — agent-manager overwrites it with the
      // effective values the moment a session reports them.
      const { modelName, modelId } = model ? describeModel(model) : { modelName: undefined, modelId: undefined };
      // The agent file's pin, kept only if it names a different model than the one
      // that won. Model input is fuzzy — `"haiku"` and
      // `"anthropic/claude-haiku-4-5"` are the same model — so comparing the two
      // strings would disclose an override that never happened. A pin that
      // resolves to nothing is still worth disclosing: it cannot have taken effect.
      const pinnedModel = ((pin: string | undefined) => {
        if (!pin) return undefined;
        const resolvedPin = resolveModel(pin, ctx.modelRegistry);
        if (typeof resolvedPin === "string") return pin;
        return resolvedPin.provider === model?.provider && resolvedPin.id === model?.id ? undefined : pin;
      })(resolvedConfig.overridden?.model);
      const effectiveMaxTurns = normalizeMaxTurns(resolvedConfig.maxTurns ?? getDefaultMaxTurns());
      const agentInvocation: AgentInvocation = {
        modelName,
        modelId,
        thinking,
        // Only set where the agent file outranked the caller, so the surfaces can
        // disclose a parameter that was accepted but could not take effect (#182).
        requestedThinking: resolvedConfig.overridden?.thinking,
        // The mirror image: `model` precedence runs the other way, so what gets
        // disclosed is the pin the caller displaced.
        pinnedModel,
        // Explicit value only — the default fallback would just add noise.
        // Normalize so `0` (unlimited) doesn't surface as a misleading "max turns: 0".
        maxTurns: normalizeMaxTurns(resolvedConfig.maxTurns),
        isolated,
        inheritContext,
        runInBackground,
        isolation,
      };
      // Tool-result render shows the mode label too; viewer's header already does.
      const modeLabel = getPromptModeLabel(subagentType);
      const { tags: invocationTags } = buildInvocationTags(agentInvocation);
      const agentTags = modeLabel ? [modeLabel, ...invocationTags] : invocationTags;
      const detailBase = {
        displayName,
        description: params.description,
        subagentType,
        modelName,
        tags: agentTags.length > 0 ? agentTags : undefined,
      };

      /**
       * `detailBase` for a record that exists, which outranks it: the base is a
       * snapshot of what this call REQUESTED, and pi may have resolved a
       * different model or clamped the thinking level (agent-manager writes the
       * effective values back when the session reports them). Resume goes
       * further and ignores the model/thinking parameters outright — it runs on
       * the session it is reopening — so rendering the base there advertises
       * settings the run never used.
       *
       * The mode label is rebuilt rather than carried over: it hangs off the
       * agent TYPE, not the invocation, so tags taken straight from
       * buildInvocationTags would silently drop `twin`.
       */
      const detailBaseFor = (rec: AgentRecord | undefined): typeof detailBase => {
        if (!rec?.invocation) return detailBase;
        const type = rec.type;
        const { modelName: recModelName, tags } = buildInvocationTags(rec.invocation);
        const recModeLabel = getPromptModeLabel(type);
        const recTags = recModeLabel ? [recModeLabel, ...tags] : tags;
        return {
          displayName: getDisplayName(type),
          description: rec.description,
          subagentType: type,
          modelName: recModelName,
          tags: recTags.length > 0 ? recTags : undefined,
        };
      };

      // ---- Schedule: register a job, don't spawn now ----
      if (params.schedule) {
        if (!isSchedulingEnabled()) {
          return textResult("Scheduling is disabled in this project. Enable via /agents → Settings → Scheduling.");
        }
        if (params.resume) {
          return textResult("Cannot combine `schedule` with `resume` — schedules create fresh agents.");
        }
        if (params.inherit_context) {
          return textResult("Cannot combine `schedule` with `inherit_context` — there is no parent conversation at fire time.");
        }
        if (params.run_in_background === false) {
          return textResult("Cannot combine `schedule` with `run_in_background: false` — scheduled jobs always run in background.");
        }
        if (!scheduler.isActive()) {
          return textResult("Scheduler is not active in this session yet. Try again after the session has fully started.");
        }
        try {
          const job = scheduler.addJob({
            name: params.description as string,
            description: params.description as string,
            schedule: params.schedule as string,
            // The caller's own name, not the substitute — the scheduler re-resolves
            // at fire time, and the original is what a user edits.
            subagent_type: requestedType,
            prompt: params.prompt as string,
            model: params.model as string | undefined,
            thinking: thinking,
            max_turns: effectiveMaxTurns,
            isolated: isolated,
            isolation: isolation,
          });
          const next = scheduler.getNextRun(job.id);
          return textResult(
            `${fallbackNote}Scheduled "${job.name}" (id: ${job.id}, type: ${job.scheduleType}). ` +
            `Next run: ${next ?? "(unknown)"}. ` +
            `Manage via /agents → Scheduled jobs.`,
          );
        } catch (err) {
          return textResult(err instanceof Error ? err.message : String(err));
        }
      }

      // Resume existing agent
      if (params.resume) {
        const existing = manager.getRecord(params.resume);
        if (!existing || !isTopLevelAgent(existing)) {
          return textResult(`Agent not found: "${params.resume}". It may have been cleaned up.`);
        }
        if (!existing.session) {
          return textResult(`Agent "${params.resume}" has no active session to resume.`);
        }

        // Background resume: detached run that notifies on completion, mirroring
        // a background spawn. Previously run_in_background was silently ignored
        // on resume (this branch returned before the background branch below),
        // so a resumed agent always blocked the main loop until it finished.
        if (runInBackground) {
          const id = existing.id;
          // A detached resume hands control back while the record stays
          // "running", so nothing stops the model from resuming the same agent
          // again mid-run. manager.resume() refuses that (it would orphan the
          // live run's abort controller); say why here, where the model can act
          // on it, instead of letting it read as a generic failure.
          if (existing.status === "running" || existing.status === "queued") {
            return textResult(
              `Agent "${params.resume}" is still ${existing.status} — it can only be resumed once its current run finishes.\n` +
              `Use steer_subagent to send it a message mid-run, or get_subagent_result to wait for it.`,
            );
          }

          const record = await startBackgroundResume(ctx, existing, params.prompt, {
            outputTranscript,
            maxTurns: effectiveMaxTurns,
            toolCallId,
          });
          if (!record) {
            return textResult(`Failed to resume agent "${params.resume}".`);
          }

          const isQueued = record.status === "queued";
          return textResult(
            `Agent ${isQueued ? "queued" : "resumed"} in background.\n` +
            `Agent ID: ${id}\n` +
            `Type: ${existing.type}\n` +
            (record.outputFile ? `Output file: ${record.outputFile}\n` : "") +
            (isQueued ? `Position: queued (max ${manager.getMaxConcurrent()} concurrent)\n` : "") +
            `\nYou will be notified when this agent completes.\n` +
            `Use get_subagent_result to retrieve full results, or steer_subagent to send it messages.`,
            { ...detailBaseFor(record), toolUses: record.toolUses, tokens: "", durationMs: 0, status: "background" as const, agentId: id },
          );
        }

        const record = await manager.resume(params.resume, params.prompt, signal);
        if (!record) {
          return textResult(`Failed to resume agent "${params.resume}".`);
        }
        // A failed resume surfaces the error, plus any partial output THIS
        // resume produced (never the previous turn's answer, #144).
        if (record.status === "error") {
          return textResult(`Agent failed: ${record.error}${partialOutputSuffix(record)}`, buildDetails(detailBaseFor(record), record));
        }
        return textResult(
          record.result?.trim() || "No output.",
          buildDetails(detailBaseFor(record), record),
        );
      }

      // Background execution
      if (runInBackground) {
        const bgCallbacks = createActivityTracker();

        // Wrap onSessionCreated to wire output file streaming.
        // The callback lazily reads record.outputFile (set right after spawn)
        // rather than closing over a value that doesn't exist yet.
        let id: string;
        const origBgOnSession = bgCallbacks.onSessionCreated;
        bgCallbacks.onSessionCreated = (session: any) => {
          origBgOnSession(session);
          const rec = manager.getRecord(id);
          if (rec?.outputFile) {
            rec.outputCleanup = streamToOutputFile(session, rec.outputFile, id, ctx.cwd);
          }
        };

        // A throw here means the agent never started. Let it out: pi marks a
        // tool call failed only when execute throws, and a returned message
        // reads to the model as a subagent that ran and reported this (#179).
        id = manager.spawn(pi, ctx, subagentType, params.prompt, {
          description: params.description,
          name: params.name as string | undefined,
          model,
          maxTurns: effectiveMaxTurns,
          isolated,
          inheritContext,
          thinkingLevel: thinking,
          isBackground: true,
          isolation,
          invocation: agentInvocation,
          rootSessionId: ctx.sessionManager.getSessionId(),
          ...bgCallbacks,
        });

        // Set output file + join mode synchronously after spawn, before the
        // event loop yields — onSessionCreated is async so this is safe.
        const joinMode = resolveJoinMode(settings.defaultJoinMode, true);
        const record = manager.getRecord(id);
        if (record && joinMode) {
          record.joinMode = joinMode;
          record.toolCallId = toolCallId;
          attachTranscript(record, id);
        }

        // With isolation: "worktree" the agent isn't running yet — the repo
        // copy is an awaited git call. Wait for it here, after the synchronous
        // wiring above, so a strict-isolation failure still fails THIS tool
        // call instead of being reported as a subagent that ran (#179).
        await manager.awaitStartup(id);

        if (joinMode == null || joinMode === 'async') {
          // Foreground/no join mode or explicit async — not part of any batch
        } else {
          // smart or group — add to current batch
          notifier.addToBatch(id, joinMode);
        }

        widget.ensureTimer();
        widget.update();
        fleet.ensureTimer();
        fleet.update();

        // Emit created event
        pi.events.emit("subagents:created", {
          id,
          type: subagentType,
          description: params.description,
          isBackground: true,
        });

        const isQueued = record?.status === "queued";
        return textResult(
          `${fallbackNote}Agent ${isQueued ? "queued" : "started"} in background.\n` +
          `Agent ID: ${id}\n` +
          `Type: ${displayName}\n` +
          `Description: ${params.description}\n` +
          (record?.outputFile ? `Output file: ${record.outputFile}\n` : "") +
          (isQueued ? `Position: queued (max ${manager.getMaxConcurrent()} concurrent)\n` : "") +
          `\nYou will be notified when this agent completes.\n` +
          `Use get_subagent_result to retrieve full results, or steer_subagent to send it messages.\n` +
          `Do not duplicate this agent's work.`,
          { ...detailBaseFor(record), toolUses: 0, tokens: "", durationMs: 0, status: "background" as const, agentId: id },
        );
      }

      // Foreground (synchronous) execution — stream progress via onUpdate
      let spinnerFrame = 0;
      const startedAt = Date.now();
      let fgId: string | undefined;
      // Set only while the spawn is parked on a foreground concurrency slot
      // (maxConcurrentForeground); undefined the rest of the time, including
      // always when the limit is unset.
      let queuedAhead: number | undefined;

      // Until `fgId` is known — the spawn may still be queued on a foreground
      // slot — there is no record to read activity off, so the display falls
      // back to an empty state carrying the turn ceiling this call asked for.
      const emptyActivity: AgentActivity = {
        activeTools: new Map(), toolUses: 0, turnCount: 1, maxTurns: effectiveMaxTurns, responseText: "",
      };
      const fgActivity = (): AgentActivity => (fgId ? manager.getActivity(fgId) : undefined) ?? emptyActivity;

      const streamUpdate = () => {
        // Spend from the record, everything else from the manager's live
        // activity. `fgId` is set in onSessionCreated below, which fires before
        // the first assistant message — so nothing is spent while this reads zero.
        const fgRecord = fgId ? manager.getRecord(fgId) : undefined;
        const fgState = fgActivity();
        const details: AgentDetails = {
          ...detailBaseFor(fgRecord),
          toolUses: fgState.toolUses,
          tokens: fgRecord ? formatLifetimeTokens(fgRecord) : "",
          cost: fgRecord ? getLifetimeCost(fgRecord.lifetimeUsage) : 0,
          turnCount: fgState.turnCount,
          maxTurns: fgState.maxTurns,
          durationMs: Date.now() - startedAt,
          // Deliberately still "running" while queued: the renderer routes any
          // status it doesn't know to raw text (see the catch-all below), which
          // would drop the spinner and read as hung. Only the activity line
          // changes — "thinking…" would be a lie for an agent that has not
          // started and may not for minutes.
          status: "running",
          activity: queuedAhead === undefined
            ? describeActivity(fgState.activeTools, fgState.responseText)
            : `queued — waiting for a foreground slot${queuedAhead > 0 ? ` (${queuedAhead} ahead)` : ""}`,
          spinnerFrame: spinnerFrame % SPINNER.length,
        };
        onUpdate?.({
          content: [{ type: "text", text: `${fgState.toolUses} tool uses...` }],
          details: details as any,
        });
      };

      const fgCallbacks = createActivityTracker(streamUpdate);

      // Wire session creation: register in widget + stream to output file.
      // The output file path is set synchronously after spawn (below),
      // before onSessionCreated fires — same pattern as background agents.
      const origOnSession = fgCallbacks.onSessionCreated;
      fgCallbacks.onSessionCreated = (session: any) => {
        origOnSession(session);
        // It really started — stop reporting it as queued, and repaint now
        // rather than leaving the stale line up for the next spinner tick.
        // Guarded, so a spawn that never queued emits no extra update.
        if (queuedAhead !== undefined) {
          queuedAhead = undefined;
          streamUpdate();
        }
        for (const a of manager.listAgents()) {
          if (a.session === session) {
            fgId = a.id;
            widget.ensureTimer();
            fleet.ensureTimer();
            fleet.update();
            break;
          }
        }
        // Stream conversation to output file (foreground agent logging)
        if (fgId) {
          const rec = manager.getRecord(fgId);
          if (rec?.outputFile) {
            rec.outputCleanup = streamToOutputFile(session, rec.outputFile, fgId, ctx.cwd);
          }
        }
      };

      // Animate spinner at ~80ms (smooth rotation through 10 braille frames)
      const spinnerInterval = setInterval(() => {
        spinnerFrame++;
        streamUpdate();
      }, 80);

      streamUpdate();

      let record: AgentRecord;
      try {
        const fgResult = await manager.spawnAndWait(pi, ctx, subagentType, params.prompt, {
          description: params.description,
          name: params.name as string | undefined,
          model,
          maxTurns: effectiveMaxTurns,
          isolated,
          inheritContext,
          thinkingLevel: thinking,
          isolation,
          invocation: agentInvocation,
          signal,
          rootSessionId: ctx.sessionManager.getSessionId(),
          // Deliberately does NOT set fgId: that drives agentActivity, the
          // widget and the `finally` cleanup below, none of which should see an
          // agent that has no session and may never get one.
          onQueued: (_id, ahead) => { queuedAhead = ahead; streamUpdate(); },
          ...fgCallbacks,
        }, (fgAgentId) => {
          // onSpawned: called synchronously after spawn, before onSessionCreated fires.
          // Set up the output file so streamToOutputFile can pick it up.
          const fgRec = manager.getRecord(fgAgentId);
          attachTranscript(fgRec, fgAgentId);
        });
        record = fgResult.record;
      } finally {
        // Runs on both paths, so a startup throw — which now propagates, see
        // the background spawn above (#179) — no longer leaves the spinner
        // ticking or a finished agent on the widget.
        clearInterval(spinnerInterval);
        if (fgId) {
          widget.markFinished(fgId);
          fleet.onAgentFinished(fgId);
        }
      }

      // Get final token count — from the record, like the cost below it, so the
      // two describe the same work when the agent delegated to nested children.
      const tokenText = formatLifetimeTokens(record);

      const details = buildDetails(detailBaseFor(record), record, fgActivity(), { tokens: tokenText });

      if (record.status === "error") {
        // Error headline + any partial output the run produced before failing.
        return textResult(`${fallbackNote}Agent failed: ${record.error}${partialOutputSuffix(record)}`, details);
      }

      const durationMs = (record.completedAt ?? Date.now()) - record.startedAt;
      const statsParts = [`${record.toolUses} tool uses`];
      if (tokenText) statsParts.push(tokenText);
      if (settings.showCost) {
        const costText = formatCost(getLifetimeCost(record.lifetimeUsage));
        if (costText) statsParts.push(costText);
      }
      return textResult(
        `${fallbackNote}Agent completed in ${formatMs(durationMs)} (${statsParts.join(", ")})${getForegroundOutcomeNote(record.status, record.stoppedBy)}.\n\n` +
        (record.result?.trim() || "No output."),
        details,
      );
    },
  });

  const usageReporting = { settings, pendingUsage };

  // The mention path is handed THIS object, not the bare `agentTool` — see the
  // mention-clone header on why the clone must call the registered tool.
  const registeredAgentTool = withUsageReporting(agentTool, usageReporting);
  pi.registerTool(registeredAgentTool);

  registerAgentControlTools(pi, { manager, notifier, settings, resolveAgentRef, usageReporting });

  registerAgentsCommand(pi, {
    manager,
    scheduler,
    reloadCustomAgents,
    settings,
    chooseViewerMarkdown,
    showCreateWizard: (ctx) => showCreateWizard(ctx, { pi, manager, reloadCustomAgents }),
    showSettings: (ctx) => showSettings(ctx, {
      settings,
      appliers,
      manager,
      scheduler,
      settingsPersist,
      isStrictAgentFiles: () => strictAgentFiles,
    }),
  });
}
