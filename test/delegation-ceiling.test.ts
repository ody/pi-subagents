import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerAgents } from "../src/agents/agent-types.js";
import { loadCustomAgents } from "../src/agents/custom-agents.js";
import type { CapabilityDeclaration, EffectiveCapabilities } from "../src/config/capability-policy.js";
import { createNestedSubagentTools, type NestedAgentManager } from "../src/tool/nested-tools.js";
import { grant } from "./helpers/capability.js";

let cwd: string;
let agentDir: string;
let prevAgentDir: string | undefined;
let manager: NestedAgentManager;
let spawnAndWait: ReturnType<typeof vi.fn>;
let parent: { id: string; capabilities?: EffectiveCapabilities } | undefined;

function writeAgent(name: string, frontmatter: string) {
  const dir = join(cwd, ".pi", "agents");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${name}.md`), `---\ndescription: ${name}\n${frontmatter}---\n${name}\n`);
}

function parentOf(declaration: Partial<CapabilityDeclaration>, options: { isolated?: boolean } = {}) {
  parent = { id: "parent-1", capabilities: grant(declaration, options).capabilities };
}

function ctx() {
  const notify = vi.fn();
  return { cwd, model: undefined, modelRegistry: { find: vi.fn(), getAvailable: () => [], getAll: () => [] }, ui: { notify } } as any;
}

async function spawnChild(type: string, params: Record<string, unknown> = {}, uiCtx = ctx()) {
  const [agent] = createNestedSubagentTools({
    manager,
    pi: {} as any,
    parentAgentId: "parent-1",
    depth: 1,
    maxSubagentDepth: 3,
    allowedSubagents: "all",
    configCwd: cwd,
  });
  const result = await (agent as any).execute(
    "call-1",
    { subagent_type: type, description: "child", prompt: "go", ...params },
    undefined,
    undefined,
    uiCtx,
  );
  return { result, uiCtx, options: spawnAndWait.mock.calls[0]?.[4] };
}

const capabilitiesOf = (options: any): EffectiveCapabilities => options.capability.capabilities;
const textOf = (result: any): string => result.content[0].text;

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), "delegation-ceiling-"));
  agentDir = mkdtempSync(join(tmpdir(), "delegation-ceiling-agentdir-"));
  prevAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  parent = undefined;
  spawnAndWait = vi.fn(async (_pi, _ctx, type) => ({
    id: "child-1",
    record: { id: "child-1", type, status: "completed", result: "done", parentAgentId: "parent-1" },
  }));
  manager = {
    spawn: vi.fn(),
    spawnAndWait,
    awaitStartup: vi.fn(async () => {}),
    getRecord: (id: string) => (id === "parent-1" ? parent : undefined),
    resume: vi.fn(),
    abort: vi.fn(),
  } as any;
});

afterEach(() => {
  if (prevAgentDir == null) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = prevAgentDir;
  registerAgents(new Map());
  rmSync(cwd, { recursive: true, force: true });
  rmSync(agentDir, { recursive: true, force: true });
});

function load() {
  registerAgents(loadCustomAgents(cwd));
}

describe("a nested child never exceeds its parent's tools", () => {
  it("narrows the child's built-in tools to the parent's", async () => {
    writeAgent("child", "tools: read, bash, grep\n");
    load();
    parentOf({ builtinToolNames: ["read", "grep"] });
    const { result, options, uiCtx } = await spawnChild("child");
    expect(capabilitiesOf(options).builtinToolNames).toEqual(["read", "grep"]);
    expect(options.capability.filtered).toEqual(["tool bash"]);
    expect(textOf(result)).toContain("tool bash");
    expect(textOf(result)).toContain("parent agent's capabilities");
    expect(uiCtx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("tool bash"), "warning");
  });

  it("applies the parent's disallowed_tools to the child", async () => {
    writeAgent("child", "tools: read, write\n");
    load();
    parentOf({ disallowedTools: ["write"] });
    const { options } = await spawnChild("child");
    expect(capabilitiesOf(options).builtinToolNames).toEqual(["read"]);
  });

  it("carries a parent's disallowed extension tool onto the child", async () => {
    writeAgent("child", "tools: read\n");
    load();
    parentOf({ disallowedTools: ["web_fetch"] });
    const { options } = await spawnChild("child");
    expect(capabilitiesOf(options).disallowedTools).toContain("web_fetch");
  });

  it("expands a child with no ext selectors to the parent's selectors", async () => {
    writeAgent("child", "tools: read\n");
    load();
    parentOf({ extSelectors: ["ext:web", "ext:db/query"] });
    const { options } = await spawnChild("child");
    expect(capabilitiesOf(options).extSelectors).toEqual(["ext:web", "ext:db/query"]);
    expect(capabilitiesOf(options).noExtensionTools).toBe(false);
  });

  it("gives a child no extension tools when the parent has none", async () => {
    writeAgent("child", "tools: read\n");
    load();
    parentOf({ extensions: false });
    const { options } = await spawnChild("child");
    expect(capabilitiesOf(options).extensions).toBe(false);
  });

  it("narrows a child's ext: selector to the tools the parent may call", async () => {
    writeAgent("child", "tools: read, ext:web\n");
    load();
    parentOf({ extSelectors: ["ext:web/fetch"] });
    const { options } = await spawnChild("child");
    expect(capabilitiesOf(options).extSelectors).toEqual(["ext:web/fetch"]);
  });

  it("drops a selector for an extension the parent cannot call, leaving no extension tools", async () => {
    writeAgent("child", "tools: read, ext:db\n");
    load();
    parentOf({ extSelectors: ["ext:web"] });
    const { options } = await spawnChild("child");
    expect(capabilitiesOf(options).extSelectors).toEqual([]);
    expect(capabilitiesOf(options).noExtensionTools).toBe(true);
  });

  it("keeps parent denials of a whole extension's tools", async () => {
    writeAgent("child", "tools: read\n");
    load();
    parentOf({ extSelectors: ["ext:web", "ext:db"] });
    parent!.capabilities = { ...parent!.capabilities!, deniedExtensionNames: ["db"] };
    const { options } = await spawnChild("child");
    expect(capabilitiesOf(options).extSelectors).toEqual(["ext:web"]);
    expect(capabilitiesOf(options).deniedExtensionNames).toEqual(["db"]);
  });
});

describe("a nested child never exceeds its parent's extensions and skills", () => {
  it("narrows extensions: true to the parent's list", async () => {
    writeAgent("child", "tools: read\nextensions: true\n");
    load();
    parentOf({ extensions: ["web"] });
    const { options } = await spawnChild("child");
    expect(capabilitiesOf(options).extensions).toEqual(["web"]);
  });

  it("intersects a child's extension list with the parent's", async () => {
    writeAgent("child", "tools: read\nextensions: web, db\n");
    load();
    parentOf({ extensions: ["web"] });
    const { options } = await spawnChild("child");
    expect(capabilitiesOf(options).extensions).toEqual(["web"]);
    expect(options.capability.filtered).toEqual(["extension db"]);
  });

  it("applies the parent's exclude_extensions to the child", async () => {
    writeAgent("child", "tools: read\nextensions: true\n");
    load();
    parentOf({ excludeExtensions: ["Risky"] });
    const { options } = await spawnChild("child");
    expect(capabilitiesOf(options).extensions).toBe(true);
    expect(capabilitiesOf(options).excludeExtensions).toEqual(["risky"]);
  });

  it("narrows skills: true under a parent list to that list", async () => {
    writeAgent("child", "tools: read\nskills: true\n");
    load();
    parentOf({ skills: ["review", "lint"] });
    const { options } = await spawnChild("child");
    expect(capabilitiesOf(options).skills).toBe(true);
    expect(capabilitiesOf(options).skillScope.allow).toEqual(["review", "lint"]);
  });

  it("filters named skills to the parent's", async () => {
    writeAgent("child", "tools: read\nskills: review, secret\n");
    load();
    parentOf({ skills: ["review"] });
    const { options } = await spawnChild("child");
    expect(capabilitiesOf(options).skills).toEqual(["review"]);
  });

  it("gives a child no skills when the parent has none", async () => {
    writeAgent("child", "tools: read\nskills: review\n");
    load();
    parentOf({ skills: false });
    const { options } = await spawnChild("child");
    expect(capabilitiesOf(options).skills).toBe(false);
  });
});

describe("the bound is transitive and needs a recorded set", () => {
  it("bounds a grandchild by the child's recorded set", async () => {
    writeAgent("child", "tools: read, bash\n");
    writeAgent("grandchild", "tools: read, bash, grep\n");
    load();
    parentOf({ builtinToolNames: ["read", "bash", "grep"] });
    parent!.capabilities = { ...parent!.capabilities!, disallowedTools: ["bash"] };
    const first = await spawnChild("child");
    const childCapabilities = capabilitiesOf(first.options);
    expect(childCapabilities.builtinToolNames).toEqual(["read"]);

    spawnAndWait.mockClear();
    parent = { id: "parent-1", capabilities: childCapabilities };
    const second = await spawnChild("grandchild");
    expect(capabilitiesOf(second.options).builtinToolNames).toEqual(["read"]);
  });

  it("refuses a nested spawn when the parent record has no recorded set", async () => {
    writeAgent("child", "tools: read\n");
    load();
    parent = { id: "parent-1" };
    const { result } = await spawnChild("child");
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("no recorded capability set");
    expect(spawnAndWait).not.toHaveBeenCalled();

    parent = undefined;
    const missing = await spawnChild("child");
    expect(missing.result.isError).toBe(true);
    expect(spawnAndWait).not.toHaveBeenCalled();
  });

  it("leaves a child unchanged when the parent holds everything", async () => {
    writeAgent("child", "tools: read, bash\nextensions: web\nskills: review\n");
    load();
    parentOf({});
    const { options } = await spawnChild("child");
    expect(options.capability.filtered).toEqual([]);
    expect(capabilitiesOf(options)).toMatchObject({ builtinToolNames: ["read", "bash"], extensions: ["web"], skills: ["review"] });
  });
});
