import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerAgents } from "../../src/agents/agent-types.js";
import { checkCapabilityPolicy } from "../../src/config/capability-policy.js";
import type { LoadedPolicy } from "../../src/config/capability-policy-config.js";
import { isScopeModelsEnabled, setScopeModelsEnabled } from "../../src/config/model-scope.js";
import subagentsExtension from "../../src/index.js";
import { EXCLUDED_TOOL_NAMES, SUBAGENT_TOOL_NAMES } from "../../src/session/extension-scope.js";
import { createAgentModelsTool } from "../../src/tool/agent-models-tool.js";
import { createNestedSubagentTools } from "../../src/tool/nested-tools.js";
import type { AgentConfig } from "../../src/types.js";
import { ctx, type Hermetic, hermeticDir, makePi, textOf } from "../harness/boot-extension.js";
import { testAgent } from "../harness/test-agents.js";

const MODELS = [
  { id: "claude-opus-4-6", name: "Claude Opus 4.6", provider: "anthropic" },
  { id: "claude-haiku-4-5", name: "Claude Haiku 4.5", provider: "anthropic" },
  { id: "gpt-4o", name: "GPT-4o", provider: "openai" },
];

const SONNETS = [
  { id: "claude-sonnet-4-5-20241022", name: "Claude Sonnet 4.5", provider: "anthropic" },
  { id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6", provider: "anthropic" },
];

function registry(models = MODELS) {
  return { getAll: () => models, getAvailable: () => models, find: () => undefined };
}

interface ToolResult {
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
}

async function run(params: { model?: string }, models = MODELS, cwd = process.cwd()): Promise<ToolResult> {
  const tool = createAgentModelsTool(cwd);
  const context = { cwd, modelRegistry: registry(models) };
  return (await tool.execute("call-1", params, undefined, undefined, context as never)) as ToolResult;
}

function textOfResult(result: ToolResult): string {
  return result.content.map((block) => block.text).join("\n");
}

function toolStrings(): string[] {
  const tool = createAgentModelsTool();
  const parameters = tool.parameters as { properties?: Record<string, { description?: string }> };
  return [
    tool.description,
    tool.promptSnippet ?? "",
    ...(tool.promptGuidelines ?? []),
    ...Object.values(parameters.properties ?? {}).map((parameter) => parameter.description ?? ""),
  ];
}

describe("agent_models tool", () => {
  let projectDir: string;
  let agentDir: string;
  let prevAgentDir: string | undefined;
  let prevEnabled: boolean;

  beforeEach(() => {
    projectDir = mkdtempSync(join(tmpdir(), "pi-models-project-"));
    agentDir = mkdtempSync(join(tmpdir(), "pi-models-global-"));
    prevAgentDir = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = agentDir;
    prevEnabled = isScopeModelsEnabled();
    setScopeModelsEnabled(false);
  });

  afterEach(() => {
    setScopeModelsEnabled(prevEnabled);
    if (prevAgentDir == null) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = prevAgentDir;
    rmSync(projectDir, { recursive: true, force: true });
    rmSync(agentDir, { recursive: true, force: true });
  });

  function setEnabledModels(models: string[]) {
    mkdirSync(join(projectDir, ".pi"), { recursive: true });
    writeFileSync(join(projectDir, ".pi", "settings.json"), JSON.stringify({ enabledModels: models }));
  }

  it("lists the accepted models with no parameter", async () => {
    const text = textOfResult(await run({}, MODELS, projectDir));
    expect(text).toContain("Accepted models:");
    expect(text).toContain("  anthropic/claude-haiku-4-5");
    expect(text).toContain("  anthropic/claude-opus-4-6");
    expect(text).toContain("  openai/gpt-4o");
  });

  it("lists the scoped set when scopeModels is on and enabledModels resolves", async () => {
    setScopeModelsEnabled(true);
    setEnabledModels(["anthropic/claude-haiku-4-5"]);
    const text = textOfResult(await run({}, MODELS, projectDir));
    expect(text).toContain("  anthropic/claude-haiku-4-5");
    expect(text).not.toContain("claude-opus");
    expect(text).not.toContain("gpt-4o");
  });

  it("lists the full catalog when enabledModels resolves to nothing usable", async () => {
    setScopeModelsEnabled(true);
    setEnabledModels(["anthropic/*"]);
    const text = textOfResult(await run({}, MODELS, projectDir));
    expect(text).toContain("anthropic/claude-opus-4-6");
    expect(text).toContain("openai/gpt-4o");
  });

  it("reports the provider/id a resolved model becomes", async () => {
    const result = await run({ model: "haiku" }, MODELS, projectDir);
    expect(result.isError).toBeFalsy();
    expect(textOfResult(result)).toContain("Accepted model: anthropic/claude-haiku-4-5");
  });

  it("treats a blank model as absent", async () => {
    const text = textOfResult(await run({ model: "   " }, MODELS, projectDir));
    expect(text).toContain("Accepted models:");
    expect(text).not.toContain("Accepted model:");
  });

  it("reports an unmatched model with the accepted models", async () => {
    const result = await run({ model: "nonexistent-model" }, MODELS, projectDir);
    expect(result.isError).toBe(true);
    const text = textOfResult(result);
    expect(text).toContain('Model not found: "nonexistent-model"');
    expect(text).toContain("  openai/gpt-4o");
  });

  it("reports an ambiguous model with the accepted models", async () => {
    const result = await run({ model: "sonnet" }, SONNETS, projectDir);
    expect(result.isError).toBe(true);
    const text = textOfResult(result);
    expect(text).toContain('Model "sonnet" is ambiguous');
    expect(text).toContain("  anthropic/claude-sonnet-4-6");
  });

  it("reports an out-of-scope model with the scoped set", async () => {
    setScopeModelsEnabled(true);
    setEnabledModels(["anthropic/claude-haiku-4-5"]);
    const result = await run({ model: "anthropic/claude-opus-4-6" }, MODELS, projectDir);
    expect(result.isError).toBe(true);
    const text = textOfResult(result);
    expect(text).toContain("Model not in scope");
    const [, accepted = ""] = text.split("Accepted models:");
    expect(accepted).toContain("  anthropic/claude-haiku-4-5");
    expect(accepted).not.toContain("claude-opus");
  });

  it("states that listing a model does not mean to set one", async () => {
    const results = [
      await run({}, MODELS, projectDir),
      await run({ model: "haiku" }, MODELS, projectDir),
      await run({ model: "nonexistent-model" }, MODELS, projectDir),
    ];
    for (const result of results) {
      const text = textOfResult(result);
      expect(text).toContain("Listing a model does not mean to set one.");
      expect(text).toContain("Set model only when the user named a model.");
    }
  });
});

describe("agent_models guidance", () => {
  it("tells the model to check a user-named model, that matching is fuzzy, and that a miss lists the set", () => {
    const [description] = toolStrings();
    const named = description.indexOf("only to check a model the user named");
    const fuzzy = description.indexOf("fuzzily");
    const miss = description.indexOf("matches nothing returns the accepted models");
    expect(named).toBeGreaterThan(-1);
    expect(fuzzy).toBeGreaterThan(named);
    expect(miss).toBeGreaterThan(fuzzy);
  });

  it("tells the model to omit the parameter and skip the tool otherwise", () => {
    expect(toolStrings()[0]).toContain("Otherwise omit model and skip this tool");
  });

  it("states the model parameter rule and never names an agent's configured model", () => {
    const modeled = { name: "modeled", description: "Agent with a model.", model: "anthropic/claude-haiku-4-5" };
    registerAgents(new Map([["modeled", testAgent("modeled", modeled) as AgentConfig]]));
    const parameters = createAgentModelsTool().parameters as { properties?: Record<string, { description?: string }> };
    const modelParameter = parameters.properties?.model?.description ?? "";
    expect(modelParameter).toContain("only when the user named a model");
    expect(modelParameter).toMatch(/omit/i);
    for (const text of toolStrings()) {
      expect(text).not.toMatch(/configured|frontmatter|pinned|precedence|overrides? the agent/i);
    }
    registerAgents(new Map());
  });

  it("names no host tool", () => {
    for (const text of toolStrings()) {
      expect(text).not.toMatch(/\b(read|bash|edit|write|grep|find|ls)\b/i);
    }
  });
});

describe("agent_models registration", () => {
  it("is named agent_models in both name sets", () => {
    expect(SUBAGENT_TOOL_NAMES.MODELS).toBe("agent_models");
    expect(EXCLUDED_TOOL_NAMES).toContain("agent_models");
  });

  it("sits in the nested tool set whenever the agent tool does", () => {
    const tools = createNestedSubagentTools({
      manager: {} as never,
      pi: {} as never,
      parentAgentId: "parent",
      depth: 1,
      maxSubagentDepth: 2,
      allowedSubagents: ["scout"],
      configCwd: "/tmp",
    });
    expect(tools.map((tool) => tool.name)).toContain("agent_models");
  });

  it("is registered by the extension beside the agent tool", () => {
    let hermetic: Hermetic | undefined;
    const booted = makePi();
    hermetic = hermeticDir({ settings: { toolDescriptionMode: "compact" } });
    subagentsExtension(booted.pi);
    expect([...booted.tools.keys()]).toEqual(expect.arrayContaining(["agent", "agent_models"]));
    hermetic.restore();
  });

  it("spawns nothing and writes no agent:record entry", async () => {
    const hermetic = hermeticDir({ settings: { toolDescriptionMode: "compact" } });
    const booted = makePi();
    subagentsExtension(booted.pi);
    const tool = booted.tools.get("agent_models");
    expect(tool).toBeDefined();
    const result = await tool.execute("call-1", {}, undefined, undefined, ctx() as never);
    expect(textOf(result)).toContain("Accepted models:");
    expect(booted.pi.appendEntry).not.toHaveBeenCalled();
    expect(booted.pi.events.emit).not.toHaveBeenCalledWith("agent:started", expect.anything());
    await booted.lifecycle.get("session_shutdown")?.({}, { hasUI: false, ui: {} } as never);
    hermetic.restore();
    vi.restoreAllMocks();
  });

  it("is neither granted nor denied by policy.tools", () => {
    const policy: LoadedPolicy = { global: { tools: { deny: ["agent_models"] } }, project: {}, ephemeralNesting: true, problems: [] };
    const denied = checkCapabilityPolicy({
      config: { extensions: true, skills: true },
      callerSupplied: new Set(),
      ephemeral: false,
      cwd: "/tmp",
      policy,
    });
    expect(denied.kind).toBe("ok");
    if (denied.kind !== "ok") return;
    expect(denied.capabilities.disallowedTools).not.toContain("agent_models");

    const deniedAgent = checkCapabilityPolicy({
      config: { extensions: true, skills: true },
      callerSupplied: new Set(),
      ephemeral: false,
      cwd: "/tmp",
      policy: { global: { tools: { deny: ["agent"] } }, project: {}, ephemeralNesting: true, problems: [] },
    });
    expect(deniedAgent.kind).toBe("ok");
    if (deniedAgent.kind !== "ok") return;
    expect(deniedAgent.capabilities.disallowedTools).toContain("agent");

    const allowed = checkCapabilityPolicy({
      config: { extensions: true, skills: true },
      callerSupplied: new Set(),
      ephemeral: false,
      cwd: "/tmp",
      policy: { global: { tools: { allow: ["read"] } }, project: {}, ephemeralNesting: true, problems: [] },
    });
    expect(allowed.kind).toBe("ok");
  });
});
