
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type ExtensionAPI, type ExtensionCommandContext, getSettingsListTheme } from "@earendil-works/pi-coding-agent";
import { Container, type SettingItem, SettingsList, Spacer, Text } from "@earendil-works/pi-tui";
import { disableInContent, enableInContent, isEmptyStub, locateAgentFile, personalAgentsDir, projectAgentsDir, serializeAgentFile } from "../agents/agent-file-toggle.js";
import { getAgentConfig, getAllTypes } from "../agents/agent-types.js";
import { getModelLabelFromConfig, type ModelRegistry, resolveModel } from "../config/model-resolver.js";
import type { RuntimeSettings } from "../config/runtime-settings.js";
import type { AgentManager } from "../manager/agent-manager.js";
import type { SubagentScheduler } from "../triggers/schedule.js";
import type { AgentConfig, AgentRecord, ViewerMarkdownMode } from "../types.js";
import { formatDuration, getDisplayName } from "./agent-format.js";
import { buildAgentTree } from "./agent-tree.js";
import { ConversationViewer, VIEWPORT_HEIGHT_PCT } from "./conversation-viewer.js";
import { showSchedulesMenu } from "./schedule-menu.js";
import { selectItem } from "./select-item.js";

type UserAgentFile = NonNullable<ReturnType<typeof locateAgentFile>>;

export interface AgentsCommandDeps {
  manager: Pick<AgentManager, "listAgents" | "getActivity" | "abort" | "steer">;
  scheduler: SubagentScheduler;
  reloadCustomAgents: (strict?: boolean) => void;
  settings: Readonly<Pick<RuntimeSettings, "showCost" | "viewerMarkdown">>;
  chooseViewerMarkdown: (mode: ViewerMarkdownMode, ctx?: ExtensionCommandContext) => void;
  showSettings: (ctx: ExtensionCommandContext) => Promise<void>;
}

export function detailMenuOptions(cfg: AgentConfig, hasFile: boolean): string[] {
  const isDefault = cfg.isDefault === true;
  const disabled = cfg.enabled === false;
  if (cfg.source === "skill") {
    return disabled ? ["Eject (export as .md)", "Back"] : ["Eject (export as .md)", "Disable", "Back"];
  }
  if (disabled && hasFile) {
    return isDefault
      ? ["Enable", "Edit", "Reset to default", "Delete", "Back"]
      : ["Enable", "Edit", "Delete", "Back"];
  }
  if (isDefault && !hasFile) return ["Eject (export as .md)", "Disable", "Back"];
  if (isDefault && hasFile) return ["Edit", "Disable", "Reset to default", "Delete", "Back"];
  return ["Edit", "Disable", "Delete", "Back"];
}

export function registerAgentsCommand(pi: ExtensionAPI, deps: AgentsCommandDeps): void {
  const { manager, scheduler, reloadCustomAgents, settings, chooseViewerMarkdown, showSettings } = deps;

  function getModelLabel(type: string, registry?: ModelRegistry): string {
    const cfg = getAgentConfig(type);
    if (!cfg?.model) return "inherit";
    const label = getModelLabelFromConfig(cfg.model);
    if (!registry) return label;
    const resolved = resolveModel(cfg.model, registry);
    if (typeof resolved === "string") return `${label} (unavailable, fallback: inherit)`;
    const resolvedFull = `${resolved.provider}/${resolved.id}`;
    const norm = (s: string) => s.toLowerCase().replace(/\./g, "-").replace(/-\d{8}$/, "");
    if (norm(cfg.model) === norm(resolvedFull)) return label;
    return `${label} (→ ${resolvedFull.replace(/-\d{8}$/, "")})`;
  }

  async function showAgentsMenu(ctx: ExtensionCommandContext) {
    reloadCustomAgents();
    const allNames = getAllTypes();

    const options: string[] = [];

    const agents = manager.listAgents();
    if (agents.length > 0) {
      const running = agents.filter(a => a.status === "running" || a.status === "queued").length;
      const done = agents.filter(a => a.status === "completed" || a.status === "steered").length;
      options.push(`Agents (${agents.length}) — ${running} running, ${done} done`);
    }

    if (allNames.length > 0) {
      options.push(`Agent types (${allNames.length})`);
    }

    if (scheduler.isActive()) {
      const jobCount = scheduler.list().length;
      options.push(`Scheduled jobs (${jobCount})`);
    }

    options.push("Settings");

    const noAgentsMsg = allNames.length === 0 && agents.length === 0
      ? `No agents found. Define them as .md files in ${projectAgentsDir()} (project) or ${personalAgentsDir()} (personal).\n\n`
      : "";

    if (noAgentsMsg) {
      ctx.ui.notify(noAgentsMsg, "info");
    }

    const choice = await ctx.ui.select("Agents", options);
    if (!choice) return;

    if (choice.startsWith("Agents (")) {
      await showRunningAgents(ctx);
      await showAgentsMenu(ctx);
    } else if (choice.startsWith("Agent types (")) {
      await showAllAgentsList(ctx);
      await showAgentsMenu(ctx);
    } else if (choice.startsWith("Scheduled jobs (")) {
      await showSchedulesMenu(ctx, scheduler);
      await showAgentsMenu(ctx);
    } else if (choice === "Settings") {
      await showSettings(ctx);
      await showAgentsMenu(ctx);
    }
  }

  async function showAllAgentsList(ctx: ExtensionCommandContext) {
    const allNames = getAllTypes();
    if (allNames.length === 0) {
      ctx.ui.notify("No agents.", "info");
      return;
    }

    const sourceIndicator = (cfg: AgentConfig | undefined) => {
      const disabled = cfg?.enabled === false;
      if (cfg?.source === "project") return disabled ? "✕• " : "•  ";
      if (cfg?.source === "global") return disabled ? "✕◦ " : "◦  ";
      if (cfg?.source === "skill") return disabled ? "✕▹ " : "▹  ";
      if (disabled) return "✕  ";
      return "   ";
    };

    const items: SettingItem[] = allNames.map(name => {
      const cfg = getAgentConfig(name);
      const disabled = cfg?.enabled === false;
      const model = getModelLabel(name, ctx.modelRegistry);
      return {
        id: name,
        label: `${sourceIndicator(cfg)}${name}`,
        currentValue: model,
        description: disabled ? "(disabled)" : (cfg?.description ?? name),
        values: [model],
      };
    });

    const hasCustom = allNames.some(n => { const c = getAgentConfig(n); return c && !c.isDefault && c.enabled !== false; });
    const hasDisabled = allNames.some(n => getAgentConfig(n)?.enabled === false);
    const legendParts: string[] = [];
    if (hasCustom) legendParts.push("• = project  ◦ = global  ▹ = skill");
    if (hasDisabled) legendParts.push("✕ = disabled");

    const selected = await ctx.ui.custom<string | undefined>((_tui, _theme, _kb, done) => {
      const slTheme = getSettingsListTheme();
      const list = new SettingsList(
        items,
        Math.min(items.length, 12),
        slTheme,
        id => done(id),
        () => done(undefined),
      );
      const container = new Container();
      container.addChild(new Text("Agent types", 0, 0));
      if (legendParts.length) container.addChild(new Text(slTheme.hint(legendParts.join("  ")), 0, 0));
      container.addChild(new Spacer(1));
      container.addChild(list);
      return {
        render: (w: number) => container.render(w),
        invalidate: () => container.invalidate(),
        handleInput: (data: string) => list.handleInput?.(data),
      };
    });

    if (selected && getAgentConfig(selected)) {
      await showAgentDetail(ctx, selected);
      await showAllAgentsList(ctx);
    }
  }

  async function showRunningAgents(ctx: ExtensionCommandContext) {
    const nodes = buildAgentTree({
      records: manager.listAgents(),
      includeMain: false,
    });
    if (nodes.length === 0) {
      ctx.ui.notify("No agents.", "info");
      return;
    }

    const node = await selectItem(ctx.ui, "Agents", nodes, n => {
      const indent = "  ".repeat(n.depth);
      if (n.kind === "main") return `${indent}main`;
      const a = n.record;
      const dn = getDisplayName(a);
      const dur = formatDuration(a.startedAt, a.completedAt);
      const detached = n.orphan ? " · detached" : "";
      return `${indent}${dn} (${a.description}) · ${a.toolUses} tools · ${a.status} · ${dur}${detached}`;
    });
    if (!node) return;

    if (node.kind === "agent") await viewAgentConversation(ctx, node.record);
    await showRunningAgents(ctx);
  }

  async function viewAgentConversation(ctx: ExtensionCommandContext, record: AgentRecord) {
    if (!record.session) {
      ctx.ui.notify(`Agent is ${record.status === "queued" ? "queued" : "expired"} — no session available.`, "info");
      return;
    }

    const session = record.session;
    const activity = manager.getActivity(record.id);

    await ctx.ui.custom<undefined>(
      (tui, theme, keybindings, done) => {
        return new ConversationViewer(tui, session, record, activity, theme, done, () => {
          if (manager.abort(record.id)) {
            ctx.ui.notify(`Stopped "${record.description}".`, "info");
          }
        }, keybindings, (message: string) => manager.steer(record.id, message), settings.showCost, () => settings.viewerMarkdown, (mode) => chooseViewerMarkdown(mode, ctx));
      },
      {
        overlay: true,
        overlayOptions: { anchor: "center", width: "90%", maxHeight: `${VIEWPORT_HEIGHT_PCT}%` },
      },
    );
  }

  async function showAgentDetail(ctx: ExtensionCommandContext, name: string) {
    const cfg = getAgentConfig(name);
    if (!cfg) {
      ctx.ui.notify(`Agent config not found for "${name}".`, "warning");
      return;
    }

    const file = locateUserAgentFile(name, cfg);

    const choice = await ctx.ui.select(name, detailMenuOptions(cfg, file !== undefined));
    if (!choice || choice === "Back") return;

    if (choice === "Edit" && file) {
      await editAgentFile(ctx, name, file);
    } else if (choice === "Delete") {
      if (file) await deleteAgentFile(ctx, name, file);
    } else if (choice === "Reset to default" && file) {
      await resetAgentToDefault(ctx, name, file);
    } else if (choice.startsWith("Eject")) {
      await ejectAgent(ctx, name, cfg);
    } else if (choice === "Disable") {
      await disableAgent(ctx, name);
    } else if (choice === "Enable") {
      await enableAgent(ctx, name);
    }
  }

  function locateUserAgentFile(name: string, cfg: AgentConfig | undefined) {
    return cfg?.source === "skill" ? undefined : locateAgentFile(name, cfg?.sourcePath);
  }

  async function editAgentFile(ctx: ExtensionCommandContext, name: string, file: UserAgentFile) {
    const content = readFileSync(file.path, "utf-8");
    const edited = await ctx.ui.editor(`Edit ${name}`, content);
    if (edited !== undefined && edited !== content) {
      writeFileSync(file.path, edited, "utf-8");
      reloadCustomAgents();
      ctx.ui.notify(`Updated ${file.path}`, "info");
    }
  }

  async function deleteAgentFile(ctx: ExtensionCommandContext, name: string, file: UserAgentFile) {
    const confirmed = await ctx.ui.confirm("Delete agent", `Delete ${name} from ${file.location} (${file.path})?`);
    if (confirmed) {
      unlinkSync(file.path);
      reloadCustomAgents();
      ctx.ui.notify(`Deleted ${file.path}`, "info");
    }
  }

  async function resetAgentToDefault(ctx: ExtensionCommandContext, name: string, file: UserAgentFile) {
    const confirmed = await ctx.ui.confirm("Reset to default", `Delete override ${file.path} and restore embedded default?`);
    if (confirmed) {
      unlinkSync(file.path);
      reloadCustomAgents();
      ctx.ui.notify(`Restored default ${name}`, "info");
    }
  }

  async function ejectAgent(ctx: ExtensionCommandContext, name: string, cfg: AgentConfig) {
    const location = await ctx.ui.select("Choose location", [
      "Project (.pi/agents/)",
      `Personal (${personalAgentsDir()})`,
    ]);
    if (!location) return;

    const targetDir = location.startsWith("Project") ? projectAgentsDir() : personalAgentsDir();
    mkdirSync(targetDir, { recursive: true });

    const targetPath = join(targetDir, `${name}.md`);
    if (existsSync(targetPath)) {
      const overwrite = await ctx.ui.confirm("Overwrite", `${targetPath} already exists. Overwrite?`);
      if (!overwrite) return;
    }

    const content = cfg.source === "skill" && cfg.sourcePath ? readFileSync(cfg.sourcePath, "utf-8") : serializeAgentFile(cfg);

    writeFileSync(targetPath, content, "utf-8");
    reloadCustomAgents();
    ctx.ui.notify(`Ejected ${name} to ${targetPath}`, "info");
  }

  async function disableAgent(ctx: ExtensionCommandContext, name: string) {
    const file = locateUserAgentFile(name, getAgentConfig(name));
    if (file) {
      const content = readFileSync(file.path, "utf-8");
      const { content: updated, outcome } = disableInContent(content);
      if (outcome === "already-disabled") {
        ctx.ui.notify(`${name} is already disabled.`, "info");
        return;
      }
      if (outcome === "no-frontmatter") {
        ctx.ui.notify(`Cannot disable ${name}: ${file.path} has no frontmatter block.`, "error");
        return;
      }
      writeFileSync(file.path, updated, "utf-8");
      reloadCustomAgents();
      ctx.ui.notify(`Disabled ${name} (${file.path})`, "info");
      return;
    }

    const location = await ctx.ui.select("Choose location", [
      "Project (.pi/agents/)",
      `Personal (${personalAgentsDir()})`,
    ]);
    if (!location) return;

    const targetDir = location.startsWith("Project") ? projectAgentsDir() : personalAgentsDir();
    mkdirSync(targetDir, { recursive: true });

    const targetPath = join(targetDir, `${name}.md`);
    writeFileSync(targetPath, "---\nenabled: false\n---\n", "utf-8");
    reloadCustomAgents();
    ctx.ui.notify(`Disabled ${name} (${targetPath})`, "info");
  }

  async function enableAgent(ctx: ExtensionCommandContext, name: string) {
    const file = locateUserAgentFile(name, getAgentConfig(name));
    if (!file) return;

    const content = readFileSync(file.path, "utf-8");
    const { content: updated, changed } = enableInContent(content);
    if (!changed && !isEmptyStub(updated)) {
      ctx.ui.notify(`${name} is not disabled in ${file.path}.`, "info");
      return;
    }

    if (isEmptyStub(updated)) {
      unlinkSync(file.path);
      reloadCustomAgents();
      ctx.ui.notify(`Enabled ${name} (removed ${file.path})`, "info");
    } else {
      writeFileSync(file.path, updated, "utf-8");
      reloadCustomAgents();
      ctx.ui.notify(`Enabled ${name} (${file.path})`, "info");
    }
  }

  pi.registerCommand("agents", {
    description: "Manage agents",
    handler: async (_args, ctx) => { await showAgentsMenu(ctx); },
  });
}
