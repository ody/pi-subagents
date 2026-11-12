import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let loads = 0;

vi.mock("../../src/session/agent-runner.js", async () => {
  const actual = await vi.importActual<typeof import("../../src/session/agent-runner.js")>("../../src/session/agent-runner.js");
  return { ...actual, runAgent: vi.fn(), resumeAgent: vi.fn() };
});

vi.mock("../../src/agents/custom-agents.js", async () => {
  const actual = await vi.importActual<typeof import("../../src/agents/custom-agents.js")>("../../src/agents/custom-agents.js");
  return {
    ...actual,
    loadCustomAgents: (...args: Parameters<typeof actual.loadCustomAgents>) => {
      loads++;
      return actual.loadCustomAgents(...args);
    },
  };
});

import { registerAgents } from "../../src/agents/agent-types.js";
import subagentsExtension from "../../src/index.js";
import { runAgent } from "../../src/session/agent-runner.js";
import { ctx, flush, type Hermetic, hermeticDir, makePi } from "../helpers/boot-extension.js";

let hermetic: Hermetic;

beforeEach(() => {
  loads = 0;
  vi.mocked(runAgent).mockReset();
  vi.mocked(runAgent).mockImplementation(async () => ({
    responseText: "done",
    session: { dispose: vi.fn() } as any,
    aborted: false,
    steered: false,
  }));
});

afterEach(() => {
  delete (globalThis as any)[Symbol.for("pi-subagents:manager")];
  registerAgents(new Map());
  hermetic?.restore();
});

function bootAgentTool() {
  hermetic = hermeticDir({
    agentFiles: {
      alpha: '---\ndescription: "First fixture agent."\n---\n\nAlpha.\n',
      beta: '---\ndescription: "Second fixture agent."\n---\n\nBeta.\n',
    },
  });
  const { pi, tools } = makePi();
  subagentsExtension(pi);
  return tools.get("agent");
}

describe("one agent call, one sweep of the agent directories", () => {
  it("reloads agent files at most once per background spawn", async () => {
    const agent = bootAgentTool();
    loads = 0;

    await agent.execute(
      "tc-1",
      { subagent_type: "general-purpose", description: "d", prompt: "p", run_in_background: true },
      undefined,
      undefined,
      ctx(),
    );
    await flush();

    expect(loads).toBeLessThanOrEqual(1);
  });

  it("does not scale the sweep with the number of spawns in flight", async () => {
    const agent = bootAgentTool();
    loads = 0;

    for (let i = 0; i < 5; i++) {
      await agent.execute(
        `tc-${i}`,
        { subagent_type: "general-purpose", description: "d", prompt: "p", run_in_background: true },
        undefined,
        undefined,
        ctx(),
      );
    }
    await flush();

    expect(loads).toBeLessThanOrEqual(5);
  });
});
