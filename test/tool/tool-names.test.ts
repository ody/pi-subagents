import { describe, expect, it, vi } from "vitest";
import { SUBAGENT_TOOL_NAMES } from "../../src/session/extension-scope.js";
import { createAgentModelsTool } from "../../src/tool/agent-models-tool.js";
import { type AgentToolDeps, createAgentTool } from "../../src/tool/agent-tool.js";
import { createNestedSubagentTools, NESTED_TOOL_NAMES } from "../../src/tool/nested-tools.js";

const LOWERCASE_TOOL_NAME = /^[a-z][a-z0-9_]*$/;

function topLevelAgentTool() {
  const pi = { events: { emit: vi.fn(), on: vi.fn() } } as any;
  const deps = {
    manager: {} as any,
    widget: {} as any,
    notifier: {} as any,
    startBackgroundResume: vi.fn(),
    reloadCustomAgents: vi.fn(),
    settings: {
      toolDescriptionMode: "compact",
      backgroundByDefault: true,
      defaultJoinMode: "smart",
      showCost: false,
    } as any,
  } as AgentToolDeps;
  return createAgentTool(pi, deps);
}

describe("tool names", () => {
  it("names every top-level subagent tool in lowercase", () => {
    for (const name of Object.values(SUBAGENT_TOOL_NAMES)) {
      expect(name).toMatch(LOWERCASE_TOOL_NAME);
    }
  });

  it("names every nested tool in lowercase", () => {
    for (const name of NESTED_TOOL_NAMES) {
      expect(name).toMatch(LOWERCASE_TOOL_NAME);
    }
  });

  it("names the delegation tool agent in both registrations", () => {
    expect(SUBAGENT_TOOL_NAMES.AGENT).toBe("agent");
    expect(NESTED_TOOL_NAMES[0]).toBe("agent");
  });

  it("prefixes every lifecycle tool with agent_ in both registrations", () => {
    expect(SUBAGENT_TOOL_NAMES.MODELS).toBe("agent_models");
    expect(SUBAGENT_TOOL_NAMES.GET_RESULT).toBe("agent_get_result");
    expect(SUBAGENT_TOOL_NAMES.STEER).toBe("agent_steer");
    expect(SUBAGENT_TOOL_NAMES.STOP).toBe("agent_stop");
    expect(NESTED_TOOL_NAMES.slice(0, 2)).toEqual(["agent", "agent_models"]);
    expect(NESTED_TOOL_NAMES.slice(2)).toEqual(["agent_get_result", "agent_steer", "agent_stop"]);
  });

  it("registers the top-level agent tool under SUBAGENT_TOOL_NAMES.AGENT", () => {
    expect(topLevelAgentTool().name).toBe(SUBAGENT_TOOL_NAMES.AGENT);
  });

  it("registers the top-level models tool under SUBAGENT_TOOL_NAMES.MODELS", () => {
    expect(createAgentModelsTool().name).toBe(SUBAGENT_TOOL_NAMES.MODELS);
  });

  it("registers the nested tools under NESTED_TOOL_NAMES", () => {
    const tools = createNestedSubagentTools({
      manager: {} as any,
      pi: {} as any,
      parentAgentId: "parent-1",
      depth: 1,
      maxSubagentDepth: 2,
      allowedSubagents: "all",
      configCwd: "/tmp",
    });
    expect(tools.map((tool) => tool.name)).toEqual([...NESTED_TOOL_NAMES]);
  });
});
