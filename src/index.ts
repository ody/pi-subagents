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

import { existsSync } from "node:fs";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { registerAgentControlTools } from "./agent-control-tools.js";
import { AgentManager } from "./agent-manager.js";
import { isTopLevelAgent } from "./agent-manager-rules.js";
import { createAgentTool } from "./agent-tool.js";
import { getAgentConfig, getAvailableTypes, getConfig, registerAgents, resolveSpawnType, setDefaultsDisabled, setFallbackSubagent } from "./agent-types.js";
import { createBackgroundResume } from "./background-resume.js";
import { inChildSessionContext } from "./child-context.js";
import { CompletionNotifier } from "./completion-notifier.js";
import { type RpcHandle, registerRpcHandlers } from "./cross-extension-rpc.js";
import { loadCustomAgents } from "./custom-agents.js";
import { buildEventData } from "./lifecycle-events.js";
import { describeMention, handleBase, isReservedHandle, parseMention, resolveHandleToType, stripAgentPrefix } from "./mention.js";
import { runMentionClone } from "./mention-clone.js";
import { setScopeModelsEnabled } from "./model-scope.js";
import { setMaxSubagentDepth } from "./nested-tools.js";
import { getOutputTranscriptDefault, setOutputTranscriptDefault } from "./output-file.js";
import { getDefaultMaxTurns, normalizeMaxTurns, setDefaultMaxTurns, setGraceTurns, setRememberAgents } from "./runner-defaults.js";
import { createSettingsPersistence } from "./runtime-settings.js";
import { SubagentScheduler } from "./schedule.js";
import { resolveStorePath, ScheduleStore } from "./schedule-store.js";
import { applyAndEmitLoaded, loadSettings, type SettingsAppliers, type ToolDescriptionMode } from "./settings.js";
import { createSpawnFunnel } from "./spawn-funnel.js";
import { type AgentMentionMode, type JoinMode, type ViewerMarkdownMode, type WidgetMode } from "./types.js";
import { createMentionProvider, mentionRoster, type TypeInfo } from "./ui/agent-mention.js";
import { AgentWidget, type UICtx } from "./ui/agent-widget.js";
import { registerAgentsCommand } from "./ui/agents-menu.js";
import { showCreateWizard } from "./ui/create-agent-wizard.js";
import { FleetList, type FleetUICtx } from "./ui/fleet-list.js";
import { registerNotificationRenderer } from "./ui/notification-renderer.js";
import { showSettings } from "./ui/settings-menu.js";
import { PendingUsagePool, withUsageReporting } from "./usage.js";
import { setWorktreeIsolationEnabled } from "./worktree.js";

// ---- Shared helpers ----

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
  function setToolDescriptionMode(mode: ToolDescriptionMode): void { settings.setToolDescMode(mode); }

  const startBackgroundResume = createBackgroundResume({ pi, manager, notifier, widget, fleet, settings });

  // Grab UI context from first tool execution + clear lingering widget on new turn
  pi.on("tool_execution_start", async (_event, ctx) => {
    widget.setUICtx(ctx.ui as UICtx);
    fleet.setUICtx(ctx.ui as unknown as FleetUICtx);
    widget.onTurnStart();
  });

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

  const agentTool = createAgentTool(pi, {
    manager,
    scheduler,
    widget,
    fleet,
    notifier,
    startBackgroundResume,
    reloadCustomAgents,
    settings,
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
