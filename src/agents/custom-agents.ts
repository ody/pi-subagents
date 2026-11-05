import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { getAgentDir, parseFrontmatter } from "@earendil-works/pi-coding-agent";
import type { AgentConfig, IsolationMode, ThinkingLevel } from "../types.js";
import { BUILTIN_TOOL_NAMES } from "./agent-types.js";

const RESERVED_IN_TYPE = ":";

export function loadCustomAgents(cwd: string, strict = false): Map<string, AgentConfig> {
  const globalDir = join(getAgentDir(), "agents");
  const workspaceProjectDir = join(cwd, ".agents", "agents");
  const projectDir = join(cwd, ".pi", "agents");

  const agents = new Map<string, AgentConfig>();
  loadSkillAgents(join(getAgentDir(), "skills"), agents, strict);
  loadFromDir(globalDir, agents, "global", strict);
  loadFromDir(workspaceProjectDir, agents, "project", strict);
  loadFromDir(projectDir, agents, "project", strict);

  warnedLastLoad = warnedThisLoad;
  warnedThisLoad = new Set();
  return agents;
}

function loadSkillAgents(root: string, agents: Map<string, AgentConfig>, strict: boolean): void {
  const skillAgents = new Map<string, AgentConfig>();
  const seen = new Set<string>();
  const queue = [root];
  while (queue.length > 0) {
    const dir = queue.shift() as string;
    let real: string;
    try {
      real = realpathSync(dir);
    } catch {
      continue;
    }
    if (seen.has(real)) continue;
    seen.add(real);

    if (dir !== root && existsSync(join(dir, "SKILL.md"))) {
      const loaded = new Map<string, AgentConfig>();
      loadFromDir(join(dir, "agents"), loaded, "skill", strict);
      for (const [name, cfg] of loaded) {
        const prior = skillAgents.get(name);
        if (prior) warnIfNew(`Agent "${name}" is shipped by two skills; ${cfg.sourcePath} overrides ${prior.sourcePath}`);
        skillAgents.set(name, cfg);
      }
      continue;
    }

    let entries: string[];
    try {
      entries = readdirSync(dir).sort();
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.startsWith(".") || entry === "node_modules") continue;
      const path = join(dir, entry);
      try {
        if (statSync(path).isDirectory()) queue.push(path);
      } catch {
      }
    }
  }
  for (const [name, cfg] of skillAgents) agents.set(name, cfg);
}

function loadFromDir(dir: string, agents: Map<string, AgentConfig>, source: "project" | "global" | "skill", strict: boolean): void {
  if (!existsSync(dir)) return;

  let files: string[];
  try {
    files = readdirSync(dir).filter(f => f.endsWith(".md"));
  } catch {
    return;
  }

  for (const file of files) {
    const filenameType = basename(file, ".md");

    const path = join(dir, file);

    const parsed = readAgentFile(path, strict);
    if (!parsed) {
      warnSkippedOverride(filenameType, agents);
      continue;
    }
    const { frontmatter: fm, body } = parsed;

    const declared = str(fm.name)?.trim();
    if (declared?.includes(RESERVED_IN_TYPE)) {
      warnIfNew(
        `Agent file ${path} declares name "${declared}", which contains "${RESERVED_IN_TYPE}" — reserved for `
        + "plugin-scoped identifiers. Rename it, or move the label to `display_name:`. Skipping.",
      );
      continue;
    }
    const name = declared || filenameType;

    const { builtinToolNames, extSelectors } = parseToolsField(fm.tools);

    agents.set(name, {
      name,
      displayName: str(fm.display_name),
      color: str(fm.color),
      description: str(fm.description) ?? name,
      builtinToolNames,
      extSelectors,
      disallowedTools: csvListOptional(fm.disallowed_tools),
      extensions: inheritField(fm.extensions ?? fm.inherit_extensions),
      excludeExtensions: csvListOptional(fm.exclude_extensions),
      skills: inheritField(fm.skills ?? fm.inherit_skills),
      model: str(fm.model),
      thinking: str(fm.thinking) as ThinkingLevel | undefined,
      maxTurns: nonNegativeInt(fm.max_turns),
      persistSession: fm.persist_session != null ? fm.persist_session === true : undefined,
      outputTranscript: fm.output_transcript != null ? fm.output_transcript !== false : undefined,
      sessionDir: str(fm.session_dir),
      allowedSubagents: parseAllowedSubagents(fm.allowed_subagents),
      systemPrompt: body.trim(),
      promptMode: fm.prompt_mode === "append" ? "append" : "replace",
      inheritContext: fm.inherit_context != null ? fm.inherit_context === true : undefined,
      runInBackground: fm.run_in_background != null ? fm.run_in_background === true : undefined,
      isolated: fm.isolated != null ? fm.isolated === true : undefined,
      isolation: parseIsolation(fm.isolation),
      enabled: fm.enabled !== false,
      source,
      sourcePath: path,
    });
  }
}

export function parseAgentFrontmatter<T extends Record<string, unknown>>(content: string): { frontmatter: T; body: string } {
  return parseFrontmatter<T>(content.startsWith("\uFEFF") ? content.slice(1) : content);
}

function readAgentFile(path: string, strict: boolean): { frontmatter: Record<string, unknown>; body: string } | undefined {
  try {
    return parseAgentFrontmatter<Record<string, unknown>>(readFileSync(path, "utf-8"));
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    if (strict) throw new Error(`${path}: ${reason}`);
    warnIfNew(`Skipping agent file ${path}: ${reason}`);
    return undefined;
  }
}

function warnSkippedOverride(name: string, agents: Map<string, AgentConfig>): void {
  const surviving = agents.get(name);
  if (!surviving?.sourcePath || surviving.enabled === false) return;
  warnIfNew(`Agent "${name}" now loads from ${surviving.sourcePath} instead`);
}

let warnedLastLoad = new Set<string>();
let warnedThisLoad = new Set<string>();

function warnIfNew(message: string): void {
  warnedThisLoad.add(message);
  if (warnedLastLoad.has(message)) return;
  console.warn(`[pi-subagents] ${message}`);
}

function str(val: unknown): string | undefined {
  return typeof val === "string" ? val : undefined;
}

function nonNegativeInt(val: unknown): number | undefined {
  return typeof val === "number" && val >= 0 ? val : undefined;
}

function parseCsvField(val: unknown): string[] | undefined {
  if (val === undefined || val === null) return undefined;
  const s = String(val).trim();
  if (!s || s === "none") return undefined;
  const items = s.split(",").map(t => t.trim()).filter(Boolean);
  return items.length > 0 ? items : undefined;
}

function parseAllowedSubagents(val: unknown): "all" | string[] | undefined {
  if (typeof val === "boolean") return val ? "all" : undefined;
  const items = parseCsvField(val);
  if (!items) return undefined;
  return items.some(i => i === "*" || i.toLowerCase() === "all") ? "all" : items;
}

function csvList(val: unknown, defaults: string[]): string[] {
  if (val === undefined || val === null) return defaults;
  return parseCsvField(val) ?? [];
}

function parseToolsField(val: unknown): { builtinToolNames: string[]; extSelectors: string[] | undefined } {
  const entries = csvList(val, BUILTIN_TOOL_NAMES);
  const isWildcard = (e: string) => e === "*" || e.toLowerCase() === "all";
  const hasWildcard = entries.some(isWildcard);
  const plain = entries.filter(e => !isWildcard(e) && !e.startsWith("ext:"));
  const extEntries = entries.filter(e => e.startsWith("ext:"));
  return {
    builtinToolNames: hasWildcard ? [...new Set([...BUILTIN_TOOL_NAMES, ...plain])] : plain,
    extSelectors: extEntries.length > 0 ? extEntries : undefined,
  };
}

function csvListOptional(val: unknown): string[] | undefined {
  return parseCsvField(val);
}

function parseIsolation(val: unknown): IsolationMode | undefined {
  if (val === "worktree") return "worktree";
  if (val === "off" || val === "none" || val === "no" || val === false) return "off";
  return undefined;
}

function inheritField(val: unknown): true | string[] | false {
  if (val === undefined || val === null || val === true) return true;
  if (val === false || val === "none") return false;
  const items = csvList(val, []);
  return items.length > 0 ? items : false;
}
