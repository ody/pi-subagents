import { describe, expect, it, vi } from "vitest";
import { SUBAGENT_TOOL_NAMES } from "../src/session/extension-scope.js";
import { type AgentToolDeps, createAgentTool } from "../src/tool/agent-tool.js";
import { createNestedSubagentTools, NESTED_TOOL_NAMES } from "../src/tool/nested-tools.js";

const LOWERCASE_TOOL_NAME = /^[a-z][a-z0-9_]*$/;

function topLevelAgentTool() {
  const pi = { events: { emit: vi.fn(), on: vi.fn() } } as any;
  const deps = {
    manager: {} as any,
    scheduler: {} as any,
    widget: {} as any,
    fleet: {} as any,
    notifier: {} as any,
    startBackgroundResume: vi.fn(),
    reloadCustomAgents: vi.fn(),
    settings: {
      schedulingEnabled: false,
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

  it("registers the top-level agent tool under SUBAGENT_TOOL_NAMES.AGENT", () => {
    expect(topLevelAgentTool().name).toBe(SUBAGENT_TOOL_NAMES.AGENT);
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
