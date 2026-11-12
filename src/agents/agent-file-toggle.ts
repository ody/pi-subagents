import { existsSync } from "node:fs";
import { join, sep } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { AgentConfig } from "../types.js";
import { parseAgentFrontmatter } from "./custom-agents.js";

export type AgentFileLocation = "project" | "workspace" | "personal";

export const projectAgentsDir = (cwd: string = process.cwd()) => join(cwd, ".pi", "agents");
export const workspaceAgentsDir = (cwd: string = process.cwd()) => join(cwd, ".agents", "agents");
export const personalAgentsDir = () => join(getAgentDir(), "agents");

export function findAgentFile(
  name: string,
  cwd: string = process.cwd(),
): { path: string; location: AgentFileLocation } | undefined {
  const projectPath = join(projectAgentsDir(cwd), `${name}.md`);
  if (existsSync(projectPath)) return { path: projectPath, location: "project" };
  const workspacePath = join(workspaceAgentsDir(cwd), `${name}.md`);
  if (existsSync(workspacePath)) return { path: workspacePath, location: "workspace" };
  const personalPath = join(personalAgentsDir(), `${name}.md`);
  if (existsSync(personalPath)) return { path: personalPath, location: "personal" };
  return undefined;
}

export function locateAgentFile(
  name: string,
  sourcePath: string | undefined,
  cwd: string = process.cwd(),
): { path: string; location: AgentFileLocation } | undefined {
  if (sourcePath && existsSync(sourcePath)) {
    return { path: sourcePath, location: classifyAgentDir(sourcePath, cwd) };
  }
  return findAgentFile(name, cwd);
}

function classifyAgentDir(path: string, cwd: string): AgentFileLocation {
  if (path.startsWith(projectAgentsDir(cwd) + sep)) return "project";
  if (path.startsWith(workspaceAgentsDir(cwd) + sep)) return "workspace";
  return "personal";
}

export type DisableOutcome = "disabled" | "already-disabled" | "no-frontmatter";

const ENABLED_FALSE = /^enabled:[ \t]*false[ \t]*$/;
const FENCE = /^---[ \t]*$/;

function splitFrontmatter(content: string):
  | { lines: string[]; openIdx: number; closeIdx: number; eol: string }
  | undefined {
  const lines = content.split(/(?<=\n)/);
  if (lines.length === 0) return undefined;
  const bom = content.startsWith("\uFEFF");
  const first = (bom ? lines[0].slice(1) : lines[0]).replace(/\r?\n$/, "");
  if (!FENCE.test(first)) return undefined;
  const closeIdx = lines.findIndex((l, i) => i > 0 && FENCE.test(l.replace(/\r?\n$/, "")));
  if (closeIdx === -1) return undefined;
  return { lines, openIdx: 0, closeIdx, eol: lines[0].endsWith("\r\n") ? "\r\n" : "\n" };
}

export function isDisabledContent(content: string): boolean {
  try {
    return parseAgentFrontmatter<Record<string, unknown>>(content).frontmatter.enabled === false;
  } catch {
    return false;
  }
}

export function disableInContent(content: string): { content: string; outcome: DisableOutcome } {
  const block = splitFrontmatter(content);
  if (!block) return { content, outcome: "no-frontmatter" };
  if (isDisabledContent(content)) return { content, outcome: "already-disabled" };
  const lines = [...block.lines];
  lines.splice(1, 0, `enabled: false${block.eol}`);
  return { content: lines.join(""), outcome: "disabled" };
}

export function enableInContent(content: string): { content: string; changed: boolean } {
  const block = splitFrontmatter(content);
  if (!block) return { content, changed: false };
  const kept = block.lines.filter(
    (l, i) => !(i > 0 && i < block.closeIdx && ENABLED_FALSE.test(l.replace(/\r?\n$/, ""))),
  );
  if (kept.length === block.lines.length) return { content, changed: false };
  return { content: kept.join(""), changed: true };
}

export function isEmptyStub(content: string): boolean {
  return content.replace(/\r\n/g, "\n").trim() === "---\n---";
}

function formatToolsField(tools: string[] | undefined): string {
  if (tools === undefined) return "all";
  if (tools.length === 0) return "none";
  return tools.join(", ");
}

export function serializeAgentFile(cfg: AgentConfig): string {
  const fmFields: string[] = [];
  fmFields.push(`description: ${JSON.stringify(cfg.description)}`);
  if (cfg.displayName) fmFields.push(`display_name: ${cfg.displayName}`);
  if (cfg.color) fmFields.push(`color: ${JSON.stringify(cfg.color)}`);
  fmFields.push(`tools: ${formatToolsField(cfg.builtinToolNames)}`);
  if (cfg.model) fmFields.push(`model: ${cfg.model}`);
  if (cfg.thinking) fmFields.push(`thinking: ${cfg.thinking}`);
  if (cfg.maxTurns) fmFields.push(`max_turns: ${cfg.maxTurns}`);
  if (cfg.allowedSubagents !== undefined) {
    fmFields.push(`allowed_subagents: ${cfg.allowedSubagents === "all" ? "all" : cfg.allowedSubagents.join(", ")}`);
  }
  fmFields.push(`prompt_mode: ${cfg.promptMode}`);
  if (cfg.extensions === false) fmFields.push("extensions: false");
  else if (Array.isArray(cfg.extensions)) fmFields.push(`extensions: ${cfg.extensions.join(", ")}`);
  if (cfg.excludeExtensions?.length) fmFields.push(`exclude_extensions: ${cfg.excludeExtensions.join(", ")}`);
  if (cfg.skills === false) fmFields.push("skills: false");
  else if (Array.isArray(cfg.skills)) fmFields.push(`skills: ${cfg.skills.join(", ")}`);
  if (cfg.disallowedTools?.length) fmFields.push(`disallowed_tools: ${cfg.disallowedTools.join(", ")}`);
  if (cfg.inheritContext) fmFields.push("inherit_context: true");
  if (cfg.runInBackground !== undefined) fmFields.push(`run_in_background: ${cfg.runInBackground}`);
  if (cfg.outputTranscript === false) fmFields.push("output_transcript: false");
  if (cfg.isolated) fmFields.push("isolated: true");
  if (cfg.isolation) fmFields.push(`isolation: ${cfg.isolation}`);

  return `---\n${fmFields.join("\n")}\n---\n\n${cfg.systemPrompt}\n`;
}
