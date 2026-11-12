import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import type {
  AgentSession,
  AgentSessionEvent,
  DefaultResourceLoader,
  LoadExtensionsResult,
} from "@earendil-works/pi-coding-agent";
import { BUILTIN_TOOL_NAMES } from "../agents/agent-types.js";

export const SUBAGENT_TOOL_NAMES = {
  AGENT: "Agent",
  GET_RESULT: "get_subagent_result",
  STEER: "steer_subagent",
  STOP: "stop_subagent",
} as const;

export const EXCLUDED_TOOL_NAMES: string[] = Object.values(SUBAGENT_TOOL_NAMES);

export function extensionCanonicalName(extPath: string): string {
  const base = basename(extPath);
  const name = base === "index.ts" || base === "index.js"
    ? basename(dirname(extPath))
    : base.replace(/\.(ts|js)$/, "");
  return name.toLowerCase();
}

function extensionPackageName(extPath: string): string | undefined {
  const entry = resolve(extPath);
  let dir = dirname(extPath);
  for (;;) {
    if (basename(dir) === "node_modules") return undefined;
    let pkg: { name?: unknown; pi?: { extensions?: unknown } };
    try {
      pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf-8"));
    } catch {
      const parent = dirname(dir);
      if (parent === dir) return undefined;
      dir = parent;
      continue;
    }
    const entries = pkg.pi?.extensions;
    if (
      typeof pkg.name === "string" &&
      Array.isArray(entries) &&
      entries.some((e) => typeof e === "string" && resolve(dir, e) === entry)
    ) {
      const short = pkg.name.startsWith("@") ? pkg.name.slice(pkg.name.indexOf("/") + 1) : pkg.name;
      return short.toLowerCase();
    }
    return undefined;
  }
}

export function extensionCanonicalNames(extPath: string): string[] {
  const canonical = extensionCanonicalName(extPath);
  const pkg = extensionPackageName(extPath);
  return pkg && pkg !== canonical ? [canonical, pkg] : [canonical];
}

export function parseExtensionsSpec(
  entries: string[],
  cwd: string,
): { names: Set<string>; paths: string[]; wildcard: boolean } {
  const names = new Set<string>();
  const paths: string[] = [];
  let wildcard = false;
  for (const entry of entries) {
    if (!entry) continue;
    if (entry === "*") {
      wildcard = true;
      continue;
    }
    const isPathEntry = entry.includes("/") || entry.includes("\\") || entry.startsWith("~");
    if (!isPathEntry) {
      names.add(entry.toLowerCase());
      continue;
    }
    let p = entry;
    if (p === "~" || p.startsWith("~/") || p.startsWith("~\\")) {
      p = homedir() + p.slice(1);
    }
    const abs = isAbsolute(p) ? p : resolve(cwd, p);
    paths.push(abs);
    names.add(extensionCanonicalName(abs));
  }
  return { names, paths, wildcard };
}

export function parseExtSelectors(entries: string[]): {
  extNames: Set<string>;
  narrowing: Map<string, Set<string>>;
} {
  const extNames = new Set<string>();
  const narrowing = new Map<string, Set<string>>();
  for (const raw of entries) {
    if (!raw) continue;
    const body = raw.slice("ext:".length);
    const slash = body.indexOf("/");
    const name = (slash === -1 ? body : body.slice(0, slash)).trim().toLowerCase();
    if (!name) continue;
    extNames.add(name);
    if (slash === -1) continue;
    const tool = body.slice(slash + 1).trim();
    if (!tool) continue;
    let set = narrowing.get(name);
    if (!set) {
      set = new Set();
      narrowing.set(name, set);
    }
    set.add(tool);
  }
  return { extNames, narrowing };
}

export interface ExtensionLoadPlan {
  noExtensions: boolean;
  keepNames: Set<string>;
  excludeNames: Set<string>;
  hasExcludes: boolean;
  additionalExtensionPaths: string[] | undefined;
  extensionsOverride: ((base: LoadExtensionsResult) => LoadExtensionsResult) | undefined;
  discoveredNames(): Set<string> | undefined;
}

export function planExtensionLoad(
  extensions: true | string[] | false,
  excludeExtensions: string[] | undefined,
  configCwd: string,
): ExtensionLoadPlan {
  const noExtensions = extensions === false;
  const spec = Array.isArray(extensions) ? parseExtensionsSpec(extensions, configCwd) : undefined;
  const keepNames = spec?.names ?? new Set<string>();
  const excludeNames = new Set((excludeExtensions ?? []).map((n) => n.toLowerCase()));
  const hasExcludes = excludeNames.size > 0;
  const loadAll = extensions === true || spec?.wildcard === true;
  let discovered: Set<string> | undefined;
  const extensionsOverride =
    noExtensions || (loadAll && !hasExcludes)
      ? undefined
      : (base: LoadExtensionsResult): LoadExtensionsResult => {
          discovered = new Set(base.extensions.flatMap((e) => extensionCanonicalNames(e.path)));
          return {
            ...base,
            extensions: base.extensions.filter((e) => {
              const canons = extensionCanonicalNames(e.path);
              if (canons.some((n) => excludeNames.has(n))) return false;
              return loadAll || canons.some((n) => keepNames.has(n));
            }),
          };
        };
  return {
    noExtensions,
    keepNames,
    excludeNames,
    hasExcludes,
    additionalExtensionPaths: spec?.paths.length ? spec.paths : undefined,
    extensionsOverride,
    discoveredNames: () => discovered,
  };
}

export function extensionConfigWarnings(a: {
  type: string;
  noExtensions: boolean;
  keepNames: Set<string>;
  excludeNames: Set<string>;
  extNames: Set<string>;
  discoveredNames: Set<string> | undefined;
  getSurvivingNames: () => Set<string>;
}): string[] {
  const { type, keepNames, excludeNames, extNames } = a;
  const warnings: string[] = [];
  if (excludeNames.size > 0 && a.noExtensions) {
    warnings.push(
      `extension-error:exclude_extensions has no effect for agent "${type}" — extensions: false loads nothing`,
    );
  }
  if (excludeNames.size > 0 && a.discoveredNames) {
    for (const name of excludeNames) {
      if (!a.discoveredNames.has(name)) {
        warnings.push(
          `extension-error:exclude_extensions: "${name}" for agent "${type}" did not match any discovered extension`,
        );
      }
    }
  }
  if (keepNames.size === 0 && extNames.size === 0) return warnings;
  const surviving = a.getSurvivingNames();
  for (const name of keepNames) {
    if (surviving.has(name)) continue;
    warnings.push(
      excludeNames.has(name)
        ? `extension-error:extension "${name}" is in both extensions: and exclude_extensions: for agent "${type}" — exclude wins`
        : `extension-error:extension "${name}" requested by agent "${type}" was not loaded`,
    );
  }
  for (const name of extNames) {
    if (surviving.has(name)) continue;
    warnings.push(
      `extension-error:ext:${name} referenced by agent "${type}" but extension "${name}" is not loaded (check extensions:/exclude_extensions:)`,
    );
  }
  return warnings;
}

export function resolveSessionToolScope(a: {
  noExtensions: boolean;
  toolNames: string[];
  disallowedSet: Set<string> | undefined;
  nestedToolNames: Set<string>;
}): { sessionTools: string[] | undefined; sessionExcludeTools: string[] | undefined } {
  const { toolNames, disallowedSet, nestedToolNames } = a;
  if (a.noExtensions) {
    return {
      sessionTools: [
        ...toolNames.filter((t) => !EXCLUDED_TOOL_NAMES.includes(t) && !disallowedSet?.has(t)),
        ...[...nestedToolNames].filter((t) => !disallowedSet?.has(t)),
      ],
      sessionExcludeTools: undefined,
    };
  }
  const denyTools = new Set<string>(EXCLUDED_TOOL_NAMES.filter((t) => !nestedToolNames.has(t)));
  const wanted = new Set(toolNames);
  for (const name of BUILTIN_TOOL_NAMES) {
    if (!wanted.has(name)) denyTools.add(name);
  }
  for (const name of disallowedSet ?? []) denyTools.add(name);
  return { sessionTools: undefined, sessionExcludeTools: [...denyTools] };
}

export function installExtensionToolScope(
  session: AgentSession,
  ctx: {
    loader: DefaultResourceLoader;
    toolNames: string[];
    disallowedSet: Set<string> | undefined;
    extNames: Set<string>;
    narrowing: Map<string, Set<string>>;
    readmitToolNames: Set<string>;
    deniedExtNames?: Set<string>;
    noExtensionTools?: boolean;
  },
): void {
  const { loader, toolNames, disallowedSet, extNames, narrowing, readmitToolNames, deniedExtNames, noExtensionTools } = ctx;

  const inScope = (): Set<string> => {
    const keep = new Set(toolNames.filter((t) => !disallowedSet?.has(t)));
    const optInActive = extNames.size > 0;
    for (const extension of noExtensionTools ? [] : loader.getExtensions().extensions) {
      const canons = extensionCanonicalNames(extension.path);
      if (canons.some((c) => deniedExtNames?.has(c))) continue;
      if (optInActive && !canons.some((c) => extNames.has(c))) continue;
      const narrowed = canons.map((c) => narrowing.get(c)).find(Boolean);
      for (const name of extension.tools.keys()) {
        if (narrowed && !narrowed.has(name)) continue;
        if (disallowedSet?.has(name)) continue;
        keep.add(name);
      }
    }
    for (const name of EXCLUDED_TOOL_NAMES) keep.delete(name);
    for (const name of readmitToolNames) keep.add(name);
    return keep;
  };

  const renarrow = () => {
    const allowed = inScope();
    const next = session.getAllTools().map((t) => t.name).filter((n) => allowed.has(n));
    const current = session.getActiveToolNames();
    if (next.length !== current.length || next.some((n, i) => n !== current[i])) {
      session.setActiveToolsByName(next);
    }
  };

  renarrow();

  session.subscribe((event: AgentSessionEvent) => {
    if (event.type === "turn_end") renarrow();
  });

  const priorBeforeToolCall = session.agent.beforeToolCall;
  session.agent.beforeToolCall = async (context, signal) => {
    if (!inScope().has(context.toolCall.name)) {
      return {
        block: true,
        reason: `Tool "${context.toolCall.name}" is not available to this subagent.`,
      };
    }
    return priorBeforeToolCall?.(context, signal);
  };
}
