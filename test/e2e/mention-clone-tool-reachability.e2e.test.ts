import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.setConfig({ testTimeout: 30_000 });

const { sessions } = vi.hoisted(() => ({ sessions: [] as any[] }));

vi.mock("@earendil-works/pi-coding-agent", async () => {
  const actual = await vi.importActual<any>("@earendil-works/pi-coding-agent");
  return {
    ...actual,
    createAgentSession: async (opts: any) => {
      const created = await actual.createAgentSession(opts);
      sessions.push(created.session);
      return created;
    },
  };
});

import { runMentionClone } from "../../src/triggers/mention-clone.js";
import { fauxModelBackend } from "../helpers/faux-model-backend.js";
import { registerFauxProvider } from "../helpers/pi-ai.js";

describe("mention clone tool reachability against real pi-mono", () => {
  let cwd: string;
  let faux: ReturnType<typeof registerFauxProvider>;

  beforeEach(() => {
    sessions.length = 0;
    cwd = mkdtempSync(join(tmpdir(), "subagents-mention-clone-"));
    faux = registerFauxProvider({ provider: "faux", models: [{ id: "faux-1", contextWindow: 200_000 }] });
  });
  afterEach(() => {
    faux.unregister();
    rmSync(cwd, { recursive: true, force: true });
  });

  it("the clone's agent tool is live on the real session, and it is the only one", async () => {
    const model = faux.getModel();
    const backend = fauxModelBackend(model);
    const ctx: any = {
      cwd,
      model,
      getSystemPrompt: () => "PARENT",
      modelRegistry: { ...backend.modelRegistry, runtime: backend.modelRuntime },
      sessionManager: { getEntries: () => [], getLeafId: () => undefined },
    };

    const agentTool = { name: "agent", execute: vi.fn() } as any;

    await runMentionClone({ ctx, type: "Explore", message: "go", agentTool });

    expect(sessions).toHaveLength(1);
    expect(sessions[0].getActiveToolNames()).toEqual(["agent"]);
  });
});
