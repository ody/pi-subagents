import { type LoadExtensionsResult, loadSkills } from "@earendil-works/pi-coding-agent";
import { BUILTIN_TOOL_NAMES } from "../agents/agent-types.js";
import { EXCLUDED_TOOL_NAMES, extensionCanonicalName, extensionCanonicalNames, parseExtSelectors } from "../session/extension-scope.js";
import type { LoadedPolicy, PolicyList, PolicyScope } from "./capability-policy-config.js";
import { globalSettingsPath, projectSettingsPath } from "./settings-paths.js";

export interface KnownCapabilities {
  extensions?: ReadonlySet<string>;
  extensionTools?: ReadonlySet<string>;
  skills: ReadonlySet<string>;
}

const LIST_KEYS = ["allow", "deny"] as const;

function entriesOf(list: PolicyList | undefined): { key: string; entry: string }[] {
  return LIST_KEYS.flatMap(key => (list?.[key] ?? []).map(entry => ({ key, entry })));
}

function isPathEntry(entry: string): boolean {
  return entry.includes("/") || entry.includes("\\") || entry.startsWith("~");
}

function toolIsKnown(entry: string, known: KnownCapabilities): boolean {
  if (entry === "*" || entry === "ext:*") return true;
  if (BUILTIN_TOOL_NAMES.includes(entry) || EXCLUDED_TOOL_NAMES.includes(entry)) return true;
  if (!known.extensions || !known.extensionTools) return true;
  if (!entry.startsWith("ext:")) return known.extensionTools.has(entry);
  const { extNames, narrowing } = parseExtSelectors([entry]);
  for (const name of extNames) {
    if (!known.extensions.has(name)) return false;
    for (const tool of narrowing.get(name) ?? []) if (!known.extensionTools.has(tool)) return false;
  }
  return true;
}

function extensionIsKnown(entry: string, known: KnownCapabilities): boolean {
  if (entry === "*" || !known.extensions) return true;
  const name = isPathEntry(entry) ? extensionCanonicalName(entry) : entry.toLowerCase();
  return known.extensions.has(name);
}

function scopeWarnings(file: string, scope: PolicyScope, known: KnownCapabilities): string[] {
  const out: string[] = [];
  const report = (kind: string, key: string, entry: string) =>
    out.push(`${file}: policy.${kind}.${key} entry "${entry}" names no known ${kind.slice(0, -1)}`);
  for (const { key, entry } of entriesOf(scope.tools)) if (!toolIsKnown(entry, known)) report("tools", key, entry);
  for (const { key, entry } of entriesOf(scope.extensions)) if (!extensionIsKnown(entry, known)) report("extensions", key, entry);
  for (const { key, entry } of entriesOf(scope.skills)) {
    if (entry !== "*" && !known.skills.has(entry.toLowerCase())) report("skills", key, entry);
  }
  return out;
}

export function discoverKnown(cwd: string, agentDir: string, extensions: LoadExtensionsResult | undefined): KnownCapabilities {
  const skills = new Set(loadSkills({ cwd, agentDir, skillPaths: [], includeDefaults: true }).skills.map(skill => skill.name.toLowerCase()));
  if (!extensions) return { skills };
  return {
    skills,
    extensions: new Set(extensions.extensions.flatMap(extension => extensionCanonicalNames(extension.path))),
    extensionTools: new Set(extensions.extensions.flatMap(extension => [...extension.tools.keys()])),
  };
}

function hasEntries(scope: PolicyScope): boolean {
  return [scope.tools, scope.extensions, scope.skills].some(list => entriesOf(list).length > 0);
}

export function policyHasEntries(policy: LoadedPolicy): boolean {
  return hasEntries(policy.global) || hasEntries(policy.project);
}

export function unknownPolicyEntries(policy: LoadedPolicy, cwd: string, discover: () => KnownCapabilities): string[] {
  if (!policyHasEntries(policy)) return [];
  const known = discover();
  return [
    ...scopeWarnings(globalSettingsPath(), policy.global, known),
    ...scopeWarnings(projectSettingsPath(cwd), policy.project, known),
  ];
}
