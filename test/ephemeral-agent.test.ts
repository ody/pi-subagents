import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/session/agent-runner.js", async () => {
  const actual = await vi.importActual<typeof import("../src/session/agent-runner.js")>("../src/session/agent-runner.js");
  return { ...actual, runAgent: vi.fn(), resumeAgent: vi.fn() };
});

import { BUILTIN_TOOL_NAMES, getAllTypes, getAvailableTypes } from "../src/agents/agent-types.js";
import { loadCustomAgents } from "../src/agents/custom-agents.js";
import subagentsExtension from "../src/index.js";
import { runAgent } from "../src/session/agent-runner.js";
import { createNestedSubagentTools } from "../src/tool/nested-tools.js";
import { getDisplayName, getPromptModeLabel } from "../src/ui/agent-format.js";
import { ctx, flush, type Hermetic, hermeticDir, makePi, textOf } from "./helpers/boot-extension.js";

let hermetic: Hermetic | undefined;
let booted: Map<string, any> | undefined;

function boot(settings: Record<string, unknown> = {}, agentFiles: Record<string, string> = {}) {
  hermetic = hermeticDir({ settings: { outputTranscript: false, ...settings }, agentFiles });
  const b = makePi();
  subagentsExtension(b.pi);
  booted = b.lifecycle;
  const tool = b.tools.get("agent");
  const registry = () => (globalThis as any)[Symbol.for("pi-subagents:manager")];
  return { ...b, tool, registry };
}

const run = (tool: any, params: Record<string, unknown>, uiCtx: any = ctx()) =>
  tool.execute("tc", { prompt: "go", description: "find auth files", run_in_background: true, ...params }, undefined, undefined, uiCtx);

const idOf = (result: any): string => /Agent ID: (\S+)/.exec(textOf(result))?.[1] ?? "";
const lastRun = () => vi.mocked(runAgent).mock.lastCall as any[];

beforeEach(() => {
  vi.mocked(runAgent).mockReset();
  vi.mocked(runAgent).mockImplementation(() => new Promise(() => {}) as any);
});

afterEach(async () => {
  await booted?.get("session_shutdown")?.();
  delete (globalThis as any)[Symbol.for("pi-subagents:manager")];
  booted = undefined;
  hermetic?.restore();
  hermetic = undefined;
  vi.restoreAllMocks();
});

describe("an omitted subagent_type", () => {
  it("runs an ephemeral agent built from the defaults", async () => {
    const { tool } = boot();
    const result = await run(tool, {});
    await flush();

    expect(textOf(result)).toContain("Agent started in background");
    const [, type, prompt, options] = lastRun();
    expect(type).toMatch(/^ephemeral-[0-9a-f]{8}$/);
    expect(prompt).toBe("go");
    expect(options.agentConfig).toMatchObject({
      name: type,
      displayName: "Agent",
      description: "find auth files",
      systemPrompt: "",
      promptMode: "append",
      persistSession: false,
      extensions: true,
      skills: true,
      allowedSubagents: [],
    });
    expect(options.capability.capabilities).toMatchObject({
      builtinToolNames: BUILTIN_TOOL_NAMES,
      extensions: true,
      skills: true,
      allowedSubagents: [],
    });
    expect(options.model).toBeUndefined();
    expect(options.thinkingLevel).toBeUndefined();
    expect(options.inheritContext).toBe(false);
    expect(options.isolated).toBe(false);
    expect(options.isolation).toBeUndefined();
  });

  it("runs in the background by default and blocks when asked", async () => {
    const { tool } = boot();
    vi.mocked(runAgent).mockResolvedValue({ responseText: "done", session: { dispose: vi.fn(), messages: [] }, aborted: false, steered: false } as any);
    const background = await tool.execute("tc", { prompt: "go", description: "d" }, undefined, undefined, ctx());
    expect(textOf(background)).toContain("started in background");
    const foreground = await run(tool, { run_in_background: false });
    expect(textOf(foreground)).toContain("Agent completed");
  });

  it("treats a blank subagent_type as omitted", async () => {
    const { tool } = boot();
    await run(tool, { subagent_type: "   " });
    expect(lastRun()[1]).toMatch(/^ephemeral-/);
  });

  it("passes each parameter into the agent and the capability verdict", async () => {
    const { tool } = boot();
    await run(tool, {
      tools: ["read", "grep", "ext:web/fetch"],
      disallowed_tools: ["grep"],
      extensions: ["web", "db"],
      exclude_extensions: ["db"],
      skills: ["review"],
      allowed_subagents: ["scout"],
      prompt_mode: "replace",
      model: undefined,
      thinking: "low",
      max_turns: 7,
      inherit_context: true,
    });
    await flush();
    const options = lastRun()[3];
    expect(options.agentConfig).toMatchObject({
      builtinToolNames: ["read", "grep"],
      extSelectors: ["ext:web/fetch"],
      disallowedTools: ["grep"],
      extensions: ["web", "db"],
      excludeExtensions: ["db"],
      skills: ["review"],
      allowedSubagents: ["scout"],
      promptMode: "replace",
    });
    expect(options.capability.capabilities).toMatchObject({
      builtinToolNames: ["read", "grep"],
      extSelectors: ["ext:web/fetch"],
      extensions: ["web", "db"],
      skills: ["review"],
      allowedSubagents: ["scout"],
    });
    expect(options.thinkingLevel).toBe("low");
    expect(options.maxTurns).toBe(7);
    expect(options.inheritContext).toBe(true);
  });

  it("reads tools: none as no built-in tools and * as all of them", async () => {
    const { tool } = boot();
    await run(tool, { tools: ["none"] });
    expect(lastRun()[3].agentConfig.builtinToolNames).toEqual([]);
    await run(tool, { tools: ["*"] });
    expect(lastRun()[3].agentConfig.builtinToolNames).toEqual(BUILTIN_TOOL_NAMES);
  });

  it("refuses isolated: true with extensions, skills, or an ext: tool", async () => {
    const { tool } = boot();
    for (const [params, fragment] of [
      [{ extensions: ["web"] }, "extensions"],
      [{ skills: true }, "skills"],
      [{ tools: ["read", "ext:web"] }, "ext:"],
    ] as const) {
      const result = await run(tool, { isolated: true, ...params });
      expect(textOf(result)).toContain("isolated: true");
      expect(textOf(result)).toContain(fragment);
    }
    expect(runAgent).not.toHaveBeenCalled();
    await run(tool, { isolated: true, tools: ["read"] });
    expect(lastRun()[3].capability.capabilities).toMatchObject({ extensions: false, skills: false });
  });

  it("refuses allowed_subagents when policy.ephemeralNesting is false", async () => {
    const { tool } = boot({ policy: { ephemeralNesting: false } });
    const refused = await run(tool, { allowed_subagents: "all" });
    expect(textOf(refused)).toMatch(/^Capability policy: allowed_subagents/);
    expect(runAgent).not.toHaveBeenCalled();
    await run(tool, { allowed_subagents: [] });
    expect(lastRun()[3].capability.capabilities.allowedSubagents).toEqual([]);
    await run(tool, {});
    expect(lastRun()[3].capability.capabilities.allowedSubagents).toEqual([]);
  });
});

describe("a named agent", () => {
  it.each([
    ["tools", { tools: ["read"] }],
    ["disallowed_tools", { disallowed_tools: ["bash"] }],
    ["extensions", { extensions: false }],
    ["exclude_extensions", { exclude_extensions: ["x"] }],
    ["skills", { skills: false }],
    ["allowed_subagents", { allowed_subagents: [] }],
    ["prompt_mode", { prompt_mode: "replace" }],
  ])("is an error when %s is passed", async (name, params) => {
    const { tool } = boot({}, { scout: "---\ndescription: scouts\n---\nbody" });
    const result = await run(tool, { subagent_type: "scout", ...params });
    expect(textOf(result)).toContain(`"${name}"`);
    expect(textOf(result)).toContain("Omit subagent_type");
    expect(runAgent).not.toHaveBeenCalled();
  });

  it("ignores the ephemeral parameters on a resume", async () => {
    const { tool } = boot();
    const spawned = await run(tool, {});
    await flush();
    const result = await run(tool, { resume: idOf(spawned), prompt: "more", prompt_mode: "replace" });
    expect(textOf(result)).not.toContain("applies only to an ephemeral agent");
  });
});

describe("identity", () => {
  it("takes the handle from name, then from the description, then falls back to agent, with no alias", async () => {
    const { tool, registry } = boot();
    const byName = idOf(await run(tool, { name: "auth-audit" }));
    const byDescription = idOf(await run(tool, { description: "Find the Auth Files!" }));
    const fallback = idOf(await run(tool, { description: "!!!" }));
    await flush();
    expect(registry().getRecord(byName)).toMatchObject({ handle: "auth-audit", alias: undefined });
    expect(registry().getRecord(byDescription)).toMatchObject({ handle: "find-the-auth-files", alias: undefined });
    expect(registry().getRecord(fallback)).toMatchObject({ handle: "agent", alias: undefined });
  });

  it("caps the handle at the handle length limit", async () => {
    const { tool, registry } = boot();
    const id = idOf(await run(tool, { description: "x".repeat(200) }));
    await flush();
    expect(registry().getRecord(id).handle).toBe("x".repeat(64));
  });

  it("stores the prompt mode and the generic name on the record", async () => {
    const { tool, registry } = boot();
    const append = idOf(await run(tool, {}));
    const replace = idOf(await run(tool, { prompt_mode: "replace" }));
    await flush();
    const twin = registry().getRecord(append);
    const plain = registry().getRecord(replace);
    expect(twin).toMatchObject({ displayName: "Agent", promptMode: "append" });
    expect(plain).toMatchObject({ displayName: "Agent", promptMode: "replace" });
    expect(getDisplayName(twin)).toBe("Agent");
    expect(getPromptModeLabel(twin)).toBe("twin");
    expect(getPromptModeLabel(plain)).toBeUndefined();
  });

  it("carries the minted type on the record", async () => {
    const { tool, registry } = boot();
    const id = idOf(await run(tool, {}));
    await flush();
    expect(registry().getRecord(id).type).toBe(lastRun()[1]);
  });

  it("never enters the registry", async () => {
    const { tool } = boot();
    await run(tool, {});
    await flush();
    const type = lastRun()[1];
    expect(getAllTypes()).not.toContain(type);
    expect(getAvailableTypes()).not.toContain(type);
  });

  it("leaves no tombstone, so an evicted agent cannot be reopened by handle", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "Date"] });
    try {
      const { tool, registry, lifecycle } = boot({ agentMentions: "direct" });
      vi.mocked(runAgent).mockResolvedValue({
        responseText: "done",
        session: { dispose: vi.fn(), messages: [], subscribe: vi.fn(() => () => {}), getActiveToolNames: vi.fn(() => []) },
        aborted: false,
        steered: false,
      } as any);
      const id = idOf(await run(tool, { name: "auth-audit" }));
      await flush();
      const record = registry().getRecord(id);
      record.completedAt = Date.now() - 11 * 60_000;
      await vi.advanceTimersByTimeAsync(60_000);
      expect(registry().getRecord(id)).toBeUndefined();
      const result = await lifecycle.get("input")({ type: "input", text: "@auth-audit again", source: "interactive" }, ctx());
      expect(result).toEqual({ action: "continue" });
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("a nested ephemeral spawn", () => {
  it("runs under a parent whose allowed_subagents is all, narrowed to the parent's tools", async () => {
    const { tool } = boot();
    const finished = { responseText: "done", session: { dispose: vi.fn(), messages: [] }, aborted: false, steered: false } as any;
    let nested: any;
    vi.mocked(runAgent).mockImplementation((async (_ctx: any, _type: string, _prompt: string, opts: any) => {
      if (opts.nestedRuntime.depth === 1) {
        const [nestedAgent] = createNestedSubagentTools({
          manager: opts.nestedRuntime.manager,
          pi: opts.pi,
          parentAgentId: opts.nestedRuntime.parentAgentId,
          depth: 1,
          maxSubagentDepth: 2,
          allowedSubagents: "all",
          configCwd: process.cwd(),
        }) as any[];
        nested = await nestedAgent.execute("n1", { description: "inner helper", prompt: "inner", run_in_background: false, max_turns: 0, thinking: "high" }, undefined, undefined, ctx());
      }
      return finished;
    }) as any);

    await run(tool, { run_in_background: false, tools: ["read"], allowed_subagents: "all" });

    expect(nested.isError).toBe(false);
    const calls = vi.mocked(runAgent).mock.calls as any[][];
    expect(calls).toHaveLength(2);
    expect(calls[1][1]).toMatch(/^ephemeral-[0-9a-f]{8}$/);
    expect(calls[1][3].agentConfig).toMatchObject({ displayName: "Agent", persistSession: false, systemPrompt: "" });
    expect(calls[1][3].capability.capabilities.builtinToolNames).toEqual(["read"]);
    expect(calls[1][3].maxTurns).toBe(0);
    expect(calls[1][3].thinkingLevel).toBe("high");
  });
});

describe("agent files", () => {
  it("skips a file whose name starts with ephemeral- and warns", () => {
    hermetic = hermeticDir({});
    mkdirSync(join(hermetic.dir, ".pi", "agents"), { recursive: true });
    writeFileSync(join(hermetic.dir, ".pi", "agents", "ephemeral-x.md"), "---\ndescription: d\n---\nbody");
    writeFileSync(join(hermetic.dir, ".pi", "agents", "kept.md"), "---\ndescription: d\n---\nbody");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const agents = loadCustomAgents(hermetic.dir);
    expect([...agents.keys()]).toEqual(["kept"]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("ephemeral-"));
  });
});
