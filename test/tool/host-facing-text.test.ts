import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { filteredNote, nestedFilteredNote } from "../../src/config/capability-policy.js";
import { modelReplacedNote } from "../../src/config/model-scope.js";
import subagentsExtension from "../../src/index.js";
import { formatTaskNotification } from "../../src/manager/notification-format.js";
import { buildAgentPrompt } from "../../src/session/prompts.js";
import { registerAgentControlTools } from "../../src/tool/agent-control-tools.js";
import { type AgentToolDeps, createAgentTool } from "../../src/tool/agent-tool.js";
import { createNestedSubagentTools } from "../../src/tool/nested-tools.js";
import { getForegroundOutcomeNote, getStatusNote } from "../../src/tool/status-note.js";
import { agentMentionReminder } from "../../src/triggers/mention.js";
import type { AgentRecord } from "../../src/types.js";
import { type Hermetic, hermeticDir, makePi } from "../harness/boot-extension.js";
import { testAgent } from "../harness/test-agents.js";

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
    widget: {} as any,
    fleet: {} as any,
    notifier: {} as any,
    startBackgroundResume: vi.fn(),
    reloadCustomAgents: vi.fn(),
    settings: {
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

const TOOLS_SUFFIX = /\(Tools: [^)]*\)/g;

const STATUSES: AgentRecord["status"][] = ["queued", "running", "completed", "steered", "aborted", "stopped", "error"];

function record(over: Partial<AgentRecord>): AgentRecord {
  return {
    id: "a1",
    type: "Explore",
    description: "Find things",
    status: "completed",
    toolUses: 1,
    startedAt: 1000,
    completedAt: 2000,
    lifetimeUsage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: 0.01 },
    ...over,
  } as AgentRecord;
}

let hermetic: Hermetic | undefined;
let shutdown: (() => Promise<void>) | undefined;

afterEach(async () => {
  await shutdown?.();
  shutdown = undefined;
  hermetic?.restore();
  hermetic = undefined;
});

function registeredTools(settings: Record<string, unknown>, template?: string): ToolLike[] {
  hermetic = hermeticDir({
    settings,
    agentFiles: {
      Narrow: "---\ndescription: Narrow search agent.\ntools: read, grep\n---\n\nYou are Narrow.\n",
    },
  });
  if (template) writeFileSync(join(hermetic.dir, ".pi", "agent-tool-description.md"), template);
  const booted = makePi();
  subagentsExtension(booted.pi);
  shutdown = async () => {
    await booted.lifecycle.get("session_shutdown")?.({}, { hasUI: false, ui: {} } as any);
  };
  return [...booted.tools.values()] as ToolLike[];
}

describe("host-facing text", () => {
  const cases: [string, ToolLike[]][] = [
    ["top-level full description", topLevelTools({ toolDescriptionMode: "full" })],
    ["top-level compact description", topLevelTools({ toolDescriptionMode: "compact" })],
    ["nested", nestedTools()],
  ];

  it.each(cases)("%s names no built-in tool", (_label, tools) => {
    expect(tools.length).toBeGreaterThan(0);
    for (const tool of tools) {
      for (const text of hostFacingStrings(tool)) {
        expect(text.replace(TOOLS_SUFFIX, ""), `${tool.name}: ${text}`).not.toMatch(TOOL_NAME_MENTION);
      }
    }
  });

  const registeredCases: [string, Record<string, unknown>, string | undefined][] = [
    ["full", { toolDescriptionMode: "full" }, undefined],
    ["compact", { toolDescriptionMode: "compact" }, undefined],
    [
      "custom",
      { toolDescriptionMode: "custom" },
      "Types:\n{{typeList}}\n\nShort:\n{{compactTypeList}}\n\nRules:{{isolationGuideline}}\nEND",
    ],
  ];

  it.each(registeredCases)("registered %s mode names no built-in tool outside a Tools suffix", (mode, settings, template) => {
    const tools = registeredTools(settings, template);
    const agent = tools.find((t) => t.name === "agent");
    expect(agent?.description, mode).toContain("(Tools: read, grep)");
    for (const tool of tools) {
      for (const text of hostFacingStrings(tool)) {
        expect(text.replace(TOOLS_SUFFIX, ""), `${mode} ${tool.name}: ${text}`).not.toMatch(TOOL_NAME_MENTION);
      }
    }
  });

  it("task notifications name no built-in tool in any status", () => {
    for (const status of STATUSES) {
      for (const stoppedBy of ["user", "agent"] as const) {
        const text = formatTaskNotification(record({ status, stoppedBy, error: "boom", result: "ok", outputFile: "/tmp/o", toolCallId: "t1" }), 10, true);
        expect(text, `${status}/${stoppedBy}`).not.toMatch(TOOL_NAME_MENTION);
      }
    }
    const truncated = formatTaskNotification(record({ result: "x".repeat(100) }), 10);
    expect(truncated).toContain("truncated");
    expect(truncated).not.toMatch(TOOL_NAME_MENTION);
    expect(formatTaskNotification(record({ result: undefined }), 10)).not.toMatch(TOOL_NAME_MENTION);
  });

  it("status notes name no built-in tool in any status", () => {
    for (const status of STATUSES) {
      for (const stoppedBy of ["user", "agent"] as const) {
        expect(getStatusNote(status, stoppedBy), `${status}/${stoppedBy}`).not.toMatch(TOOL_NAME_MENTION);
        expect(getForegroundOutcomeNote(status, stoppedBy), `${status}/${stoppedBy}`).not.toMatch(TOOL_NAME_MENTION);
      }
    }
  });

  it("policy, model scope and mention notes name no built-in tool", () => {
    const removedNames = / removed .* from this agent\./;
    for (const filtered of [[], ["tool read", "tool grep", "ext:probe", "extension ./ext.mjs"]]) {
      for (const note of [filteredNote({ filtered }), nestedFilteredNote({ filtered })]) {
        if (filtered.length > 0) expect(note).toContain("tool read, tool grep");
        expect(note.replace(removedNames, "")).not.toMatch(TOOL_NAME_MENTION);
      }
    }
    expect(modelReplacedNote(undefined)).toBe("");
    expect(modelReplacedNote("provider/model")).not.toMatch(TOOL_NAME_MENTION);
    expect(agentMentionReminder("Explore")).not.toMatch(TOOL_NAME_MENTION);
  });

  it("append-mode prompt names no built-in tool, less the parent prompt", () => {
    const parent = "PARENT-PROMPT use read and grep and bash";
    const env = { isGitRepo: true, branch: "main", platform: "linux" };
    const config = testAgent("general-purpose", { systemPrompt: "", promptMode: "append" });
    const withParent = buildAgentPrompt(config, "/workspace", env, parent).replace(parent, "");
    const withoutParent = buildAgentPrompt(config, "/workspace", env);
    expect(withParent).toContain("<sub_agent_context>");
    expect(withParent).not.toMatch(TOOL_NAME_MENTION);
    expect(withoutParent).toContain("<sub_agent_context>");
    expect(withoutParent).not.toMatch(TOOL_NAME_MENTION);
  });

  it("strips a Tools suffix before matching", () => {
    const line = "- Narrow: Narrow search agent. (Tools: read, grep)";
    expect(line).toMatch(TOOL_NAME_MENTION);
    expect(line.replace(TOOLS_SUFFIX, "")).not.toMatch(TOOL_NAME_MENTION);
  });

  it("detects a built-in tool name", () => {
    expect("use a direct tool — `read` for a known path").toMatch(TOOL_NAME_MENTION);
    expect("Otherwise use direct tools (read, grep, find)").toMatch(TOOL_NAME_MENTION);
  });
});
