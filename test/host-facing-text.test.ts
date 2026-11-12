import { describe, expect, it, vi } from "vitest";
import { registerAgentControlTools } from "../src/tool/agent-control-tools.js";
import { type AgentToolDeps, createAgentTool } from "../src/tool/agent-tool.js";
import { createNestedSubagentTools } from "../src/tool/nested-tools.js";

const BUILT_IN_TOOL_NAMES = ["read", "bash", "edit", "write", "grep", "find", "ls"];
const NAME_ALTERNATION = BUILT_IN_TOOL_NAMES.join("|");
const TOOL_NAME_MENTION = new RegExp(
  `\`(?:${NAME_ALTERNATION})\`|\\b(?:grep|bash)\\b|\\b(?:${NAME_ALTERNATION})\\s*,\\s*(?:${NAME_ALTERNATION})\\b|\\b(?:use|using|call|prefer)\\s+(?:the\\s+)?(?:${NAME_ALTERNATION})\\b`,
  "i",
);

interface ToolLike {
  name: string;
  description?: string;
  promptSnippet?: string;
  promptGuidelines?: string[];
  parameters?: { properties?: Record<string, { description?: string }> };
}

function hostFacingStrings(tool: ToolLike): string[] {
  const parameterDescriptions = Object.values(tool.parameters?.properties ?? {}).map((p) => p.description ?? "");
  return [tool.description ?? "", tool.promptSnippet ?? "", ...(tool.promptGuidelines ?? []), ...parameterDescriptions];
}

function topLevelTools(over: Partial<AgentToolDeps["settings"]>): ToolLike[] {
  const registered: ToolLike[] = [];
  const pi = { registerTool: (tool: ToolLike) => registered.push(tool), events: { emit: vi.fn(), on: vi.fn() } } as any;
  const deps: AgentToolDeps = {
    manager: {} as any,
    scheduler: {} as any,
    widget: {} as any,
    fleet: {} as any,
    notifier: {} as any,
    startBackgroundResume: vi.fn(),
    reloadCustomAgents: vi.fn(),
    settings: {
      schedulingEnabled: true,
      toolDescriptionMode: "full",
      backgroundByDefault: true,
      defaultJoinMode: "smart",
      showCost: false,
      ...over,
    } as any,
  };
  registerAgentControlTools(pi, {
    manager: {} as any,
    notifier: {} as any,
    settings: { showCost: false },
    resolveAgentRef: () => undefined,
    usageReporting: { settings: { reportUsage: false }, pendingUsage: new Map() } as any,
  });
  return [createAgentTool(pi, deps) as ToolLike, ...registered];
}

function nestedTools(): ToolLike[] {
  return createNestedSubagentTools({
    manager: {} as any,
    pi: { events: { emit: vi.fn() } } as any,
    parentAgentId: "parent",
    depth: 1,
    maxSubagentDepth: 2,
    allowedSubagents: "all",
    configCwd: "/tmp",
  }) as ToolLike[];
}

describe("host-facing text", () => {
  const cases: [string, ToolLike[]][] = [
    ["top-level full description", topLevelTools({ toolDescriptionMode: "full" })],
    ["top-level compact description", topLevelTools({ toolDescriptionMode: "compact" })],
    ["top-level without scheduling", topLevelTools({ schedulingEnabled: false })],
    ["nested", nestedTools()],
  ];

  it.each(cases)("%s names no built-in tool", (_label, tools) => {
    expect(tools.length).toBeGreaterThan(0);
    for (const tool of tools) {
      for (const text of hostFacingStrings(tool)) {
        expect(text, `${tool.name}: ${text}`).not.toMatch(TOOL_NAME_MENTION);
      }
    }
  });

  it("detects a built-in tool name", () => {
    expect("use a direct tool — `read` for a known path").toMatch(TOOL_NAME_MENTION);
    expect("Otherwise use direct tools (read, grep, find)").toMatch(TOOL_NAME_MENTION);
  });
});
