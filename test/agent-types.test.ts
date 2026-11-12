import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  BUILTIN_TOOL_NAMES,
  getAgentConfig,
  getAvailableTypes,
  getAvailableTypesIn,
  getConfig,
  getToolNamesForType,
  isValidType,
  registerAgents,
  resolveEnabledTypeIn,
  resolveSpawnType,
  resolveSpawnTypeIn,
  resolveType,
} from "../src/agents/agent-types.js";
import type { AgentConfig } from "../src/types.js";

function makeAgentConfig(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    name: "test-agent",
    description: "Test agent",
    builtinToolNames: ["read", "grep"],
    extensions: false,
    skills: false,
    systemPrompt: "You are a test agent.",
    promptMode: "replace",
    inheritContext: false,
    runInBackground: false,
    isolated: false,
    ...overrides,
  };
}

describe("agent type registry", () => {
  beforeEach(() => {
    registerAgents(new Map());
  });

  describe("empty registry", () => {
    it("has no available types", () => {
      expect(getAvailableTypes()).toEqual([]);
      expect(isValidType("general-purpose")).toBe(false);
      expect(isValidType("nonexistent")).toBe(false);
      expect(isValidType("")).toBe(false);
    });

    it("resolves no type", () => {
      expect(resolveType("Explore")).toBeUndefined();
    });
  });

  describe("registered agents", () => {
    it("looks types up case-insensitively", () => {
      registerAgents(new Map([["Explore", makeAgentConfig({ name: "Explore", model: "anthropic/claude-haiku-4-5" })]]));
      expect(isValidType("explore")).toBe(true);
      expect(isValidType("EXPLORE")).toBe(true);
      expect(getAgentConfig("explore")?.name).toBe("Explore");
      expect(getAgentConfig("explore")?.model).toBe("anthropic/claude-haiku-4-5");
      expect(resolveType("explore")).toBe("Explore");
      expect(resolveType("nonexistent")).toBeUndefined();
    });

    it("BUILTIN_TOOL_NAMES includes all built-in tools", () => {
      expect(BUILTIN_TOOL_NAMES).toContain("read");
      expect(BUILTIN_TOOL_NAMES).toContain("bash");
      expect(BUILTIN_TOOL_NAMES).toContain("edit");
      expect(BUILTIN_TOOL_NAMES).toContain("write");
      expect(BUILTIN_TOOL_NAMES).toContain("grep");
      expect(BUILTIN_TOOL_NAMES).toContain("find");
      expect(BUILTIN_TOOL_NAMES).toContain("ls");
      expect(BUILTIN_TOOL_NAMES.length).toBeGreaterThanOrEqual(7);
    });
  });

  describe("user agents", () => {
    it("registers and retrieves user agents", () => {
      const agents = new Map([["auditor", makeAgentConfig({ name: "auditor", description: "Auditor" })]]);
      registerAgents(agents);

      expect(isValidType("auditor")).toBe(true);
      expect(getAgentConfig("auditor")?.description).toBe("Auditor");
    });

    it("includes user agents in available types", () => {
      const agents = new Map([["auditor", makeAgentConfig({ name: "auditor" })]]);
      registerAgents(agents);

      expect(getAvailableTypes()).toEqual(["auditor"]);
    });

    it("getConfig returns config for user agents", () => {
      const agents = new Map([["auditor", makeAgentConfig({
        name: "auditor",
        description: "Security auditor",
        builtinToolNames: ["read", "grep"],
        extensions: false,
        skills: true,
      })]]);
      registerAgents(agents);

      const config = getConfig("auditor");
      expect(config.displayName).toBe("auditor");
      expect(config.description).toBe("Security auditor");
      expect(config.builtinToolNames).toEqual(["read", "grep"]);
      expect(config.extensions).toBe(false);
      expect(config.skills).toBe(true);
    });

    it("getConfig returns extension allowlist for user agents", () => {
      const agents = new Map([["partial", makeAgentConfig({
        name: "partial",
        extensions: ["web-search"],
        skills: ["planning"],
      })]]);
      registerAgents(agents);

      const config = getConfig("partial");
      expect(config.extensions).toEqual(["web-search"]);
      expect(config.skills).toEqual(["planning"]);
    });

    it("getToolNamesForType works for user agents", () => {
      const agents = new Map([["auditor", makeAgentConfig({
        name: "auditor",
        builtinToolNames: ["read", "grep", "find"],
      })]]);
      registerAgents(agents);

      const names = getToolNamesForType("auditor");
      expect(names).toEqual(["read", "grep", "find"]);
    });

    it("getToolNamesForType honors an explicit empty builtinToolNames as zero built-ins", () => {
      const agents = new Map([["ext-only", makeAgentConfig({
        name: "ext-only",
        builtinToolNames: [],
      })]]);
      registerAgents(agents);

      expect(getToolNamesForType("ext-only")).toEqual([]);
    });

    it("getConfig returns a generic config for unregistered types", () => {
      const config = getConfig("nonexistent");
      expect(config.displayName).toBe("Agent");
      expect(config.description).toBe("Agent");
      expect(config.promptMode).toBeUndefined();
    });

    it("clearing user agents empties the registry", () => {
      const agents = new Map([["auditor", makeAgentConfig({ name: "auditor" })]]);
      registerAgents(agents);
      expect(isValidType("auditor")).toBe(true);

      registerAgents(new Map());
      expect(isValidType("auditor")).toBe(false);
      expect(getAvailableTypes()).toEqual([]);
    });

    it("disabled agent is excluded from available types", () => {
      const agents = new Map([["Plan", makeAgentConfig({
        name: "Plan",
        enabled: false,
      })]]);
      registerAgents(agents);

      expect(isValidType("Plan")).toBe(false);
      expect(getAvailableTypes()).not.toContain("Plan");
    });

    it("getConfig treats a disabled agent as unregistered", () => {
      const agents = new Map([["general-purpose", makeAgentConfig({
        name: "general-purpose",
        enabled: false,
      })]]);
      registerAgents(agents);

      expect(isValidType("general-purpose")).toBe(false);
      const config = getConfig("general-purpose");
      expect(config.displayName).toBe("Agent");
    });
  });

  describe("BUILTIN_TOOL_NAMES", () => {
    const EXPECTED = ["read", "bash", "edit", "write", "grep", "find", "ls"];

    it("contains at least the 7 known built-ins", () => {
      for (const name of EXPECTED) {
        expect(BUILTIN_TOOL_NAMES).toContain(name);
      }
    });

    it("has no duplicate entries", () => {
      expect(new Set(BUILTIN_TOOL_NAMES).size).toBe(BUILTIN_TOOL_NAMES.length);
    });
  });
});

describe("resolveSpawnType — an unresolved type is an error", () => {
  afterEach(() => {
    registerAgents(new Map());
  });

  const roster = () => new Map([
    ["scout", makeAgentConfig({ name: "scout" })],
    ["retired", makeAgentConfig({ name: "retired", enabled: false })],
    ["router", makeAgentConfig({ name: "router" })],
  ]);

  it("resolves an enabled type case-insensitively", () => {
    registerAgents(roster());
    expect(resolveSpawnType("SCOUT")).toEqual({ ok: true, type: "scout" });
  });

  it("rejects unknown types and lists the enabled ones", () => {
    registerAgents(roster());
    const r = resolveSpawnType("typoo");
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("expected rejection");
    expect(r.message).toContain('Unknown or disabled agent type: "typoo"');
    expect(r.message).toContain("scout");
    expect(r.message).not.toContain("retired");
  });

  it("treats a disabled type as unresolvable, not as a valid name", () => {
    registerAgents(roster());
    expect(resolveSpawnType("retired").ok).toBe(false);
  });

  it("refuses to guess between two types differing only by case", () => {
    registerAgents(new Map([
      ["Scout", makeAgentConfig({ name: "Scout" })],
      ["scout", makeAgentConfig({ name: "scout" })],
    ]));
    expect(resolveSpawnType("scout")).toEqual({ ok: true, type: "scout" });
    expect(resolveSpawnType("SCOUT").ok).toBe(false);
  });

  it("treats a missing type like any other unresolvable one", () => {
    registerAgents(roster());
    for (const empty of ["", "   ", undefined]) {
      const r = resolveSpawnType(empty);
      expect(r.ok).toBe(false);
      if (r.ok) throw new Error("expected rejection");
      expect(r.message).toContain("No agent type given");
    }
  });

  it("resolves strictly for nested delegation too", () => {
    const registry = roster();
    expect(resolveEnabledTypeIn(registry, "typoo")).toBeUndefined();
    expect(resolveEnabledTypeIn(registry, "retired")).toBeUndefined();
    expect(resolveEnabledTypeIn(registry, " SCOUT ")).toBe("scout");
    expect(resolveSpawnTypeIn(registry, "typoo").ok).toBe(false);
  });

  it("an empty registry yields no available types and an error listing none", () => {
    const empty = new Map<string, AgentConfig>();
    expect(getAvailableTypesIn(empty)).toEqual([]);
    const r = resolveSpawnTypeIn(empty, "anything");
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("expected rejection");
    expect(r.message).toContain('Unknown or disabled agent type: "anything"');
    expect(r.message).toContain("Available: (none)");
  });

  it("lists the enabled types when the requested one is unresolved", () => {
    registerAgents(roster());
    const r = resolveSpawnType("general-purpose");
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("expected rejection");
    expect(r.message).toContain("Available: scout, router.");
  });
});
