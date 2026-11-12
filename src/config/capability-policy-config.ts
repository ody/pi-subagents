import { existsSync, readFileSync } from "node:fs";
import { globalSettingsPath, projectSettingsPath } from "../config/settings-paths.js";

export interface PolicyList {
  allow?: string[];
  deny?: string[];
}

export interface PolicyScope {
  tools?: PolicyList;
  extensions?: PolicyList;
  skills?: PolicyList;
}

export interface PolicyEventPayload {
  global: PolicyScope;
  project: PolicyScope;
  ephemeralNesting: boolean;
  malformed?: string[];
}

export interface LoadedPolicy {
  global: PolicyScope;
  project: PolicyScope;
  ephemeralNesting: boolean;
  problems: string[];
}

interface ParsedPolicyFile {
  scope: PolicyScope;
  ephemeralNesting?: boolean;
}

const SCOPE_KEYS = ["tools", "extensions", "skills"] as const;
const LIST_KEYS = ["allow", "deny"] as const;
const POLICY_KEYS: ReadonlySet<string> = new Set([...SCOPE_KEYS, "ephemeralNesting"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function parseList(raw: unknown, where: string, denyList: boolean, problems: string[]): string[] | undefined {
  if (!Array.isArray(raw)) {
    problems.push(`${where} must be an array of strings`);
    return undefined;
  }
  const out: string[] = [];
  for (const entry of raw) {
    if (typeof entry !== "string" || !entry.trim()) {
      problems.push(`${where} has an entry that is not a non-empty string`);
      return undefined;
    }
    if (denyList && entry.trim() === "*") {
      problems.push(`${where} contains "*", which is valid only in an allow list`);
      return undefined;
    }
    out.push(entry.trim());
  }
  return out;
}

function parseScopeEntry(raw: unknown, where: string, problems: string[]): PolicyList | undefined {
  if (!isRecord(raw)) {
    problems.push(`${where} must be an object with allow and deny lists`);
    return undefined;
  }
  const list: PolicyList = {};
  for (const key of Object.keys(raw)) {
    if (!(LIST_KEYS as readonly string[]).includes(key)) problems.push(`${where}.${key} is not a known key`);
  }
  for (const key of LIST_KEYS) {
    if (raw[key] === undefined) continue;
    const parsed = parseList(raw[key], `${where}.${key}`, key === "deny", problems);
    if (parsed) list[key] = parsed;
  }
  return list;
}

function parsePolicy(raw: unknown, file: string, problems: string[]): ParsedPolicyFile {
  const scope: PolicyScope = {};
  if (raw === undefined) return { scope };
  if (!isRecord(raw)) {
    problems.push(`${file}: policy must be an object`);
    return { scope };
  }
  for (const key of Object.keys(raw)) {
    if (!POLICY_KEYS.has(key)) problems.push(`${file}: policy.${key} is not a known key`);
  }
  for (const key of SCOPE_KEYS) {
    if (raw[key] === undefined) continue;
    const parsed = parseScopeEntry(raw[key], `${file}: policy.${key}`, problems);
    if (parsed) scope[key] = parsed;
  }
  let ephemeralNesting: boolean | undefined;
  if (raw.ephemeralNesting !== undefined) {
    if (typeof raw.ephemeralNesting === "boolean") ephemeralNesting = raw.ephemeralNesting;
    else problems.push(`${file}: policy.ephemeralNesting must be a boolean`);
  }
  return { scope, ephemeralNesting };
}

function readPolicyFile(path: string, problems: string[]): ParsedPolicyFile {
  if (!existsSync(path)) return { scope: {} };
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf-8"));
  } catch (err) {
    problems.push(`${path}: cannot be parsed (${describeError(err)})`);
    return { scope: {} };
  }
  if (!isRecord(parsed)) {
    problems.push(`${path}: must contain a JSON object`);
    return { scope: {} };
  }
  return parsePolicy(parsed.policy, path, problems);
}

export function loadCapabilityPolicy(cwd: string): LoadedPolicy {
  const problems: string[] = [];
  const global = readPolicyFile(globalSettingsPath(), problems);
  const project = readPolicyFile(projectSettingsPath(cwd), problems);
  return {
    global: global.scope,
    project: project.scope,
    ephemeralNesting: global.ephemeralNesting !== false && project.ephemeralNesting !== false,
    problems,
  };
}

export function policyEventPayload(cwd: string): PolicyEventPayload {
  const { global, project, ephemeralNesting, problems } = loadCapabilityPolicy(cwd);
  const payload: PolicyEventPayload = { global, project, ephemeralNesting };
  if (problems.length > 0) payload.malformed = problems;
  return payload;
}

export function readProjectPolicyRaw(cwd: string): { ok: true; policy: unknown } | { ok: false; reason: string } {
  const path = projectSettingsPath(cwd);
  if (!existsSync(path)) return { ok: true, policy: undefined };
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf-8"));
    if (!isRecord(parsed)) return { ok: false, reason: `${path} must contain a JSON object` };
    return { ok: true, policy: parsed.policy };
  } catch (err) {
    return { ok: false, reason: `${path} cannot be parsed (${describeError(err)})` };
  }
}
