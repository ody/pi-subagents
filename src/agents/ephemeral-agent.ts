import { randomBytes } from "node:crypto";
import type { AgentConfig } from "../types.js";
import { BUILTIN_TOOL_NAMES } from "./agent-types.js";

export const EPHEMERAL_TYPE_PREFIX = "ephemeral-";
export const EPHEMERAL_DISPLAY_NAME = "Agent";

export interface EphemeralParams {
  description: string;
  tools?: string[];
  disallowed_tools?: string[];
  extensions?: boolean | string[];
  exclude_extensions?: string[];
  skills?: boolean | string[];
  allowed_subagents?: "all" | string[];
  prompt_mode?: "append" | "replace";
  isolated?: boolean;
}

export const EPHEMERAL_PARAM_NAMES = [
  "tools",
  "disallowed_tools",
  "extensions",
  "exclude_extensions",
  "skills",
  "allowed_subagents",
  "prompt_mode",
] as const;

export interface BuiltEphemeralAgent {
  type: string;
  config: AgentConfig;
  supplied: Partial<AgentConfig>;
  explicitTools: string[] | undefined;
}

export function mintEphemeralType(): string {
  return `${EPHEMERAL_TYPE_PREFIX}${randomBytes(4).toString("hex")}`;
}

export function namedAgentParamConflict(params: Partial<Record<(typeof EPHEMERAL_PARAM_NAMES)[number], unknown>>): string | undefined {
  const given = EPHEMERAL_PARAM_NAMES.find(name => params[name] !== undefined);
  if (!given) return undefined;
  return `The "${given}" parameter applies only to an ephemeral agent. Omit subagent_type to build an agent from the parameters, or drop "${given}" to run the named agent as defined.`;
}

export function ephemeralIsolationConflict(params: EphemeralParams): string | undefined {
  if (params.isolated !== true) return undefined;
  if (params.extensions !== undefined) return 'Cannot combine isolated: true with "extensions" — an isolated agent loads no extensions.';
  if (params.skills !== undefined) return 'Cannot combine isolated: true with "skills" — an isolated agent loads no skills.';
  if (params.tools?.some(entry => entry.startsWith("ext:"))) {
    return 'Cannot combine isolated: true with an ext: entry in "tools" — an isolated agent loads no extensions.';
  }
  return undefined;
}

function parseTools(entries: string[]): { builtinToolNames: string[]; explicit: string[]; extSelectors: string[] | undefined } {
  const items = entries.map(entry => entry.trim()).filter(Boolean).filter(entry => entry.toLowerCase() !== "none");
  const wildcard = items.some(entry => entry === "*" || entry.toLowerCase() === "all");
  const plain = items.filter(entry => entry !== "*" && entry.toLowerCase() !== "all" && !entry.startsWith("ext:"));
  const ext = items.filter(entry => entry.startsWith("ext:"));
  return {
    builtinToolNames: wildcard ? [...new Set([...BUILTIN_TOOL_NAMES, ...plain])] : plain,
    explicit: plain,
    extSelectors: ext.length > 0 ? ext : undefined,
  };
}

export function buildEphemeralAgent(params: EphemeralParams): BuiltEphemeralAgent {
  const type = mintEphemeralType();
  const supplied: Partial<AgentConfig> = {};
  const tools = params.tools === undefined ? undefined : parseTools(params.tools);
  if (tools) {
    supplied.builtinToolNames = tools.builtinToolNames;
    supplied.extSelectors = tools.extSelectors ?? [];
  }
  if (params.disallowed_tools !== undefined) supplied.disallowedTools = params.disallowed_tools;
  if (params.extensions !== undefined) supplied.extensions = params.extensions;
  if (params.exclude_extensions !== undefined) supplied.excludeExtensions = params.exclude_extensions;
  if (params.skills !== undefined) supplied.skills = params.skills;
  if (params.allowed_subagents !== undefined) supplied.allowedSubagents = params.allowed_subagents;

  const config: AgentConfig = {
    name: type,
    displayName: EPHEMERAL_DISPLAY_NAME,
    description: params.description,
    builtinToolNames: tools?.builtinToolNames ?? [...BUILTIN_TOOL_NAMES],
    extSelectors: tools?.extSelectors,
    disallowedTools: params.disallowed_tools,
    extensions: params.extensions ?? true,
    excludeExtensions: params.exclude_extensions,
    skills: params.skills ?? true,
    allowedSubagents: params.allowed_subagents ?? [],
    systemPrompt: "",
    promptMode: params.prompt_mode ?? "append",
    persistSession: false,
  };
  return { type, config, supplied, explicitTools: tools?.explicit };
}
