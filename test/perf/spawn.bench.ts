import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, bench, describe, vi } from "vitest";

vi.mock("../../src/session/agent-runner.js", async () => {
  const actual = await vi.importActual<typeof import("../../src/session/agent-runner.js")>("../../src/session/agent-runner.js");
  return { ...actual, runAgent: vi.fn(), resumeAgent: vi.fn() };
});

import { registerAgents } from "../../src/agents/agent-types.js";
import { loadCustomAgents } from "../../src/agents/custom-agents.js";
import subagentsExtension from "../../src/index.js";
import { runAgent } from "../../src/session/agent-runner.js";
import { ctx, type Hermetic, hermeticDir, makePi } from "../helpers/boot-extension.js";

function agentFile(i: number): string {
  return [
    "---",
    `description: "Perf fixture agent ${i}, one of many in this directory."`,
    "tools: read, grep, bash",
    "---",
    "",
    `You are perf fixture agent ${i}. Do the thing the parent asked, then stop.`,
    "",
  ].join("\n");
}

function projectDirWith(n: number): string {
  const dir = mkdtempSync(join(tmpdir(), "perf-agents-"));
  const agentsDir = join(dir, ".pi", "agents");
  mkdirSync(agentsDir, { recursive: true });
  for (let i = 0; i < n; i++) writeFileSync(join(agentsDir, `perf-agent-${i}.md`), agentFile(i));
  tempDirs.push(dir);
  return dir;
}

const tempDirs: string[] = [];
const hermetics: Hermetic[] = [];
afterAll(() => {
  for (const h of hermetics.reverse()) h.restore();
  for (const d of tempDirs) rmSync(d, { recursive: true, force: true });
  registerAgents(new Map());
  delete (globalThis as any)[Symbol.for("pi-subagents:manager")];
});

const globalRedirect = hermeticDir();
hermetics.push(globalRedirect);

describe("loadCustomAgents (runs on every Agent call)", () => {
  for (const n of [5, 50, 200]) {
    const cwd = projectDirWith(n);
    bench(`${n} agent files`, () => {
      loadCustomAgents(cwd);
    });
  }
});

describe("agent tool — background spawn", () => {
  vi.mocked(runAgent).mockImplementation(async () => ({
    responseText: "done",
    session: { dispose: vi.fn() } as any,
    aborted: false,
    steered: false,
  }));

  function bootAgentTool() {
    const { pi, tools } = makePi();
    subagentsExtension(pi);
    return tools.get("agent");
  }

  const c = ctx();
  let i = 0;

  const agent = bootAgentTool();

  bench(
    "general-purpose, run_in_background",
    async () => {
      await agent.execute(
        `bench-${i++}`,
        { subagent_type: "general-purpose", description: "bench spawn", prompt: "go", run_in_background: true },
        undefined,
        undefined,
        c,
      );
    },
    { time: 0, iterations: 100, warmupTime: 0, warmupIterations: 10 },
  );
});
