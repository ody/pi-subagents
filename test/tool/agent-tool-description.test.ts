import { afterEach, describe, expect, it, vi } from "vitest";
import { BUILTIN_TOOL_NAMES, registerAgents } from "../../src/agents/agent-types.js";
import { getModelLabelFromConfig } from "../../src/config/model-resolver.js";
import { formatTaskNotification } from "../../src/manager/notification-format.js";
import { createAgentModelsTool } from "../../src/tool/agent-models-tool.js";
import { type AgentToolDeps, createAgentTool } from "../../src/tool/agent-tool.js";
import { buildAgentToolDescription, firstSentence, formatToolsSuffix } from "../../src/tool/agent-tool-description.js";
import { createNestedSubagentTools } from "../../src/tool/nested-tools.js";
import type { AgentConfig, AgentRecord } from "../../src/types.js";

const cfg = (over: Partial<AgentConfig>) => over as AgentConfig;

const CONFIGURED_MODEL = "anthropic/claude-haiku-4-5-20251001";
const CONFIGURED_MODEL_LABEL = "claude-haiku-4-5";
const MODEL_PARAMETER_RULE = "only when the user named a model";

interface ToolLike {
  name: string;
  description?: string;
  promptSnippet?: string;
  promptGuidelines?: string[];
  parameters?: { properties?: Record<string, { description?: string }> };
}

const toolStrings = (tool: ToolLike): string[] => [
  tool.description ?? "",
  tool.promptSnippet ?? "",
  ...(tool.promptGuidelines ?? []),
  ...Object.values(tool.parameters?.properties ?? {}).map((p) => p.description ?? ""),
];

const topLevelAgentTool = (): ToolLike => {
  const pi = { registerTool: vi.fn(), events: { emit: vi.fn(), on: vi.fn() } } as any;
  const deps: AgentToolDeps = {
    manager: {} as any,
    widget: {} as any,
    notifier: {} as any,
    startBackgroundResume: vi.fn(),
    reloadCustomAgents: vi.fn(),
    settings: { toolDescriptionMode: "full", backgroundByDefault: true, defaultJoinMode: "smart", showCost: false } as any,
  };
  return createAgentTool(pi, deps) as ToolLike;
};

const nestedAgentTools = (): ToolLike[] =>
  createNestedSubagentTools({
    manager: {} as any,
    pi: { events: { emit: vi.fn() } } as any,
    parentAgentId: "parent",
    depth: 1,
    maxSubagentDepth: 2,
    allowedSubagents: "all",
    configCwd: "/tmp",
  }) as ToolLike[];

const registerModelAgent = () =>
  registerAgents(new Map([["modeled", cfg({ name: "modeled", description: "Agent with a configured model.", model: CONFIGURED_MODEL })]]));

afterEach(() => registerAgents(new Map()));

describe("formatToolsSuffix", () => {
  it("renders * for an unknown or un-narrowed agent", () => {
    expect(formatToolsSuffix(undefined)).toBe("*");
    expect(formatToolsSuffix(cfg({}))).toBe("*");
  });

  it("renders * for the full built-in set", () => {
    expect(formatToolsSuffix(cfg({ builtinToolNames: [...BUILTIN_TOOL_NAMES] }))).toBe("*");
  });

  it("lists a narrowed set", () => {
    expect(formatToolsSuffix(cfg({ builtinToolNames: ["read", "grep"] }))).toBe("read, grep");
  });

  it("renders none only when the agent can call nothing", () => {
    expect(formatToolsSuffix(cfg({ builtinToolNames: [], isolated: true }))).toBe("none");
    expect(formatToolsSuffix(cfg({ builtinToolNames: [], extensions: false }))).toBe("none");
  });

  it("renders extension-only agents honestly", () => {
    expect(formatToolsSuffix(cfg({ builtinToolNames: [], extensions: true }))).toBe("no built-ins, extension tools only");
  });
});

describe("firstSentence", () => {
  it("cuts at the first sentence end", () => {
    expect(firstSentence("Does a thing. Then more.")).toBe("Does a thing.");
  });

  it("keeps text with no terminator and collapses whitespace", () => {
    expect(firstSentence("no  terminator\nhere")).toBe("no terminator here");
  });

  it("does not cut inside a dotted token", () => {
    expect(firstSentence("Reads v1.2 files. Done.")).toBe("Reads v1.2 files.");
  });
});

describe("getModelLabelFromConfig", () => {
  it("strips the provider prefix and date suffix", () => {
    expect(getModelLabelFromConfig("anthropic/claude-haiku-4-5-20251001")).toBe("claude-haiku-4-5");
    expect(getModelLabelFromConfig("sonnet")).toBe("sonnet");
  });
});

describe("buildAgentToolDescription", () => {
  const base = { mode: "full", worktreeEnabled: true } as const;

  it("gates the isolation guideline", () => {
    const on = buildAgentToolDescription(base);
    expect(on).toContain('Use isolation: "worktree"');
    const off = buildAgentToolDescription({ ...base, worktreeEnabled: false });
    expect(off).not.toContain("isolation:");
  });

  it.each(["full", "compact"] as const)("states the type fit rule and never requires subagent_type in %s mode", (mode) => {
    const text = buildAgentToolDescription({ ...base, mode });
    expect(text).toContain("only when a listed type");
    expect(text).toContain("omit");
    expect(text).not.toMatch(/specify a subagent_type/i);
    expect(text).not.toMatch(/match an available agent type/i);
  });

  it.each(["full", "compact"] as const)("lists a configured model in no %s type entry", (mode) => {
    registerModelAgent();
    const text = buildAgentToolDescription({ ...base, mode });
    expect(text).toContain("- modeled: Agent with a configured model.");
    expect(text).not.toContain(CONFIGURED_MODEL_LABEL);
  });

  it("tells the caller to set model only when the user named one", () => {
    expect(buildAgentToolDescription(base)).toContain(MODEL_PARAMETER_RULE);
  });

  it("compact is shorter than full", () => {
    expect(buildAgentToolDescription({ ...base, mode: "compact" }).length).toBeLessThan(buildAgentToolDescription(base).length);
  });
});

describe("agent tool parameters", () => {
  it("tells the caller to set model only when the user named one, in every tool with a model parameter", () => {
    const tools = [topLevelAgentTool(), createAgentModelsTool() as ToolLike, ...nestedAgentTools()];
    const withModel = tools.filter((tool) => tool.parameters?.properties?.model !== undefined);
    expect(withModel.map((tool) => tool.name).sort()).toEqual(["agent", "agent", "agent_models", "agent_models"]);
    for (const tool of withModel) {
      const description = tool.parameters?.properties?.model?.description ?? "";
      expect(description, tool.name).toContain(MODEL_PARAMETER_RULE);
      expect(description).toMatch(/omit/i);
    }
  });

  it("no string explains how caller and frontmatter values rank", () => {
    for (const tool of [topLevelAgentTool(), createAgentModelsTool() as ToolLike, ...nestedAgentTools()]) {
      for (const text of toolStrings(tool)) {
        expect(text, `${tool.name}: ${text}`).not.toMatch(/agent's default|frontmatter|precedence|overrides? the agent/i);
      }
    }
  });
});

describe("subagent_type requirement", () => {
  it("is stated by no string of the top-level or nested agent tool", () => {
    for (const tool of [topLevelAgentTool(), ...nestedAgentTools()]) {
      for (const text of toolStrings(tool)) {
        expect(text, `${tool.name}: ${text}`).not.toMatch(
          /specify a subagent_type|subagent_type is required|must (pass|specify|provide) (a )?subagent_type/i,
        );
      }
    }
  });

  it("nested subagent_type description states the type fit rule", () => {
    const nestedAgent = nestedAgentTools().find((tool) => tool.name === "agent");
    const subagentType = nestedAgent?.parameters?.properties?.subagent_type?.description ?? "";
    expect(subagentType).toContain("only when a listed type");
  });
});

describe("formatTaskNotification", () => {
  it("shows no label of the agent configured model", () => {
    registerModelAgent();
    const record = {
      id: "a1",
      type: "modeled",
      description: "Do work",
      status: "completed",
      result: "done",
      toolUses: 1,
      startedAt: 0,
      completedAt: 10,
      lifetimeUsage: { input: 1, output: 1, cacheWrite: 0, cacheRead: 0, cost: 0 },
    } as AgentRecord;
    const text = formatTaskNotification(record, 1000);
    expect(text).not.toContain(CONFIGURED_MODEL_LABEL);
    expect(text).not.toContain("haiku");
  });
});
