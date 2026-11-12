import { BUILTIN_TOOL_NAMES } from "../agents/agent-types.js";
import { parseExtensionsSpec, parseExtSelectors } from "../session/extension-scope.js";
import type { AgentConfig } from "../types.js";
import { type LoadedPolicy, loadCapabilityPolicy, type PolicyList, type PolicyScope } from "./capability-policy-config.js";

export type CapabilityField = "tools" | "extensions" | "skills" | "allowedSubagents";

export type CapabilityDeclaration = Pick<
  AgentConfig,
  "builtinToolNames" | "extSelectors" | "disallowedTools" | "extensions" | "excludeExtensions" | "skills" | "allowedSubagents"
>;

export interface SkillScope {
  allow?: string[];
  deny: string[];
}

export interface EffectiveCapabilities {
  builtinToolNames: string[];
  extSelectors: string[];
  noExtensionTools: boolean;
  deniedExtensionNames: string[];
  disallowedTools: string[];
  extensions: true | string[] | false;
  excludeExtensions: string[];
  skills: true | string[] | false;
  skillScope: SkillScope;
  allowedSubagents?: "all" | string[];
}

export type CapabilityVerdict =
  | { kind: "ok"; capabilities: EffectiveCapabilities; filtered: string[] }
  | { kind: "error"; message: string };

export type GrantedCapability = Extract<CapabilityVerdict, { kind: "ok" }>;

export interface CapabilityBound {
  label: string;
  scope: PolicyScope;
}

export interface CapabilityRequest {
  config: CapabilityDeclaration;
  callerSupplied: ReadonlySet<CapabilityField>;
  ephemeral: boolean;
  cwd: string;
  isolated?: boolean;
  policy?: LoadedPolicy;
  extraBounds?: CapabilityBound[];
}

const mintedVerdicts = new WeakSet<object>();

export function isMintedVerdict(value: unknown): value is GrantedCapability {
  return typeof value === "object" && value !== null && mintedVerdicts.has(value);
}

class PolicyRefusal extends Error {}

type ExtAllow = Map<string, Set<string> | "all">;

interface Narrowing<T> {
  value: T;
  filtered: string[];
}

function refuse(message: string): never {
  throw new PolicyRefusal(`Capability policy: ${message}`);
}

function lower(entries: string[] | undefined): string[] {
  return (entries ?? []).map(entry => entry.toLowerCase());
}

function restrictingAllow(list: PolicyList | undefined): string[] | undefined {
  if (!list?.allow || list.allow.includes("*")) return undefined;
  return list.allow;
}

function isPathEntry(entry: string): boolean {
  return entry.includes("/") || entry.includes("\\") || entry.startsWith("~");
}

function nameRefusal(
  bounds: CapabilityBound[],
  kind: "extensions" | "skills",
  name: string,
): string | undefined {
  const key = name.toLowerCase();
  for (const bound of bounds) {
    const list = bound.scope[kind];
    if (lower(list?.deny).includes(key)) return `${bound.label} policy.${kind}.deny lists "${name}"`;
    const allow = restrictingAllow(list);
    if (allow && !lower(allow).includes(key)) return `${bound.label} policy.${kind}.allow does not list "${name}"`;
  }
  return undefined;
}

function toolRefusal(bounds: CapabilityBound[], name: string): string | undefined {
  for (const bound of bounds) {
    const list = bound.scope.tools;
    if (list?.deny?.includes(name)) return `${bound.label} policy.tools.deny lists "${name}"`;
    const allow = restrictingAllow(list);
    if (allow && !allow.includes(name)) return `${bound.label} policy.tools.allow does not list "${name}"`;
  }
  return undefined;
}

function extAllowOf(list: PolicyList | undefined): ExtAllow | undefined {
  const allow = restrictingAllow(list);
  if (!allow) return undefined;
  const map: ExtAllow = new Map();
  for (const entry of allow) {
    if (!entry.startsWith("ext:")) continue;
    const { extNames, narrowing } = parseExtSelectors([entry]);
    for (const name of extNames) {
      const tools = narrowing.get(name);
      const current = map.get(name);
      if (current === "all") continue;
      if (!tools) map.set(name, "all");
      else map.set(name, new Set([...(current ?? []), ...tools]));
    }
  }
  return map;
}

function intersectTools(a: Set<string> | "all", b: Set<string> | "all"): Set<string> | "all" {
  if (a === "all") return b;
  if (b === "all") return a;
  return new Set([...a].filter(tool => b.has(tool)));
}

function intersectAllow(maps: ExtAllow[]): ExtAllow | undefined {
  if (maps.length === 0) return undefined;
  const [first, ...rest] = maps;
  const out: ExtAllow = new Map();
  for (const [name, tools] of first) {
    let merged: Set<string> | "all" | undefined = tools;
    for (const other of rest) {
      const theirs = other.get(name);
      merged = theirs === undefined ? undefined : intersectTools(merged ?? new Set(), theirs);
      if (merged === undefined) break;
    }
    if (merged !== undefined && (merged === "all" || merged.size > 0)) out.set(name, merged);
  }
  return out;
}

function declaredExtMap(selectors: string[] | undefined): ExtAllow | undefined {
  if (!selectors || selectors.length === 0) return undefined;
  const { extNames, narrowing } = parseExtSelectors(selectors);
  const map: ExtAllow = new Map();
  for (const name of extNames) map.set(name, narrowing.get(name) ?? "all");
  return map;
}

function selectorsOf(map: ExtAllow): string[] {
  return [...map].flatMap(([name, tools]) =>
    tools === "all" ? [`ext:${name}`] : [...tools].map(tool => `ext:${name}/${tool}`),
  );
}

function denyEntries(bounds: CapabilityBound[]): string[] {
  return bounds.flatMap(bound => bound.scope.tools?.deny ?? []);
}

function narrowBuiltinTools(
  declared: string[] | undefined,
  bounds: CapabilityBound[],
  callerSupplied: boolean,
): Narrowing<string[]> {
  const filtered: string[] = [];
  const kept: string[] = [];
  for (const name of declared ?? BUILTIN_TOOL_NAMES) {
    const reason = toolRefusal(bounds, name);
    if (!reason) {
      kept.push(name);
      continue;
    }
    if (callerSupplied && declared !== undefined) refuse(`tool "${name}" is not allowed: ${reason}.`);
    filtered.push(`tool ${name}`);
  }
  return { value: kept, filtered };
}

function narrowExtensionSelectors(
  declared: string[] | undefined,
  bounds: CapabilityBound[],
  deniedWhole: Set<string>,
  callerSupplied: boolean,
): Narrowing<{ map: ExtAllow | undefined; restricted: boolean }> {
  const filtered: string[] = [];
  const allowMap = intersectAllow(bounds.map(bound => extAllowOf(bound.scope.tools)).filter((m): m is ExtAllow => m !== undefined));
  const declaredMap = declaredExtMap(declared);
  const base = declaredMap ?? allowMap;
  if (!base) return { value: { map: undefined, restricted: false }, filtered };
  const out: ExtAllow = new Map();
  for (const [name, tools] of base) {
    const extensionReason = declaredMap ? nameRefusal(bounds, "extensions", name) : undefined;
    if (extensionReason) {
      if (callerSupplied) refuse(`extension "${name}" is not allowed: ${extensionReason}.`);
      filtered.push(`ext:${name}`);
      continue;
    }
    const allowed = declaredMap && allowMap ? allowMap.get(name) : tools;
    const merged = allowed === undefined ? undefined : intersectTools(tools, allowed);
    if (deniedWhole.has(name) || merged === undefined || (merged !== "all" && merged.size === 0)) {
      if (declaredMap) filtered.push(`ext:${name}`);
      continue;
    }
    out.set(name, merged);
  }
  return { value: { map: out, restricted: true }, filtered };
}

function narrowToolScope(
  config: CapabilityDeclaration,
  bounds: CapabilityBound[],
  callerSupplied: boolean,
): Pick<EffectiveCapabilities, "builtinToolNames" | "extSelectors" | "noExtensionTools" | "deniedExtensionNames" | "disallowedTools"> & { filtered: string[] } {
  const builtin = narrowBuiltinTools(config.builtinToolNames, bounds, callerSupplied);
  const denies = denyEntries(bounds);
  const deniedWhole = new Set<string>();
  const disallowed = new Set(config.disallowedTools ?? []);
  for (const entry of denies) {
    if (!entry.startsWith("ext:")) {
      if (!BUILTIN_TOOL_NAMES.includes(entry)) disallowed.add(entry);
      continue;
    }
    const { extNames, narrowing } = parseExtSelectors([entry]);
    for (const name of extNames) {
      const tools = narrowing.get(name);
      if (!tools) deniedWhole.add(name);
      else for (const tool of tools) disallowed.add(tool);
    }
  }
  const selectors = narrowExtensionSelectors(config.extSelectors, bounds, deniedWhole, callerSupplied);
  const { map, restricted } = selectors.value;
  const extSelectors = map ? selectorsOf(map) : [];
  const declaredCount = (config.builtinToolNames?.length ?? 0) + (config.extSelectors?.length ?? 0);
  if (declaredCount > 0 && builtin.value.length === 0 && extSelectors.length === 0) {
    refuse("filtering the explicit tool list left no tools.");
  }
  return {
    builtinToolNames: builtin.value,
    extSelectors,
    noExtensionTools: restricted && extSelectors.length === 0,
    deniedExtensionNames: [...deniedWhole],
    disallowedTools: [...disallowed],
    filtered: [...builtin.filtered, ...selectors.filtered],
  };
}

function narrowExtensions(
  declared: true | string[] | false,
  excluded: string[] | undefined,
  bounds: CapabilityBound[],
  callerSupplied: boolean,
  cwd: string,
): Narrowing<{ extensions: true | string[] | false; excludeExtensions: string[] }> {
  const filtered: string[] = [];
  const denied = bounds.flatMap(bound => lower(bound.scope.extensions?.deny));
  const exclude = [...new Set([...lower(excluded), ...denied])];
  if (declared === false) return { value: { extensions: false, excludeExtensions: lower(excluded) }, filtered };
  const allows = bounds.map(bound => restrictingAllow(bound.scope.extensions)).filter((a): a is string[] => a !== undefined);
  const wildcard = declared === true || declared.includes("*");
  if (wildcard) {
    if (allows.length === 0) return { value: { extensions: true, excludeExtensions: exclude }, filtered };
    const names = lower(allows[0]).filter(name => allows.every(list => lower(list).includes(name)) && !denied.includes(name));
    return { value: { extensions: names.length > 0 ? names : false, excludeExtensions: exclude }, filtered };
  }
  const kept: string[] = [];
  for (const entry of declared) {
    const path = isPathEntry(entry);
    if (path && callerSupplied && allows.length > 0) refuse(`extension path "${entry}" is not allowed because an extensions allow list is set.`);
    const names = path ? [...parseExtensionsSpec([entry], cwd).names] : [entry];
    const reason = names.map(name => nameRefusal(bounds, "extensions", name)).find(Boolean);
    if (!reason) {
      kept.push(entry);
      continue;
    }
    if (callerSupplied) refuse(`extension "${entry}" is not allowed: ${reason}.`);
    filtered.push(`extension ${entry}`);
  }
  return { value: { extensions: kept.length > 0 ? kept : false, excludeExtensions: exclude }, filtered };
}

function narrowSkills(
  declared: true | string[] | false,
  bounds: CapabilityBound[],
  callerSupplied: boolean,
): Narrowing<{ skills: true | string[] | false; skillScope: SkillScope }> {
  const filtered: string[] = [];
  const deny = bounds.flatMap(bound => bound.scope.skills?.deny ?? []);
  const allows = bounds.map(bound => restrictingAllow(bound.scope.skills)).filter((a): a is string[] => a !== undefined);
  const allow = allows.length === 0 ? undefined : lower(allows[0]).filter(name => allows.every(list => lower(list).includes(name)));
  const skillScope: SkillScope = allow ? { allow, deny } : { deny };
  if (declared === true || declared === false) return { value: { skills: declared, skillScope }, filtered };
  const kept: string[] = [];
  for (const name of declared) {
    const reason = nameRefusal(bounds, "skills", name);
    if (!reason) {
      kept.push(name);
      continue;
    }
    if (callerSupplied) refuse(`skill "${name}" is not allowed: ${reason}.`);
    filtered.push(`skill ${name}`);
  }
  return { value: { skills: kept.length > 0 ? kept : false, skillScope }, filtered };
}

function narrowAllowedSubagents(
  declared: "all" | string[] | undefined,
  ephemeral: boolean,
  ephemeralNesting: boolean,
  callerSupplied: boolean,
): "all" | string[] | undefined {
  if (!ephemeral || ephemeralNesting) return declared;
  const isEmpty = Array.isArray(declared) && declared.length === 0;
  if (callerSupplied && declared !== undefined && !isEmpty) {
    refuse('allowed_subagents is refused because policy.ephemeralNesting is false; only [] is allowed for an ephemeral agent.');
  }
  return [];
}

function boundsOf(policy: LoadedPolicy, extra: CapabilityBound[] | undefined): CapabilityBound[] {
  return [
    { label: "global", scope: policy.global },
    { label: "project", scope: policy.project },
    ...(extra ?? []),
  ];
}

function evaluate(request: CapabilityRequest, policy: LoadedPolicy): GrantedCapability {
  const { config, callerSupplied, ephemeral, cwd } = request;
  const bounds = boundsOf(policy, request.extraBounds);
  const tools = narrowToolScope(config, bounds, callerSupplied.has("tools"));
  const isolated = request.isolated === true;
  const extensions = narrowExtensions(isolated ? false : config.extensions, config.excludeExtensions, bounds, callerSupplied.has("extensions"), cwd);
  const skills = narrowSkills(isolated ? false : config.skills, bounds, callerSupplied.has("skills"));
  const { filtered: toolFiltered, ...toolScope } = tools;
  const capabilities: EffectiveCapabilities = {
    ...toolScope,
    extSelectors: isolated ? [] : toolScope.extSelectors,
    ...extensions.value,
    ...skills.value,
    allowedSubagents: narrowAllowedSubagents(config.allowedSubagents, ephemeral, policy.ephemeralNesting, callerSupplied.has("allowedSubagents")),
  };
  return { kind: "ok", capabilities, filtered: [...toolFiltered, ...extensions.filtered, ...skills.filtered] };
}

export function checkCapabilityPolicy(request: CapabilityRequest): CapabilityVerdict {
  const policy = request.policy ?? loadCapabilityPolicy(request.cwd);
  if (policy.problems.length > 0) {
    return {
      kind: "error",
      message: `Capability policy: the policy is malformed, so every spawn is denied until it is fixed. ${policy.problems.join("; ")}`,
    };
  }
  try {
    const verdict = evaluate(request, policy);
    mintedVerdicts.add(verdict);
    return verdict;
  } catch (err) {
    if (err instanceof PolicyRefusal) return { kind: "error", message: err.message };
    throw err;
  }
}

export function describeFiltered(filtered: readonly string[]): string {
  return `Capability policy removed: ${filtered.join(", ")}.`;
}
