import { describe, expect, it } from "vitest";
import { BUILTIN_TOOL_NAMES } from "../src/agents/agent-types.js";
import {
  type CapabilityDeclaration,
  type CapabilityField,
  checkCapabilityPolicy,
  type EffectiveCapabilities,
  isMintedVerdict,
} from "../src/config/capability-policy.js";
import type { LoadedPolicy, PolicyScope } from "../src/config/capability-policy-config.js";

const OPEN: CapabilityDeclaration = { extensions: true, skills: true };

function policyOf(global: PolicyScope = {}, project: PolicyScope = {}, ephemeralNesting = true): LoadedPolicy {
  return { global, project, ephemeralNesting, problems: [] };
}

function check(
  config: Partial<CapabilityDeclaration>,
  policy: LoadedPolicy,
  options: { caller?: CapabilityField[]; ephemeral?: boolean; isolated?: boolean } = {},
) {
  return checkCapabilityPolicy({
    config: { ...OPEN, ...config },
    callerSupplied: new Set(options.caller ?? []),
    ephemeral: options.ephemeral ?? false,
    cwd: process.cwd(),
    isolated: options.isolated,
    policy,
  });
}

function granted(verdict: ReturnType<typeof check>): { capabilities: EffectiveCapabilities; filtered: string[] } {
  if (verdict.kind !== "ok") throw new Error(`expected ok, got ${verdict.message}`);
  return verdict;
}

describe("checkCapabilityPolicy", () => {
  it("allows everything under an empty policy and mints a verdict", () => {
    const verdict = check({}, policyOf());
    const { capabilities, filtered } = granted(verdict);
    expect(capabilities.builtinToolNames).toEqual(BUILTIN_TOOL_NAMES);
    expect(capabilities.extensions).toBe(true);
    expect(capabilities.skills).toBe(true);
    expect(capabilities.noExtensionTools).toBe(false);
    expect(filtered).toEqual([]);
    expect(isMintedVerdict(verdict)).toBe(true);
    expect(isMintedVerdict({ ...verdict })).toBe(false);
  });

  it("denies every spawn when the policy is malformed", () => {
    const verdict = check({}, { ...policyOf(), problems: ["/p/subagents.json: policy.tools must be an object"] });
    expect(verdict).toEqual({
      kind: "error",
      message: expect.stringMatching(/^Capability policy: .*\/p\/subagents\.json/),
    });
  });

  describe("tools", () => {
    it("filters a file's built-in tools against a deny list", () => {
      const { capabilities, filtered } = granted(
        check({ builtinToolNames: ["read", "bash"] }, policyOf({ tools: { deny: ["bash"] } })),
      );
      expect(capabilities.builtinToolNames).toEqual(["read"]);
      expect(filtered).toEqual(["tool bash"]);
    });

    it("filters default built-ins down to an allow list", () => {
      const { capabilities } = granted(check({}, policyOf({ tools: { allow: ["read", "grep"] } })));
      expect(capabilities.builtinToolNames).toEqual(BUILTIN_TOOL_NAMES.filter(name => ["read", "grep"].includes(name)));
    });

    it("refuses a caller-supplied denied tool", () => {
      const verdict = check({ builtinToolNames: ["bash"] }, policyOf({ tools: { deny: ["bash"] } }), { caller: ["tools"] });
      expect(verdict).toEqual({ kind: "error", message: expect.stringMatching(/^Capability policy: .*bash.*global policy\.tools\.deny/) });
    });

    it("refuses a caller-supplied tool missing from an allow list", () => {
      const verdict = check({ builtinToolNames: ["write"] }, policyOf({ tools: { allow: ["read"] } }), { caller: ["tools"] });
      expect(verdict.kind).toBe("error");
    });

    it("evaluates global and project separately, so a project only narrows", () => {
      const { capabilities } = granted(
        check({}, policyOf({ tools: { allow: ["read", "bash"] } }, { tools: { allow: ["read", "write"] } })),
      );
      expect(capabilities.builtinToolNames).toEqual(["read"]);
    });

    it("lets deny beat allow", () => {
      const { capabilities } = granted(check({}, policyOf({ tools: { allow: ["*", "read"], deny: ["read"] } })));
      expect(capabilities.builtinToolNames).not.toContain("read");
    });

    it("refuses when filtering empties an explicit tool list", () => {
      const verdict = check({ builtinToolNames: ["bash"] }, policyOf({ tools: { deny: ["bash"] } }));
      expect(verdict).toEqual({ kind: "error", message: expect.stringMatching(/^Capability policy: .*no tools/) });
    });

    it("does not refuse an explicit empty tool list", () => {
      expect(check({ builtinToolNames: [] }, policyOf({ tools: { allow: ["read"] } })).kind).toBe("ok");
    });

    it("permits no extension tools when the allow list has no ext entry and no wildcard", () => {
      const { capabilities } = granted(check({}, policyOf({ tools: { allow: ["read"] } })));
      expect(capabilities.noExtensionTools).toBe(true);
    });

    it("permits extension tools under a wildcard allow", () => {
      const { capabilities } = granted(check({}, policyOf({ tools: { allow: ["*"] } })));
      expect(capabilities.noExtensionTools).toBe(false);
      expect(capabilities.extSelectors).toEqual([]);
    });

    it("expands an unrestricted agent to the allowed ext selectors", () => {
      const { capabilities } = granted(check({}, policyOf({ tools: { allow: ["read", "ext:web", "ext:db/query"] } })));
      expect(capabilities.extSelectors).toEqual(["ext:web", "ext:db/query"]);
      expect(capabilities.noExtensionTools).toBe(false);
    });

    it("narrows a whole-extension selector to the allowed tool", () => {
      const { capabilities } = granted(
        check({ extSelectors: ["ext:web"] }, policyOf({ tools: { allow: ["read", "ext:web/fetch"] } }), { caller: ["tools"] }),
      );
      expect(capabilities.extSelectors).toEqual(["ext:web/fetch"]);
    });

    it("drops a selector outside the allow list without refusing, and permits no extension tools", () => {
      const { capabilities, filtered } = granted(
        check({ extSelectors: ["ext:web"], builtinToolNames: ["read"] }, policyOf({ tools: { allow: ["read", "ext:db"] } }), { caller: ["tools"] }),
      );
      expect(capabilities.extSelectors).toEqual([]);
      expect(capabilities.noExtensionTools).toBe(true);
      expect(filtered).toContain("ext:web");
    });

    it("turns ext:<extension> deny into a denied extension and ext:<extension>/<tool> into a tool deny", () => {
      const { capabilities } = granted(check({}, policyOf({ tools: { deny: ["ext:web", "ext:db/drop", "mystery"] } })));
      expect(capabilities.deniedExtensionNames).toEqual(["web"]);
      expect(capabilities.disallowedTools).toEqual(expect.arrayContaining(["drop", "mystery"]));
    });

    it("drops a denied whole-extension selector without refusing a caller", () => {
      const { capabilities } = granted(
        check({ extSelectors: ["ext:web"], builtinToolNames: ["read"] }, policyOf({ tools: { deny: ["ext:web"] } }), { caller: ["tools"] }),
      );
      expect(capabilities.extSelectors).toEqual([]);
    });

    it("keeps a file's existing disallowed tools", () => {
      const { capabilities } = granted(check({ disallowedTools: ["edit"] }, policyOf()));
      expect(capabilities.disallowedTools).toEqual(["edit"]);
    });
  });

  describe("extensions", () => {
    it("expands extensions: true to the allow list and excludes denied names", () => {
      const allowed = granted(check({}, policyOf({ extensions: { allow: ["Web", "db"] } })));
      expect(allowed.capabilities.extensions).toEqual(["web", "db"]);
      const denied = granted(check({}, policyOf({ extensions: { deny: ["risky"] } })));
      expect(denied.capabilities.extensions).toBe(true);
      expect(denied.capabilities.excludeExtensions).toEqual(["risky"]);
    });

    it("expands a wildcard entry like true", () => {
      const { capabilities } = granted(check({ extensions: ["*"] }, policyOf({ extensions: { allow: ["web"] } }), { caller: ["extensions"] }));
      expect(capabilities.extensions).toEqual(["web"]);
    });

    it("intersects the global and project allow lists", () => {
      const { capabilities } = granted(check({}, policyOf({ extensions: { allow: ["a", "b"] } }, { extensions: { allow: ["b", "c"] } })));
      expect(capabilities.extensions).toEqual(["b"]);
    });

    it("filters a file's extension and refuses a caller's", () => {
      const policy = policyOf({ extensions: { deny: ["risky"] } });
      const filtered = granted(check({ extensions: ["web", "risky"] }, policy));
      expect(filtered.capabilities.extensions).toEqual(["web"]);
      expect(filtered.filtered).toEqual(["extension risky"]);
      const refused = check({ extensions: ["web", "risky"] }, policy, { caller: ["extensions"] });
      expect(refused).toEqual({ kind: "error", message: expect.stringMatching(/^Capability policy: extension "risky".*policy\.extensions\.deny/) });
    });

    it("refuses a caller-supplied path whenever an allow list is set", () => {
      const verdict = check({ extensions: ["./ext/web.ts"] }, policyOf({ extensions: { allow: ["web"] } }), { caller: ["extensions"] });
      expect(verdict.kind).toBe("error");
      expect(check({ extensions: ["./ext/web.ts"] }, policyOf({ extensions: { deny: ["x"] } }), { caller: ["extensions"] }).kind).toBe("ok");
    });

    it("matches a file's path entry by canonical name", () => {
      const { capabilities } = granted(check({ extensions: ["./ext/web.ts", "./ext/db.ts"] }, policyOf({ extensions: { allow: ["web"] } })));
      expect(capabilities.extensions).toEqual(["./ext/web.ts"]);
    });

    it("refuses a caller ext selector whose extension is denied by policy.extensions", () => {
      const verdict = check({ extSelectors: ["ext:risky"], builtinToolNames: ["read"] }, policyOf({ extensions: { deny: ["risky"] } }), { caller: ["tools"] });
      expect(verdict.kind).toBe("error");
    });

    it("stays false under extensions: false and under isolated", () => {
      expect(granted(check({ extensions: false }, policyOf())).capabilities.extensions).toBe(false);
      const isolated = granted(check({ extSelectors: ["ext:web"] }, policyOf(), { isolated: true }));
      expect(isolated.capabilities.extensions).toBe(false);
      expect(isolated.capabilities.skills).toBe(false);
      expect(isolated.capabilities.extSelectors).toEqual([]);
    });
  });

  describe("skills", () => {
    it("narrows skills: true through a skill scope", () => {
      const { capabilities } = granted(check({}, policyOf({ skills: { allow: ["Review", "lint"], deny: ["lint"] } })));
      expect(capabilities.skills).toBe(true);
      expect(capabilities.skillScope).toEqual({ allow: ["review", "lint"], deny: ["lint"] });
    });

    it("filters named skills for a file and refuses a caller", () => {
      const policy = policyOf({ skills: { deny: ["Secret"] } });
      const filtered = granted(check({ skills: ["ok", "secret"] }, policy));
      expect(filtered.capabilities.skills).toEqual(["ok"]);
      expect(filtered.filtered).toEqual(["skill secret"]);
      const refused = check({ skills: ["ok", "secret"] }, policy, { caller: ["skills"] });
      expect(refused).toEqual({ kind: "error", message: expect.stringMatching(/^Capability policy: skill "secret"/) });
    });

    it("leaves skills: false alone", () => {
      expect(granted(check({ skills: false }, policyOf({ skills: { allow: ["x"] } }))).capabilities.skills).toBe(false);
    });
  });

  describe("ephemeralNesting", () => {
    it("forces allowed_subagents to [] for an ephemeral agent when off", () => {
      const off = policyOf({}, {}, false);
      expect(granted(check({ allowedSubagents: "all" }, off, { ephemeral: true })).capabilities.allowedSubagents).toEqual([]);
      expect(granted(check({}, off, { ephemeral: true })).capabilities.allowedSubagents).toEqual([]);
    });

    it("refuses a caller allowed_subagents other than []", () => {
      const off = policyOf({}, {}, false);
      expect(check({ allowedSubagents: ["a"] }, off, { ephemeral: true, caller: ["allowedSubagents"] }).kind).toBe("error");
      expect(check({ allowedSubagents: "all" }, off, { ephemeral: true, caller: ["allowedSubagents"] }).kind).toBe("error");
      expect(check({ allowedSubagents: [] }, off, { ephemeral: true, caller: ["allowedSubagents"] }).kind).toBe("ok");
    });

    it("leaves named agents alone", () => {
      const off = policyOf({}, {}, false);
      expect(granted(check({ allowedSubagents: "all" }, off)).capabilities.allowedSubagents).toBe("all");
    });
  });
});
