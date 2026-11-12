import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerAgents } from "../../src/agents/agent-types.js";
import { runAgent } from "../../src/session/agent-runner.js";
import type { AgentConfig } from "../../src/types.js";
import { registeredCapability } from "../helpers/capability.js";
import { registerFauxProvider } from "../helpers/pi-ai.js";

vi.setConfig({ testTimeout: 30_000 });

const ALPHA = resolve(fileURLToPath(new URL("../fixtures/ext-alpha.mjs", import.meta.url)));
const BETA = resolve(fileURLToPath(new URL("../fixtures/ext-beta.mjs", import.meta.url)));

function makePi() {
  return { exec: async () => ({ code: 1, stdout: "", stderr: "" }) } as any;
}

describe("tool veto reachability against real pi-mono", () => {
  let cwd: string;
  let faux: ReturnType<typeof registerFauxProvider>;

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), "subagents-veto-"));
    faux = registerFauxProvider({
      provider: "faux",
      models: [{ id: "faux-1", contextWindow: 200_000 }],
    });
  });
  afterEach(() => {
    faux.unregister();
    rmSync(cwd, { recursive: true, force: true });
  });

  it("pi installs a chainable beforeToolCall, and runAgent's veto blocks out-of-scope tools", async () => {
    registerAgents(
      new Map([
        [
          "veto",
          {
            name: "veto",
            description: "veto guard",
            builtinToolNames: ["read"],
            extensions: [ALPHA, BETA],
            extSelectors: ["ext:ext-alpha.mjs"],
            skills: false,
            systemPrompt: "You are veto.",
            promptMode: "replace",
            inheritContext: false,
            runInBackground: false,
            isolated: false,
          } as AgentConfig,
        ],
      ]),
    );

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
    const ctx: any = { cwd, getSystemPrompt: () => "PARENT", model, modelRegistry };

    let priorIsFunction: boolean | undefined;
    let session: any;
    try {
      await runAgent(ctx, "veto", "go", {
        pi: makePi(),
        capability: registeredCapability("veto"),
        model,
        onSessionCreated: (s: any) => {
          session = s;
          priorIsFunction = typeof s.agent?.beforeToolCall === "function";
        },
      });
    } catch {
    }

    expect(priorIsFunction).toBe(true);

    await expect(
      session.agent.beforeToolCall({ toolCall: { name: "beta_tool" }, args: {} }),
    ).resolves.toMatchObject({ block: true, reason: expect.any(String) });

    await expect(
      session.agent.beforeToolCall({ toolCall: { name: "alpha_read" }, args: {} }),
    ).resolves.toSatisfy((r: any) => !r?.block);
  });
});
