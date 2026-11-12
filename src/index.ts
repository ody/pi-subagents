// Size: extension entry point; it builds the shared closure state (manager, widget, fleet, settings) and wires the feature modules to it, which has to happen in one place.

import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getAgentConfig, getAvailableTypes, getConfig, registerAgents, setDefaultsDisabled, setFallbackSubagent } from "./agents/agent-types.js";
import { loadCustomAgents } from "./agents/custom-agents.js";
import { setScopeModelsEnabled } from "./config/model-scope.js";
import { setDefaultMaxTurns, setGraceTurns, setRememberAgents } from "./config/runner-defaults.js";
import { createSettingsPersistence } from "./config/runtime-settings.js";
import { applyAndEmitLoaded, loadSettings, type SettingsAppliers, type ToolDescriptionMode } from "./config/settings.js";
import { buildEventData } from "./lifecycle-events.js";
import { AgentManager } from "./manager/agent-manager.js";
import { isTopLevelAgent } from "./manager/agent-manager-rules.js";
import { createBackgroundResume } from "./manager/background-resume.js";
import { CompletionNotifier } from "./manager/completion-notifier.js";
import { setOutputTranscriptDefault } from "./platform/output-file.js";
import { setWorktreeIsolationEnabled } from "./platform/worktree.js";
import { inChildSessionContext } from "./session/child-context.js";
import { registerAgentControlTools } from "./tool/agent-control-tools.js";
import { createAgentTool } from "./tool/agent-tool.js";
import { setMaxSubagentDepth } from "./tool/nested-tools.js";
import { type RpcHandle, registerRpcHandlers } from "./triggers/cross-extension-rpc.js";
import { registerMentionInput } from "./triggers/mention-input.js";
import { SubagentScheduler } from "./triggers/schedule.js";
import { resolveStorePath, ScheduleStore } from "./triggers/schedule-store.js";
import { createSpawnFunnel } from "./triggers/spawn-funnel.js";
import { type AgentMentionMode, type JoinMode, type ViewerMarkdownMode, type WidgetMode } from "./types.js";
import { createMentionProvider, mentionRoster, type TypeInfo } from "./ui/agent-mention.js";
import { AgentWidget, type UICtx } from "./ui/agent-widget.js";
import { registerAgentsCommand } from "./ui/agents-menu.js";
import { showCreateWizard } from "./ui/create-agent-wizard.js";
import { FleetList, type FleetUICtx } from "./ui/fleet-list.js";
import { registerNotificationRenderer } from "./ui/notification-renderer.js";
import { showSettings } from "./ui/settings-menu.js";
import { PendingUsagePool, withUsageReporting } from "./usage.js";

export default function (pi: ExtensionAPI) {
  if (inChildSessionContext()) return;

  let strictAgentFiles = loadSettings(process.cwd()).strictAgentFiles === true;

  const reloadCustomAgents = (strict = false) => {
    const userAgents = loadCustomAgents(process.cwd(), strict);
    registerAgents(userAgents);
  };

  reloadCustomAgents(strictAgentFiles);

  const settings = createRuntimeSettings();
  const setReportUsage = (b: boolean): void => { settings.setReportUsageFlag(b); };
  const isShowCostEnabled = () => settings.showCost;
  const setShowCost = (b: boolean): void => { settings.setShowCostFlag(b); };
  const isShowModelEnabled = () => settings.showModel;
  const setShowModel = (b: boolean): void => { settings.setShowModelFlag(b); };
  const getViewerMarkdown = () => settings.viewerMarkdown;
  const setViewerMarkdown = (m: ViewerMarkdownMode): void => { settings.setViewerMarkdownMode(m); };
  function chooseViewerMarkdown(mode: ViewerMarkdownMode, ctx?: ExtensionCommandContext): void {
    setViewerMarkdown(mode);
    settingsPersist.persist(ctx, `Viewer markdown set to ${mode}`);
  }
  const pendingUsage = new PendingUsagePool();

  registerNotificationRenderer(pi, { settings });

  const manager = new AgentManager((record) => {
    if (!isTopLevelAgent(record)) return;

    const isError = record.status === "error" || record.status === "stopped" || record.status === "aborted";
    const eventData = buildEventData(record);
    if (isError) {
      pi.events.emit("subagents:failed", eventData);
    } else {
      pi.events.emit("subagents:completed", eventData);
    }

    pi.appendEntry("subagents:record", {
      id: record.id, type: record.type, description: record.description,
      status: record.status, result: record.result, error: record.error,
      startedAt: record.startedAt, completedAt: record.completedAt,
    });

    notifier.onAgentComplete(record);
  }, undefined, (record) => {
    if (!isTopLevelAgent(record)) return;
    if (currentCtx?.hasUI) {
      widget.ensureTimer();
      widget.update();
      fleet.ensureTimer();
      fleet.update();
    }
    pi.events.emit("subagents:started", {
      id: record.id,
      type: record.type,
      description: record.description,
    });
  }, (record, info) => {
    if (!isTopLevelAgent(record)) return;
    pi.events.emit("subagents:compacted", {
      id: record.id,
      type: record.type,
      description: record.description,
      reason: info.reason,
      tokensBefore: info.tokensBefore,
      compactionCount: record.compactionCount,
    });
  }, (_record, usage) => {
    if (settings.reportUsage) pendingUsage.add(usage);
  });

  const settingsPersist = createSettingsPersistence(
    settings,
    { manager },
    (event, payload) => pi.events.emit(event, payload),
  );

  const MANAGER_KEY = Symbol.for("pi-subagents:manager");
  const { spawnResolved, spawnTopLevel, resolveAgentRef } = createSpawnFunnel({ manager, reloadCustomAgents });

  const registryEntry = {
    waitForAll: () => manager.waitForAll(),
    hasRunning: () => manager.hasRunning(),
    spawn: (piRef: any, ctxRef: any, type: string, prompt: string, options: any) => spawnTopLevel(piRef, ctxRef, type, prompt, options),
    getRecord: (id: string) => {
      const record = manager.getRecord(id);
      return record !== undefined && isTopLevelAgent(record) ? record : undefined;
    },
  };
  const ownsManagerRegistry = (globalThis as any)[MANAGER_KEY] === undefined;
  if (ownsManagerRegistry) {
    (globalThis as any)[MANAGER_KEY] = registryEntry;
  }

  let currentCtx: ExtensionContext | undefined;
  let rpcHandle: RpcHandle | undefined;
  let mentionProviderRegistered = false;

  const scheduler = new SubagentScheduler();

  function startScheduler(ctx: ExtensionContext) {
    try {
      const sessionId = ctx.sessionManager?.getSessionId?.();
      if (!sessionId) return;
      const path = resolveStorePath(ctx.cwd, sessionId);
      const store = new ScheduleStore(path);
      scheduler.start(pi, ctx, manager, store);
      pi.events.emit("subagents:scheduler_ready", { sessionId, jobCount: store.list().length });
    } catch (err) {
      console.warn("[pi-subagents] Failed to start scheduler:", err);
    }
  }

  pi.on("session_start", async (_event, ctx) => {
    currentCtx = ctx;
    if (ctx.hasUI) {
      widget.setUICtx(ctx.ui);
      fleet.setUICtx(ctx.ui as any);
    }
    manager.clearCompleted(true);
    if (!rpcHandle) {
      rpcHandle = registerRpcHandlers({
        events: pi.events,
        pi,
        getCtx: () => currentCtx,
        manager: {
          spawn: spawnTopLevel,
          awaitStartup: (id) => manager.awaitStartup(id),
          getRecord: (id) => manager.getRecord(id),
          abort: (id) => manager.abort(id),
          consumeResult: (id) => {
            const record = resolveAgentRef(id);
            if (!record || !isTopLevelAgent(record)) return false;
            if (record.status === "running" || record.status === "queued") return false;
            record.resultConsumed = true;
            notifier.cancelNudge(record.id);
            return true;
          },
        },
      });
      pi.events.emit("subagents:ready", {});
    }
    if (isSchedulingEnabled() && !scheduler.isActive()) startScheduler(ctx);
    if (ctx.mode === "tui" && !mentionProviderRegistered) {
      mentionProviderRegistered = true;
      ctx.ui.addAutocompleteProvider(current =>
        createMentionProvider(
          current,
          () => mentionRoster(manager, mentionTypes(), type => getConfig(type).displayName),
          isAgentMentionsEnabled,
        ),
      );
    }
  });

  const mentionTypes = (): TypeInfo[] =>
    getAvailableTypes().map(name => ({ name, description: getAgentConfig(name)?.description ?? name }));

  pi.on("session_before_switch", () => {
    manager.clearCompleted(true);
    scheduler.stop();
  });

  pi.on("session_shutdown", async () => {
    rpcHandle?.unsubSpawn();
    rpcHandle?.unsubStop();
    rpcHandle?.unsubPing();
    rpcHandle?.unsubConsume();
    rpcHandle = undefined;
    currentCtx = undefined;
    if (ownsManagerRegistry && (globalThis as any)[MANAGER_KEY] === registryEntry) {
      delete (globalThis as any)[MANAGER_KEY];
    }
    scheduler.stop();
    manager.abortAll();
    notifier.dispose();
    fleet.dispose();
    await manager.dispose(pi);
  });

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

  const fleet = new FleetList(manager, isShowCostEnabled, getViewerMarkdown,
    (mode) => chooseViewerMarkdown(mode, currentCtx as unknown as ExtensionCommandContext | undefined));
  function setFleetViewEnabled(b: boolean): void { settings.setFleetView(b); }

  const notifier = new CompletionNotifier({ pi, manager, widget, fleet, settings });

  function setAgentMentionMode(mode: AgentMentionMode): void { settings.setAgentMentionMode(mode); }
  function isAgentMentionsEnabled(): boolean { return settings.agentMentionMode !== "off"; }

  function setDefaultJoinMode(mode: JoinMode) { settings.setJoinMode(mode); }

  function setBackgroundByDefault(b: boolean) { settings.setBgDefault(b); }

  function isSchedulingEnabled(): boolean { return settings.schedulingEnabled; }
  function setSchedulingEnabled(b: boolean) { settings.setScheduling(b); }

  function setDisableDefaultAgents(b: boolean): void {
    setDefaultsDisabled(b);
    reloadCustomAgents();
  }

  function setToolDescriptionMode(mode: ToolDescriptionMode): void { settings.setToolDescMode(mode); }

  const startBackgroundResume = createBackgroundResume({ pi, manager, notifier, widget, fleet, settings });

  pi.on("tool_execution_start", async (_event, ctx) => {
    widget.setUICtx(ctx.ui as UICtx);
    fleet.setUICtx(ctx.ui as unknown as FleetUICtx);
    widget.onTurnStart();
  });

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

  const registeredAgentTool = withUsageReporting(agentTool, usageReporting);
  pi.registerTool(registeredAgentTool);

  registerMentionInput(pi, {
    manager,
    settings,
    isAgentMentionsEnabled,
    spawnResolved,
    spawnTopLevel,
    startBackgroundResume,
    reloadCustomAgents,
    agentTool: registeredAgentTool,
  });

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
