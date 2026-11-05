import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  EXCLUDED_TOOL_NAMES,
  extensionCanonicalName,
  extensionCanonicalNames,
  extensionConfigWarnings,
  parseExtensionsSpec,
  parseExtSelectors,
  planExtensionLoad,
  resolveSessionToolScope,
  SUBAGENT_TOOL_NAMES,
} from "../src/session/extension-scope.js";

describe("EXCLUDED_TOOL_NAMES", () => {
  it("lists exactly the tools this extension registers", () => {
    expect(EXCLUDED_TOOL_NAMES).toEqual(Object.values(SUBAGENT_TOOL_NAMES));
  });
});

// ─── extensions: string[] as a loader-level extension filter ────────────
// An array entry is a bare name (filters default-discovered extensions),
// a path (loads that extension fresh), or "*" (keep all defaults).
// Filtering happens at the loader via additionalExtensionPaths +
// extensionsOverride — excluded extensions never bind handlers or register
// tools.

describe("extensionCanonicalName", () => {
  it("strips .ts/.js from a single-file extension basename", () => {
    expect(extensionCanonicalName("/x/foo.ts")).toBe("foo");
    expect(extensionCanonicalName("/x/foo.js")).toBe("foo");
  });
  it("uses the parent directory name for index.{ts,js} extensions", () => {
    expect(extensionCanonicalName("/x/foo/index.ts")).toBe("foo");
    expect(extensionCanonicalName("/x/foo/index.js")).toBe("foo");
  });
  it("lowercases the result for case-insensitive matching", () => {
    expect(extensionCanonicalName("/x/MCP.ts")).toBe("mcp");
    expect(extensionCanonicalName("/x/MyExt.js")).toBe("myext");
    expect(extensionCanonicalName("/x/Foo/index.ts")).toBe("foo");
  });
});

describe("extensionCanonicalNames (#143 — package short name alias)", () => {
  const tmpDirs: string[] = [];
  function pkgDir(name: string, piExtensions: unknown): string {
    const dir = mkdtempSync(join(tmpdir(), "subagents-pkg-"));
    tmpDirs.push(dir);
    const manifest: Record<string, unknown> = { name };
    if (piExtensions !== undefined) manifest.pi = { extensions: piExtensions };
    writeFileSync(join(dir, "package.json"), JSON.stringify(manifest));
    mkdirSync(join(dir, "src"));
    writeFileSync(join(dir, "src", "index.ts"), "export default () => {};");
    return dir;
  }
  afterEach(() => {
    while (tmpDirs.length) rmSync(tmpDirs.pop()!, { recursive: true, force: true });
  });

  it("aliases a package-declared index.ts entry to the unscoped, lowercased package name", () => {
    // Without this, `pi.extensions: ["./src/index.ts"]` only ever matches as "src".
    const dir = pkgDir("@ody/Pi-Subagents", ["./src/index.ts"]);
    expect(extensionCanonicalNames(join(dir, "src", "index.ts"))).toEqual(["src", "pi-subagents"]);
  });

  it("adds no alias for a loose file with no enclosing package.json", () => {
    const dir = mkdtempSync(join(tmpdir(), "subagents-loose-"));
    tmpDirs.push(dir);
    writeFileSync(join(dir, "foo.ts"), "export default () => {};");
    expect(extensionCanonicalNames(join(dir, "foo.ts"))).toEqual(["foo"]);
  });

  it("adds no alias when the nearest manifest does not declare this entry", () => {
    // The package.json is a real pi package but lists a *different* entry — so a
    // co-located file (e.g. our own test fixtures under this repo) is not falsely
    // stamped with the package name.
    const dir = pkgDir("@scope/other-ext", ["./src/other.ts"]);
    expect(extensionCanonicalNames(join(dir, "src", "index.ts"))).toEqual(["src"]);
  });

  it("adds no alias when the nearest package.json has no pi manifest", () => {
    const dir = pkgDir("just-a-project", undefined);
    expect(extensionCanonicalNames(join(dir, "src", "index.ts"))).toEqual(["src"]);
  });

  it("does not climb past a node_modules boundary into a consumer's manifest", () => {
    // A consumer that *declares* a dependency's entry must not lend its name to
    // that dependency: the walk stops at node_modules before reading it.
    const root = mkdtempSync(join(tmpdir(), "subagents-consumer-"));
    tmpDirs.push(root);
    writeFileSync(
      join(root, "package.json"),
      JSON.stringify({ name: "consumer", pi: { extensions: ["./node_modules/inner-ext/index.ts"] } }),
    );
    const inner = join(root, "node_modules", "inner-ext");
    mkdirSync(inner, { recursive: true });
    writeFileSync(join(inner, "index.ts"), "export default () => {};");
    // Only the path-derived name — never "consumer".
    expect(extensionCanonicalNames(join(inner, "index.ts"))).toEqual(["inner-ext"]);
  });
});

describe("parseExtensionsSpec", () => {
  it("classifies bare entries as names", () => {
    const spec = parseExtensionsSpec(["mcp", "logger"], "/work");
    expect(spec.names).toEqual(new Set(["mcp", "logger"]));
    expect(spec.paths).toEqual([]);
    expect(spec.wildcard).toBe(false);
  });
  it("treats '*' as the wildcard", () => {
    const spec = parseExtensionsSpec(["*"], "/work");
    expect(spec.wildcard).toBe(true);
    expect(spec.names.size).toBe(0);
    expect(spec.paths).toEqual([]);
  });
  it("resolves a relative path against cwd and adds its canonical name", () => {
    const spec = parseExtensionsSpec(["./rel/foo.ts"], "/work");
    expect(spec.paths).toEqual(["/work/rel/foo.ts"]);
    expect(spec.names).toEqual(new Set(["foo"]));
  });
  it("keeps an absolute path as-is", () => {
    const spec = parseExtensionsSpec(["/abs/bar.ts"], "/work");
    expect(spec.paths).toEqual(["/abs/bar.ts"]);
    expect(spec.names).toEqual(new Set(["bar"]));
  });
  it("expands a leading ~ to the home directory", () => {
    const spec = parseExtensionsSpec(["~/ext/baz.ts"], "/work");
    expect(spec.paths[0]).toBe(`${homedir()}/ext/baz.ts`);
    expect(spec.names).toEqual(new Set(["baz"]));
  });
  it("composes wildcard, names, and paths", () => {
    const spec = parseExtensionsSpec(["*", "mcp", "/abs/foo.ts"], "/work");
    expect(spec.wildcard).toBe(true);
    expect(spec.names).toEqual(new Set(["mcp", "foo"]));
    expect(spec.paths).toEqual(["/abs/foo.ts"]);
  });
  it("lowercases bare-name entries — extension names match case-insensitively", () => {
    const spec = parseExtensionsSpec(["Mcp", "LOGGER"], "/work");
    expect(spec.names).toEqual(new Set(["mcp", "logger"]));
  });
  it("ignores empty entries (defensive — upstream parsers already strip them)", () => {
    const spec = parseExtensionsSpec(["", "mcp", ""], "/work");
    expect(spec.names).toEqual(new Set(["mcp"]));
    expect(spec.wildcard).toBe(false);
  });
});

// ─── ext: tool selectors in `tools:` (opt-in flip) ──────────────────────
describe("parseExtSelectors", () => {
  it("bare ext:foo → name only, no narrowing", () => {
    const { extNames, narrowing } = parseExtSelectors(["ext:foo"]);
    expect(extNames).toEqual(new Set(["foo"]));
    expect(narrowing.size).toBe(0);
  });
  it("ext:foo/bar → name plus a narrowing entry", () => {
    const { extNames, narrowing } = parseExtSelectors(["ext:foo/bar"]);
    expect(extNames).toEqual(new Set(["foo"]));
    expect(narrowing.get("foo")).toEqual(new Set(["bar"]));
  });
  it("multiple ext:foo/* entries union", () => {
    expect(parseExtSelectors(["ext:foo/a", "ext:foo/b"]).narrowing.get("foo")).toEqual(
      new Set(["a", "b"]),
    );
  });
  it("ext:foo + ext:foo/bar → narrowing wins", () => {
    const { narrowing } = parseExtSelectors(["ext:foo", "ext:foo/bar"]);
    expect(narrowing.get("foo")).toEqual(new Set(["bar"]));
  });
  it("splits on the first / so tool names may contain /", () => {
    expect(parseExtSelectors(["ext:foo/bar/baz"]).narrowing.get("foo")).toEqual(
      new Set(["bar/baz"]),
    );
  });
  it("skips empty name and empty tool halves", () => {
    const { extNames, narrowing } = parseExtSelectors(["ext:", "ext:foo/"]);
    expect(extNames).toEqual(new Set(["foo"]));
    expect(narrowing.size).toBe(0);
  });
  it("lowercases the extension name but preserves tool-name case", () => {
    // The extension half matches the loader's canonical name (also lowercased);
    // the tool half is matched against pi-mono's registered identifiers, which
    // are case-sensitive.
    const { extNames, narrowing } = parseExtSelectors(["ext:Mcp/SomeTool", "ext:FOO"]);
    expect(extNames).toEqual(new Set(["mcp", "foo"]));
    expect(narrowing.get("mcp")).toEqual(new Set(["SomeTool"]));
  });
});

describe("planExtensionLoad", () => {
  const ext = (path: string) => ({ path }) as never;
  const base = (...paths: string[]) => ({ extensions: paths.map(ext), errors: [], runtime: {} }) as never;

  it("needs no override for extensions: false", () => {
    const plan = planExtensionLoad(false, undefined, "/cwd");
    expect(plan.noExtensions).toBe(true);
    expect(plan.extensionsOverride).toBeUndefined();
  });
  it("needs no override for extensions: true without excludes", () => {
    expect(planExtensionLoad(true, undefined, "/cwd").extensionsOverride).toBeUndefined();
    expect(planExtensionLoad(["*"], [], "/cwd").extensionsOverride).toBeUndefined();
  });
  it("keeps only named extensions and records the pre-filter set after the override runs", () => {
    const plan = planExtensionLoad(["foo"], undefined, "/cwd");
    expect(plan.discoveredNames()).toBeUndefined();
    const out = plan.extensionsOverride?.(base("/x/foo.ts", "/x/bar.ts"));
    expect(out?.extensions.map((e) => e.path)).toEqual(["/x/foo.ts"]);
    expect(plan.discoveredNames()).toEqual(new Set(["foo", "bar"]));
  });
  it("exclude wins over include and over true", () => {
    const named = planExtensionLoad(["foo", "bar"], ["Foo"], "/cwd");
    expect(named.hasExcludes).toBe(true);
    expect(named.excludeNames).toEqual(new Set(["foo"]));
    expect(named.extensionsOverride?.(base("/x/foo.ts", "/x/bar.ts")).extensions).toHaveLength(1);
    const all = planExtensionLoad(true, ["foo"], "/cwd");
    expect(all.extensionsOverride?.(base("/x/foo.ts", "/x/bar.ts")).extensions.map((e) => e.path)).toEqual(["/x/bar.ts"]);
  });
  it("exposes keepNames and additional paths", () => {
    const plan = planExtensionLoad(["foo", "/abs/baz.ts"], undefined, "/cwd");
    expect(plan.keepNames).toEqual(new Set(["foo", "baz"]));
    expect(plan.additionalExtensionPaths).toEqual(["/abs/baz.ts"]);
    expect(planExtensionLoad(["foo"], undefined, "/cwd").additionalExtensionPaths).toBeUndefined();
  });
});

describe("extensionConfigWarnings", () => {
  const args = (over: Record<string, unknown> = {}) => ({
    type: "T",
    noExtensions: false,
    keepNames: new Set<string>(),
    excludeNames: new Set<string>(),
    extNames: new Set<string>(),
    discoveredNames: undefined as Set<string> | undefined,
    getSurvivingNames: () => new Set<string>(),
    ...over,
  });

  it("returns nothing for a clean config and never reads surviving names", () => {
    let called = false;
    const getSurvivingNames = () => {
      called = true;
      return new Set<string>();
    };
    expect(extensionConfigWarnings(args({ getSurvivingNames }))).toEqual([]);
    expect(called).toBe(false);
  });
  it("warns when excludes meet extensions: false", () => {
    const w = extensionConfigWarnings(args({ noExtensions: true, excludeNames: new Set(["a"]) }));
    expect(w).toEqual(['extension-error:exclude_extensions has no effect for agent "T" — extensions: false loads nothing']);
  });
  it("warns on exclude typos against the discovered set", () => {
    const w = extensionConfigWarnings(
      args({ excludeNames: new Set(["a", "b"]), discoveredNames: new Set(["a"]) }),
    );
    expect(w).toEqual(['extension-error:exclude_extensions: "b" for agent "T" did not match any discovered extension']);
  });
  it("warns on unloaded keep and ext names, in order, with exclude-wins variant", () => {
    const w = extensionConfigWarnings(
      args({
        keepNames: new Set(["k", "x"]),
        excludeNames: new Set(["x"]),
        extNames: new Set(["e"]),
        discoveredNames: new Set(["x"]),
        getSurvivingNames: () => new Set(["ok"]),
      }),
    );
    expect(w).toEqual([
      'extension-error:extension "k" requested by agent "T" was not loaded',
      'extension-error:extension "x" is in both extensions: and exclude_extensions: for agent "T" — exclude wins',
      'extension-error:ext:e referenced by agent "T" but extension "e" is not loaded (check extensions:/exclude_extensions:)',
    ]);
  });
});

describe("resolveSessionToolScope", () => {
  it("builds a strict allowlist under noExtensions, re-admitting nested tools", () => {
    const scope = resolveSessionToolScope({
      noExtensions: true,
      toolNames: ["read", "bash", "Agent"],
      disallowedSet: new Set(["bash", "steer_subagent"]),
      nestedToolNames: new Set(["Agent", "steer_subagent"]),
    });
    expect(scope).toEqual({ sessionTools: ["read", "Agent"], sessionExcludeTools: undefined });
  });
  it("builds a deny list when extensions are in play", () => {
    const scope = resolveSessionToolScope({
      noExtensions: false,
      toolNames: ["read"],
      disallowedSet: new Set(["foo"]),
      nestedToolNames: new Set(["Agent"]),
    });
    expect(scope.sessionTools).toBeUndefined();
    const deny = new Set(scope.sessionExcludeTools);
    expect(deny.has("Agent")).toBe(false);
    expect(deny.has("get_subagent_result")).toBe(true);
    expect(deny.has("foo")).toBe(true);
    expect(deny.has("read")).toBe(false);
    expect(deny.has("bash")).toBe(true);
  });
  it("disallowed_tools wins over an opt-in nested tool", () => {
    const scope = resolveSessionToolScope({
      noExtensions: false,
      toolNames: [],
      disallowedSet: new Set(["Agent"]),
      nestedToolNames: new Set(["Agent"]),
    });
    expect(scope.sessionExcludeTools).toContain("Agent");
  });
});
