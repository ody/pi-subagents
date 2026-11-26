import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Context, ToolCall } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerAgents } from "../../src/agents/agent-types.js";
import { loadCustomAgents } from "../../src/agents/custom-agents.js";
import {
  agentCall,
  contextToolNames,
  type FauxReply,
  type FauxResponder,
  invokedToolNames,
  type PrintModeRun,
  runPrintMode,
} from "../harness/print-mode-runner.js";

vi.setConfig({ testTimeout: 30_000 });

const NESTED_TOOLS = ["agent", "agent_models", "agent_get_result", "agent_steer", "agent_stop"];

function userPrompt(ctx: Context): string {
  for (const message of ctx.messages) {
    if (message.role !== "user") continue;
    const content = (message as { content?: unknown }).content;
    if (typeof content === "string") return content;
    if (Array.isArray(content)) {
      const text = content.find(
        (block: { type?: string; text?: string }) => block.type === "text",
      ) as { text?: string } | undefined;
      if (text?.text) return text.text;
    }
  }
  return "";
}

function tools(ctx: Context): string[] {
  return contextToolNames(ctx);
}

function toolResults(ctx: Context, name: string): string[] {
  return ctx.messages.flatMap((message) => {
    if (
      message.role !== "toolResult" ||
      (message as { toolName?: string }).toolName !== name
    ) {
      return [];
    }
    const content = (message as { content?: unknown }).content;
    if (!Array.isArray(content)) return [];
    return [
      content
        .map((block: { type?: string; text?: string }) =>
          block.type === "text" ? (block.text ?? "") : "",
        )
        .join(""),
    ];
  });
}

function nestedToolsIn(toolNames: string[] | undefined): string[] {
  return (toolNames ?? []).filter((name) => NESTED_TOOLS.includes(name));
}

async function waitForChildReady(
  ready: Promise<void>,
  timeoutMs: number,
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      ready,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new Error(
                `Nested child did not enter its deferred response within ${timeoutMs}ms`,
              ),
            ),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function lastToolResult(ctx: Context, name: string): string {
  const results = toolResults(ctx, name);
  return results[results.length - 1] ?? "";
}

function toolCall(
  name: string,
  args: Record<string, unknown>,
  id: string,
): ToolCall {
  return { type: "toolCall", id, name, arguments: args } as ToolCall;
}

function writeAgents(cwd: string, agents: Record<string, string>): void {
  const dir = join(cwd, ".pi", "agents");
  mkdirSync(dir, { recursive: true });
  for (const [name, frontmatter] of Object.entries(agents)) {
    writeFileSync(
      join(dir, `${name}.md`),
      `---\ndescription: ${name}\n${frontmatter}---\n${name} agent\n`,
    );
  }
}

async function runWithAgents(
  agents: Record<string, string>,
  respond: FauxResponder,
  options: { prompt: string; maxModelCalls?: number; hold?: boolean } = {
    prompt: "root",
  },
): Promise<{ run: PrintModeRun; cwd: string }> {
  const cwd = mkdtempSync(join(tmpdir(), "subagents-nested-e2e-"));
  writeAgents(cwd, agents);
  const run = await runPrintMode({
    ...options,
    cwd,
    respond,
    live: false,
    beforeRun: () => registerAgents(loadCustomAgents(cwd)),
  });
  return { run, cwd };
}

type AgentCallArgs = Parameters<typeof agentCall>[0];

function delegateOnce(ctx: Context, args: AgentCallArgs): FauxReply {
  return toolResults(ctx, "agent").length === 0 ? agentCall(args) : lastToolResult(ctx, "agent");
}

function agentIdFrom(spawnResult: string, label: string): string {
  const id = spawnResult.match(/Agent ID: ([^\s]+)/)?.[1];
  if (!id) throw new Error(`No ${label} in: ${spawnResult}`);
  return id;
}

interface Deferred {
  promise: Promise<void>;
  resolve: () => void;
}

function deferred(): Deferred {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function settleState(pending: Promise<void>, windowMs: number): Promise<"settled" | "pending"> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      pending.then(() => "settled" as const),
      new Promise<"pending">((resolve) => {
        timer = setTimeout(() => resolve("pending"), windowMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function depthCapResponder(observed: Map<string, string[]>): FauxResponder {
  const routes: Record<string, (ctx: Context) => FauxReply> = {
    "level_three-child": () => "UNEXPECTED_LEVEL_THREE",
    "level_two-child": (ctx) => {
      const nested = nestedToolsIn(tools(ctx));
      return `AT_CAP tools=${nested.length === 0 ? "none" : nested.join(",")}`;
    },
    "level_one-child": (ctx) =>
      delegateOnce(ctx, {
        subagent_type: "level_two",
        description: "allowed level",
        prompt: "level_two-child",
        run_in_background: false,
      }),
  };
  const root = (ctx: Context) =>
    delegateOnce(ctx, {
      subagent_type: "level_one",
      description: "recursive chain",
      prompt: "level_one-child",
      run_in_background: false,
    });
  return (ctx) => {
    const route = userPrompt(ctx);
    observed.set(route, tools(ctx));
    return (routes[route] ?? root)(ctx);
  };
}

function backgroundRootReply(ctx: Context): FauxReply {
  const agents = toolResults(ctx, "agent");
  if (agents.length === 0) {
    return agentCall({
      subagent_type: "background_delegator",
      description: "background nested work",
      prompt: "background-delegator-child",
      run_in_background: true,
    });
  }
  if (toolResults(ctx, "agent_get_result").length > 0) return lastToolResult(ctx, "agent_get_result");
  return toolCall(
    "agent_get_result",
    { agent_id: agentIdFrom(agents[0], "background agent ID"), wait: true },
    "get-background-result",
  );
}

function backgroundNestedResponder(calls: Map<string, number>): FauxResponder {
  return async (ctx) => {
    const route = userPrompt(ctx);
    calls.set(route, (calls.get(route) ?? 0) + 1);
    if (route === "background-grandchild-child") {
      await new Promise((resolve) => setTimeout(resolve, 50));
      return "BACKGROUND_NESTED_RESULT";
    }
    if (route === "background-delegator-child") {
      return delegateOnce(ctx, {
        subagent_type: "background_grandchild",
        description: "nested foreground work",
        prompt: "background-grandchild-child",
        run_in_background: false,
      });
    }
    return backgroundRootReply(ctx);
  };
}

function createOwnershipScenario() {
  const probeResults: { get?: string; steer?: string } = {};
  const state = { ownedChildBlocked: false, nestedId: "" };
  const ownedChild = { entered: deferred(), release: deferred() };
  const owner = { holding: deferred(), release: deferred() };

  const ownedChildReply = async (): Promise<FauxReply> => {
    state.ownedChildBlocked = true;
    ownedChild.entered.resolve();
    await ownedChild.release.promise;
    return "OWNED_NESTED_RESULT";
  };

  const ownerChildReply = async (ctx: Context): Promise<FauxReply> => {
    const agents = toolResults(ctx, "agent");
    if (agents.length === 0) {
      return agentCall({
        subagent_type: "owned_child",
        description: "owned nested child",
        prompt: "owned-child",
        run_in_background: true,
      });
    }
    state.nestedId = agentIdFrom(agents[0], "nested ID");
    owner.holding.resolve();
    await owner.release.promise;
    return `OWNER_NESTED_ID:${state.nestedId}`;
  };

  const probeChildReply = async (ctx: Context): Promise<FauxReply> => {
    await ownedChild.entered.promise;
    await waitForChildReady(owner.holding.promise, 5_000);
    if (!state.nestedId) throw new Error("Owner never published a nested agent id");
    const gets = toolResults(ctx, "agent_get_result");
    const steers = toolResults(ctx, "agent_steer");
    if (gets.length === 0) {
      return toolCall("agent_get_result", { agent_id: state.nestedId }, "foreign-get");
    }
    if (steers.length === 0) {
      return toolCall(
        "agent_steer",
        { agent_id: state.nestedId, message: "foreign guidance" },
        "foreign-steer",
      );
    }
    probeResults.get = gets.at(-1);
    probeResults.steer = steers.at(-1);
    return "OWNERSHIP_PROBE_DONE";
  };

  const rootReply = (ctx: Context): FauxReply => {
    const agents = toolResults(ctx, "agent");
    if (agents.length === 0) {
      return agentCall({
        subagent_type: "owner",
        description: "nested record owner",
        prompt: "owner-child",
        run_in_background: true,
      });
    }
    if (agents.length === 1) {
      return agentCall({
        subagent_type: "probe",
        description: "foreign ownership probe",
        prompt: "probe-child",
        run_in_background: true,
      });
    }
    if (toolResults(ctx, "agent_get_result").length > 0) return lastToolResult(ctx, "agent_get_result");
    return toolCall(
      "agent_get_result",
      { agent_id: agentIdFrom(agents[1], "probe ID"), wait: true },
      "await-probe",
    );
  };

  const respond: FauxResponder = (ctx) => {
    const route = userPrompt(ctx);
    if (route === "owned-child") return ownedChildReply();
    if (route === "owner-child") return ownerChildReply(ctx);
    if (route === "probe-child") return probeChildReply(ctx);
    return rootReply(ctx);
  };

  const releaseAll = () => {
    ownedChild.release.resolve();
    owner.release.resolve();
  };

  return { respond, probeResults, state, ownedChildEntered: ownedChild.entered.promise, releaseAll };
}

describe("PR #164 nested agents through the real print-mode boundary", () => {
  let run: PrintModeRun | undefined;
  let cwd: string | undefined;

  afterEach(async () => {
    await run?.dispose();
    run = undefined;
    if (cwd) rmSync(cwd, { recursive: true, force: true });
    cwd = undefined;
  });

  it("does not inject nested orchestration tools into a custom agent by default", async () => {
    const observed = new Map<string, string[]>();
    ({ run, cwd } = await runWithAgents(
      { plain: "" },
      (ctx) => {
        const route = userPrompt(ctx);
        if (route === "plain-child") {
          observed.set(route, tools(ctx));
          return "PLAIN_CHILD_RESULT";
        }
        if (toolResults(ctx, "agent").length === 0) {
          return agentCall({
            subagent_type: "plain",
            description: "plain child",
            prompt: "plain-child",
            run_in_background: false,
          });
        }
        return lastToolResult(ctx, "agent");
      },
      { prompt: "root-default" },
    ));

    expect(run.responseText).toContain("PLAIN_CHILD_RESULT");
    expect(observed.get("plain-child")).toBeDefined();
    expect(nestedToolsIn(observed.get("plain-child"))).toEqual([]);
  });

  it("strips nested tools at the depth cap instead of injecting always-failing ones", async () => {
    const observed = new Map<string, string[]>();
    ({ run, cwd } = await runWithAgents(
      {
        level_one: "allowed_subagents: level_two\n",
        level_two: "allowed_subagents: level_three\n",
        level_three: "",
      },
      depthCapResponder(observed),
      { prompt: "root-depth", maxModelCalls: 24 },
    ));

    expect(run.responseText).toContain("AT_CAP tools=none");
    expect(observed.get("level_one-child")).toEqual(
      expect.arrayContaining(NESTED_TOOLS),
    );
    expect(nestedToolsIn(observed.get("level_two-child"))).toEqual([]);
    expect(observed.has("level_three-child")).toBe(false);
  });

  it("holds a background child while it performs real nested delegation", async () => {
    const calls = new Map<string, number>();
    ({ run, cwd } = await runWithAgents(
      {
        background_delegator: "allowed_subagents: background_grandchild\n",
        background_grandchild: "",
      },
      backgroundNestedResponder(calls),
      { prompt: "root-background", maxModelCalls: 24 },
    ));

    expect(run.responseText).toContain("BACKGROUND_NESTED_RESULT");
    expect(calls.get("background-delegator-child")).toBe(2);
    expect(calls.get("background-grandchild-child")).toBe(1);
    expect(invokedToolNames(run.parentSession)).toContain("agent_get_result");
  });

  it("keeps nested get and steer ownership-scoped to the calling parent", async () => {
    const scenario = createOwnershipScenario();
    let waitForAll: Promise<void> | undefined;

    try {
      ({ run, cwd } = await runWithAgents(
        {
          owner: "allowed_subagents: owned_child\n",
          probe: "allowed_subagents: all\n",
          owned_child: "",
        },
        scenario.respond,
        { prompt: "root-ownership", maxModelCalls: 32, hold: false },
      ));

      await waitForChildReady(scenario.ownedChildEntered, 5_000);
      expect(scenario.state.ownedChildBlocked).toBe(true);
      waitForAll = run.waitIdle();
      expect(await settleState(waitForAll, 50)).toBe("pending");

      const { get, steer } = scenario.probeResults;
      expect(run.responseText).toContain("OWNERSHIP_PROBE_DONE");
      expect(get).toBeDefined();
      expect(steer).toBeDefined();
      expect(get).toMatch(/^Nested agent not found or not owned by this parent:/i);
      expect(steer).toMatch(/^Running nested agent not found or not owned by this parent:/i);
      expect(get).not.toContain("OWNED_NESTED_RESULT");
      expect(steer).not.toContain("Steering message sent");

      scenario.releaseAll();
      await expect(waitForAll).resolves.toBeUndefined();
    } finally {
      scenario.releaseAll();
      if (waitForAll) {
        await Promise.race([
          waitForAll,
          new Promise<void>((resolve) => setTimeout(resolve, 5_000)),
        ]);
      }
    }
  });
});
