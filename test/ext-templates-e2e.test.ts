import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseFrontmatter } from "@earendil-works/pi-coding-agent";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { getAgentConfig, registerAgents } from "../src/agents/agent-types.js";
import { loadCustomAgents } from "../src/agents/custom-agents.js";
import { runAgent } from "../src/session/agent-runner.js";
import { resolveAgentInvocationConfig } from "../src/tool/invocation-config.js";
import { registeredCapability } from "./helpers/capability.js";
import { registerFauxProvider } from "./helpers/pi-ai.js";

vi.setConfig({ testTimeout: 30_000 });

const FIXTURES_DIR = resolve(fileURLToPath(new URL("./fixtures", import.meta.url)));
const TEMPLATES_DIR = join(FIXTURES_DIR, ".pi", "agents");

function csv(val: unknown): string[] {
  return typeof val === "string" ? val.split(",").map((s) => s.trim()).filter(Boolean) : [];
}

const SCENARIOS = readdirSync(TEMPLATES_DIR)
  .filter((f) => f.endsWith(".md"))
  .map((file) => {
    const fm = parseFrontmatter<Record<string, unknown>>(
      readFileSync(join(TEMPLATES_DIR, file), "utf8"),
    ).frontmatter;
    return {
      name: file.replace(/\.md$/, ""),
      present: csv(fm.expect_tools_present),
      absent: csv(fm.expect_tools_absent),
      promptContains: csv(fm.expect_prompt_contains),
      promptAbsent: csv(fm.expect_prompt_absent),
    };
  });

const PARENT_PROMPT = "PARENT_PROMPT_MARKER";

describe("ext: / tools: scoping — template-driven e2e (real pi-mono, headless)", () => {
  let prevAgentDir: string | undefined;
  let prevHome: string | undefined;
  let hermeticDir: string;
  let faux: ReturnType<typeof registerFauxProvider>;

  beforeAll(() => {
    hermeticDir = mkdtempSync(join(tmpdir(), "subagents-tmpl-"));
    prevAgentDir = process.env.PI_CODING_AGENT_DIR;
    prevHome = process.env.HOME;
    process.env.PI_CODING_AGENT_DIR = hermeticDir;
    process.env.HOME = hermeticDir;

    faux = registerFauxProvider({ provider: "faux", models: [{ id: "faux-1", contextWindow: 200_000 }] });

    registerAgents(loadCustomAgents(FIXTURES_DIR));
  });

  afterAll(() => {
    faux.unregister();
    if (prevAgentDir == null) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = prevAgentDir;
    if (prevHome == null) delete process.env.HOME;
    else process.env.HOME = prevHome;
    rmSync(hermeticDir, { recursive: true, force: true });
  });

  async function runScenario(agentName: string): Promise<{ active: string[]; prompt: string }> {
    const model = faux.getModel();
    const modelRegistry: any = {
      find: () => model,
      getAll: () => [model],
      getAvailable: () => [model],
      hasConfiguredAuth: () => true,
      isUsingOAuth: () => false,
      getApiKeyAndHeaders: async () => ({ apiKey: "faux", headers: {} }),
      registerProvider: () => {},
      unregisterProvider: () => {},
    };
    const ctx: any = { cwd: FIXTURES_DIR, getSystemPrompt: () => PARENT_PROMPT, model, modelRegistry };
    const pi: any = { exec: async () => ({ code: 1, stdout: "", stderr: "" }) };

    const resolved = resolveAgentInvocationConfig(getAgentConfig(agentName), { modelFromParams: false } as any);

    let active: string[] = [];
    let prompt = "";
    try {
      await runAgent(ctx, agentName, "go", {
        pi,
        capability: registeredCapability(agentName, resolved.isolated),
        model,
        cwd: FIXTURES_DIR,
        isolated: resolved.isolated,
        inheritContext: resolved.inheritContext,
        onSessionCreated: (s) => {
          active = s.getActiveToolNames();
          prompt = s.systemPrompt;
        },
      });
    } catch {
    }
    return { active, prompt };
  }

  it("every template on disk is discovered, registered, and self-describing", () => {
    const onDisk = readdirSync(TEMPLATES_DIR).filter((f) => f.endsWith(".md")).length;
    expect(SCENARIOS.length).toBe(onDisk);
    expect(SCENARIOS.length).toBeGreaterThanOrEqual(6);

    for (const s of SCENARIOS) {
      expect(s.present.length + s.promptContains.length + s.promptAbsent.length).toBeGreaterThan(0);
      const cfg = getAgentConfig(s.name);
      expect(cfg, `template "${s.name}" did not register (parse error or name mismatch?)`).toBeDefined();
      expect(cfg?.name).toBe(s.name);
    }
  });

  it.each(SCENARIOS)(
    "$name → active tools and system prompt match the template",
    async ({ name, present, absent, promptContains, promptAbsent }) => {
      const { active, prompt } = await runScenario(name);
      for (const tool of present) expect(active, `${name}: expected "${tool}" active`).toContain(tool);
      for (const tool of absent) expect(active, `${name}: expected "${tool}" NOT active`).not.toContain(tool);
      for (const s of promptContains) expect(prompt, `${name}: prompt should contain "${s}"`).toContain(s);
      for (const s of promptAbsent) expect(prompt, `${name}: prompt should NOT contain "${s}"`).not.toContain(s);
    },
  );
});
