// Size: extension entry point; it builds the shared closure state (manager, widget, settings) and wires the feature modules to it, which has to happen in one place.

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getAgentConfig, getAvailableTypes, getConfig, registerAgents } from "./agents/agent-types.js";
import { loadCustomAgents } from "./agents/custom-agents.js";
import { setScopeModelsEnabled } from "./config/model-scope.js";
import { setDefaultMaxTurns, setGraceTurns, setRememberAgents } from "./config/runner-defaults.js";
import { createSettingsPersistence } from "./config/runtime-settings.js";
import { applyLoadedSettings, effectiveSettings, type SettingsAppliers, settingsLoadedPayload, type ToolDescriptionMode } from "./config/settings.js";
import { SETTING_SPECS } from "./config/settings-defaults.js";
import { buildEventData } from "./lifecycle-events.js";
import { AgentManager } from "./manager/agent-manager.js";
import { isTopLevelAgent } from "./manager/agent-manager-rules.js";
import { isolationFields } from "./manager/agent-retention.js";
import { createBackgroundResume } from "./manager/background-resume.js";
import { CompletionNotifier } from "./manager/completion-notifier.js";
import { setOutputTranscriptDefault } from "./platform/output-file.js";
import { setWorktreeIsolationEnabled } from "./platform/worktree.js";
import { RpcError } from "./rpc-error.js";
import { inChildSessionContext } from "./session/child-context.js";
import { registerAgentControlTools } from "./tool/agent-control-tools.js";
import { createAgentModelsTool } from "./tool/agent-models-tool.js";
import { createAgentTool } from "./tool/agent-tool.js";
import { setMaxSubagentDepth } from "./tool/nested-tools.js";
import { type RpcHandle, registerRpcHandlers } from "./triggers/cross-extension-rpc.js";
import { registerMentionInput } from "./triggers/mention-input.js";
import { createSpawnFunnel } from "./triggers/spawn-funnel.js";
import { type AgentMentionMode, type AgentRecord, type JoinMode, type WidgetMode } from "./types.js";
import { createMentionProvider, mentionRoster, type TypeInfo } from "./ui/agent-mention.js";
import { AgentWidget, type UICtx } from "./ui/agent-widget.js";
import { registerAgentsCommand } from "./ui/agents-menu.js";
import { ConversationViewerOpener } from "./ui/conversation-viewer-opener.js";
import { MainSessionStatus } from "./ui/main-session-status.js";
import { registerNotificationRenderer } from "./ui/notification-renderer.js";
import { showSettings } from "./ui/settings-menu.js";
import { PendingUsagePool, withUsageReporting } from "./usage.js";
import { setWarningSink } from "./warnings.js";

export default function (pi: ExtensionAPI) {
  if (inChildSessionContext()) return;

  let strictAgentFiles = effectiveSettings(process.cwd()).strictAgentFiles;

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
  const pendingUsage = new PendingUsagePool();

  registerNotificationRenderer(pi, { settings });

  function appendRecord(record: AgentRecord): void {
    pi.appendEntry("agent:record", {
      id: record.id, type: record.type, description: record.description,
      status: record.status, result: record.result ?? record.recoveryResult, error: record.error,
      startedAt: record.startedAt, completedAt: record.completedAt,
      ...(record.stopCause && { stopCause: record.stopCause }),
      ...(record.sessionFile && {
        handle: record.handle, alias: record.alias, sessionFile: record.sessionFile, agentConfig: record.agentConfig,
        ...isolationFields(record),
      }),
    });
  }

  const manager = new AgentManager((record) => {
    if (!isTopLevelAgent(record) || record.stopCause === "shutdown") return;

    const isError = record.status === "error" || record.status === "stopped" || record.status === "aborted";
    const eventData = buildEventData(record);
    if (isError) {
      pi.events.emit("agent:failed", eventData);
    } else {
      pi.events.emit("agent:completed", eventData);
    }

    appendRecord(record);

    notifier.onAgentComplete(record);
  }, undefined, (record) => {
    if (!isTopLevelAgent(record)) return;
    if (currentCtx?.hasUI) {
      widget.ensureTimer();
      widget.update();
    }
    pi.events.emit("agent:started", {
      id: record.id,
      type: record.type,
      description: record.description,
    });
  }, (record, info) => {
    if (!isTopLevelAgent(record)) return;
    pi.events.emit("agent:compacted", {
      id: record.id,
      type: record.type,
      description: record.description,
      reason: info.reason,
      tokensBefore: info.tokensBefore,
      compactionCount: record.compactionCount,
    });
  }, (_record, usage) => {
    if (settings.reportUsage) pendingUsage.add(usage);
  }, (id: string): boolean => notifier.isNotificationPending(id));

  const { spawnResolved, spawnTopLevel, resolveAgentRef, resolveAgentTombstone } = createSpawnFunnel({ manager, reloadCustomAgents });


  let currentCtx: ExtensionContext | undefined;
  let rpcHandle: RpcHandle | undefined;
  let mentionProviderRegistered = false;

  pi.on("session_start", async (_event, ctx) => {
    currentCtx = ctx;
    setWarningSink((message) => {
      if (ctx.hasUI) ctx.ui.notify(message, "warning");
      else console.error(message);
    });
    mainSession.reset();
    if (ctx.hasUI) {
      widget.setUICtx(ctx.ui);
      widget.setInputCtx(ctx.ui);
    }
    manager.rebuildTombstones(ctx.sessionManager.getBranch());
    if (!rpcHandle) {
      rpcHandle = registerRpcHandlers({
        events: pi.events,
        pi,
        getCtx: () => currentCtx,
        manager: {
          spawn: spawnTopLevel,
          awaitStartup: (id) => manager.awaitStartup(id),
          getRecord: (id) => manager.getRecord(id),
          abort: (id, cause) => manager.abort(id, cause),
          waitIdle: async () => {
            const active = () => manager.listAgents().some(r => isTopLevelAgent(r) && (r.status === "running" || r.status === "queued"));
            while (active()) await manager.waitForAll();
          },
          consumeResult: (id) => {
            const record = resolveAgentRef(id);
            if (!record || !isTopLevelAgent(record)) throw new RpcError("not_found", "Agent not found");
            if (record.status === "running" || record.status === "queued") throw new RpcError("still_running", "Agent is still running");
            record.resultConsumed = true;
            notifier.cancelNudge(record.id);
          },
        },
      });
      pi.events.emit("agent:ready", {});
      pi.events.emit("agent:settings_loaded", settingsLoadedPayload(ctx.cwd));
    }
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

  pi.on("session_tree", (_event, ctx) => {
    manager.rebuildTombstones(ctx.sessionManager.getBranch(), true);
  });

  pi.on("session_shutdown", async () => {
    rpcHandle?.releaseWaiters();
    rpcHandle?.unsubWaitIdle();
    rpcHandle?.unsubSpawn();
    rpcHandle?.unsubStop();
    rpcHandle?.unsubPing();
    rpcHandle?.unsubConsume();
    rpcHandle = undefined;
    currentCtx = undefined;
    const interrupted = manager.listAgents().filter(record =>
      isTopLevelAgent(record) && (record.status === "running" || record.status === "queued"),
    );
    manager.abortAll();
    for (const record of interrupted) appendRecord(record);
    notifier.dispose();
    viewer.close();
    widget.dispose();
    await manager.dispose(pi);
  });

  function createRuntimeSettings(): {
    reportUsage: boolean; showCost: boolean; showModel: boolean;
    widgetMode: WidgetMode;
    agentMentionMode: AgentMentionMode; defaultJoinMode: JoinMode; backgroundByDefault: boolean;
    toolDescriptionMode: ToolDescriptionMode; strictAgentFiles: boolean;
    setReportUsageFlag(b: boolean): void; setShowCostFlag(b: boolean): void;
    setShowModelFlag(b: boolean): void;
    setWidgetModeFlag(m: WidgetMode): void;
    setAgentMentionMode(m: AgentMentionMode): void; setJoinMode(m: JoinMode): void;
    setBgDefault(b: boolean): void;
    setToolDescMode(m: ToolDescriptionMode): void; setStrictAgentFiles(b: boolean): void;
  } {
    return {
      reportUsage: SETTING_SPECS.reportUsage.default,
      showCost: SETTING_SPECS.showCost.default,
      showModel: SETTING_SPECS.showModel.default,
      widgetMode: SETTING_SPECS.widgetMode.default,
      agentMentionMode: SETTING_SPECS.agentMentions.default,
      defaultJoinMode: SETTING_SPECS.defaultJoinMode.default,
      backgroundByDefault: SETTING_SPECS.backgroundByDefault.default,
      toolDescriptionMode: SETTING_SPECS.toolDescriptionMode.default,
      strictAgentFiles,
      setReportUsageFlag(b) {
        this.reportUsage = b;
        if (!b) pendingUsage.drain();
      },
      setShowCostFlag(b) { this.showCost = b; widget.update(); },
      setShowModelFlag(b) { this.showModel = b; widget.update(); },
      setWidgetModeFlag(m) { this.widgetMode = m; widget.update(); },
      setAgentMentionMode(m) { this.agentMentionMode = m; },
      setJoinMode(m) { this.defaultJoinMode = m; },
      setBgDefault(b) { this.backgroundByDefault = b; },
      setToolDescMode(m) { this.toolDescriptionMode = m; },
      setStrictAgentFiles(b) { this.strictAgentFiles = b; },
    };
  }

  function getWidgetMode(): WidgetMode { return settings.widgetMode; }
  const mainSession = new MainSessionStatus();
  pi.on("agent_start", () => mainSession.agentStart());
  pi.on("agent_end", () => mainSession.agentEnd());
  pi.on("message_end", (event) => mainSession.messageEnd(event.message));
  const viewer = new ConversationViewerOpener({ manager, showCost: isShowCostEnabled, mainSession });
  const widget = new AgentWidget(manager, getWidgetMode, isShowCostEnabled, isShowModelEnabled, viewer);
  function setWidgetMode(m: WidgetMode): void { settings.setWidgetModeFlag(m); }

  const notifier = new CompletionNotifier({ pi, manager, widget, settings });

  function setAgentMentionMode(mode: AgentMentionMode): void { settings.setAgentMentionMode(mode); }
  function isAgentMentionsEnabled(): boolean { return settings.agentMentionMode !== "off"; }

  function setDefaultJoinMode(mode: JoinMode) { settings.setJoinMode(mode); }

  let agentToolRegistered = false;
  function setBackgroundByDefault(b: boolean) {
    settings.setBgDefault(b);
    if (agentToolRegistered) pi.registerTool(withUsageReporting(buildAgentTool(), usageReporting));
  }

  function setToolDescriptionMode(mode: ToolDescriptionMode): void { settings.setToolDescMode(mode); }

  const startBackgroundResume = createBackgroundResume({ pi, manager, notifier, widget, settings });

  pi.on("tool_execution_start", async (_event, ctx) => {
    widget.setUICtx(ctx.ui as UICtx);
    widget.setInputCtx(ctx.ui);
    widget.onTurnStart();
  });

  const appliers: SettingsAppliers = {
    setMaxConcurrent: (n) => manager.setMaxConcurrent(n),
    setMaxConcurrentForeground: (n) => manager.setMaxConcurrentForeground(n),
    setDefaultMaxTurns,
    setGraceTurns,
    setDefaultJoinMode,
    setBackgroundByDefault,
    setScopeModels: setScopeModelsEnabled,
    setStrictAgentFiles: (b) => { strictAgentFiles = b; },
    setToolDescriptionMode: setToolDescriptionMode,
    setAgentMentions: setAgentMentionMode,
    setRememberAgents,
    setWidgetMode: setWidgetMode,
    setOutputTranscript: setOutputTranscriptDefault,
    setWorktreeIsolation: setWorktreeIsolationEnabled,
    setMaxSubagentDepth: setMaxSubagentDepth,
    setReportUsage,
    setShowCost,
    setShowModel,
  };
  const settingsPersist = createSettingsPersistence(appliers, (event, payload) => pi.events.emit(event, payload));
  applyLoadedSettings(appliers);

  const buildAgentTool = () => createAgentTool(pi, {
    manager,
    widget,
    notifier,
    startBackgroundResume,
    reloadCustomAgents,
    settings,
  });
  const agentTool = buildAgentTool();

  const usageReporting = { settings, pendingUsage };

  const registeredAgentTool = withUsageReporting(agentTool, usageReporting);
  pi.registerTool(registeredAgentTool);
  agentToolRegistered = true;

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

  registerAgentControlTools(pi, { manager, notifier, settings, resolveAgentRef, resolveAgentTombstone, usageReporting });
  pi.registerTool(createAgentModelsTool());

  registerAgentsCommand(pi, {
    manager,
    reloadCustomAgents,
    viewer,
    showCost: isShowCostEnabled,
    showModel: isShowModelEnabled,
    showSettings: (ctx) => showSettings(ctx, { cwd: process.cwd(), settingsPersist }),
  });
}
