
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type ExtensionAPI, type ExtensionCommandContext, getSettingsListTheme } from "@earendil-works/pi-coding-agent";
import { Container, type SettingItem, SettingsList, Spacer, Text } from "@earendil-works/pi-tui";
import { disableInContent, enableInContent, isEmptyStub, locateAgentFile, personalAgentsDir, projectAgentsDir, serializeAgentFile } from "../agents/agent-file-toggle.js";
import { getAgentConfig, getAllTypes } from "../agents/agent-types.js";
import { getModelLabelFromConfig } from "../config/model-resolver.js";
import { resolveModelMatch } from "../config/model-scope.js";
import type { AgentManager } from "../manager/agent-manager.js";
import type { AgentConfig, AgentRecord, AgentTombstone } from "../types.js";
import { buildAgentTree } from "./agent-tree.js";
import { selectAgentRow } from "./agents-list.js";
import type { ConversationViewerOpener } from "./conversation-viewer-opener.js";

type UserAgentFile = NonNullable<ReturnType<typeof locateAgentFile>>;

export interface AgentsCommandDeps {
  manager: Pick<AgentManager, "listAgents" | "listTombstones" | "getActivity">;
  showCost: () => boolean;
  showModel: () => boolean;
  reloadCustomAgents: (strict?: boolean) => void;
  viewer: Pick<ConversationViewerOpener, "open">;
  showSettings: (ctx: ExtensionCommandContext) => Promise<void>;
}

export function detailMenuOptions(cfg: AgentConfig, hasFile: boolean): string[] {
  const disabled = cfg.enabled === false;
  if (cfg.source === "skill") {
    return disabled ? ["Eject (export as .md)", "Back"] : ["Eject (export as .md)", "Disable", "Back"];
  }
  if (disabled && hasFile) return ["Enable", "Edit", "Delete", "Back"];
  return ["Edit", "Disable", "Delete", "Back"];
}

function historyRows(agents: readonly AgentRecord[], entries: readonly AgentTombstone[]): AgentTombstone[] {
  const live = new Set(agents.map(agent => agent.id));
  return entries.filter(entry => !live.has(entry.id)).sort((a, b) => b.completedAt - a.completedAt);
}

function agentsMenuOptions(agents: AgentRecord[], historyCount: number, typeCount: number): string[] {
  const options: string[] = [];
  if (agents.length > 0 || historyCount > 0) {
    const running = agents.filter(a => a.status === "running" || a.status === "queued").length;
    const done = agents.filter(a => a.status === "completed" || a.status === "steered").length;
    const history = historyCount > 0 ? ` · ${historyCount} in history` : "";
    options.push(`Agents (${agents.length}) — ${running} running, ${done} done${history}`);
  }
  if (typeCount > 0) options.push(`Agent types (${typeCount})`);
  options.push("Settings");
  return options;
}

const SOURCE_MARKS: Record<NonNullable<AgentConfig["source"]>, string> = { project: "•", global: "◦", skill: "▹" };

function sourceIndicator(cfg: AgentConfig | undefined): string {
  const disabled = cfg?.enabled === false;
  const mark = cfg?.source ? SOURCE_MARKS[cfg.source] : undefined;
  if (!mark) return disabled ? "✕  " : "   ";
  return disabled ? `✕${mark} ` : `${mark}  `;
}

export function modelLabelFor(
  cfg: AgentConfig | undefined,
  env?: { cwd: string; modelRegistry: Parameters<typeof resolveModelMatch>[1]["modelRegistry"] },
): string {
  const input = cfg?.model?.trim();
  if (!input) return "inherit";
  const label = getModelLabelFromConfig(input);
  if (!env) return label;
  const match = resolveModelMatch(input, env);
  if (match.kind !== "resolved") return `${label} (unavailable, fallback: inherit)`;
  const resolvedKey = `${match.model.provider}/${match.model.id}`;
  const normalize = (value: string) => value.toLowerCase().replace(/\./g, "-");
  if (normalize(input) === normalize(resolvedKey)) return label;
  return `${label} (→ ${resolvedKey})`;
}

function agentLegendParts(configs: (AgentConfig | undefined)[]): string[] {
  const legendParts: string[] = [];
  if (configs.some(c => c && c.enabled !== false)) legendParts.push("• = project  ◦ = global  ▹ = skill");
  if (configs.some(c => c?.enabled === false)) legendParts.push("✕ = disabled");
  return legendParts;
}

export function registerAgentsCommand(pi: ExtensionAPI, deps: AgentsCommandDeps): void {
  const { manager, reloadCustomAgents, viewer, showSettings, showCost, showModel } = deps;

  async function showAgentsMenu(ctx: ExtensionCommandContext) {
    reloadCustomAgents();
    const allNames = getAllTypes();

    const agents = manager.listAgents();
    const history = historyRows(agents, manager.listTombstones());
    const options = agentsMenuOptions(agents, history.length, allNames.length);

    const noAgentsMsg = allNames.length === 0 && agents.length === 0 && history.length === 0
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

    const items: SettingItem[] = allNames.map(name => {
      const cfg = getAgentConfig(name);
      const disabled = cfg?.enabled === false;
      const model = modelLabelFor(cfg, { cwd: ctx.cwd, modelRegistry: ctx.modelRegistry });
      return {
        id: name,
        label: `${sourceIndicator(cfg)}${name}`,
        currentValue: model,
        description: disabled ? "(disabled)" : (cfg?.description ?? name),
        values: [model],
      };
    });

    const legendParts = agentLegendParts(allNames.map(n => getAgentConfig(n)));

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
    const agents = manager.listAgents();
    const nodes = buildAgentTree(agents);
    const history = historyRows(agents, manager.listTombstones());
    if (nodes.length === 0 && history.length === 0) {
      ctx.ui.notify("No agents.", "info");
      return;
    }

    const agent = await selectAgentRow(ctx.ui, nodes, {
      getActivity: id => manager.getActivity(id),
      showCost: showCost(),
      showModel: showModel(),
    }, history);
    if (!agent) return;

    await viewer.open(ctx.ui, agent);
    await showRunningAgents(ctx);
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

    const actions: Record<string, (() => unknown) | undefined> = {
      Eject: () => ejectAgent(ctx, name, cfg),
      Disable: () => disableAgent(ctx, name),
      Enable: () => enableAgent(ctx, name),
      Edit: file && (() => editAgentFile(ctx, name, file)),
      Delete: file && (() => deleteAgentFile(ctx, name, file)),
    };
    await actions[choice.startsWith("Eject") ? "Eject" : choice]?.();
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

  function enableAgent(ctx: ExtensionCommandContext, name: string) {
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
