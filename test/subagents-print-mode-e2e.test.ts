import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Context } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  agentCall,
  agentToolCalls,
  agentToolResults,
  contextSystemPrompt,
  contextToolNames,
  conversationText,
  invokedToolNames,
  type PrintModeRun,
  routeBySession,
  runPrintMode,
} from "./helpers/print-mode-runner.js";

vi.setConfig({ testTimeout: 30_000 });

const LIVE = /^(1|true|yes)$/i.test(process.env.PI_E2E_LIVE ?? "");

function installGeneralPurpose(): void {
  mkdirSync(join(process.cwd(), ".pi", "agents"), { recursive: true });
  writeFileSync(
    join(process.cwd(), ".pi", "agents", "general-purpose.md"),
    "---\ndescription: general-purpose\n---\n\nYou are general-purpose.\n",
  );
}

describe.skipIf(LIVE)("subagents print-mode e2e (scripted faux, real pi-mono)", () => {
  let run: PrintModeRun | undefined;
  const tmpDirs: string[] = [];

  afterEach(async () => {
    await run?.dispose();
    run = undefined;
    for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  it("records the model and thinking level the child session actually resolved", async () => {
    run = await runPrintMode({
      prompt: "Delegate the greeting to a subagent.",
      beforeRun: installGeneralPurpose,
      respond: routeBySession({
        parentInitial: agentCall({
          subagent_type: "general-purpose",
          description: "greet",
          prompt: "Say hello.",
          run_in_background: true,
        }),
        parentFinal: "done",
        subagent: "CHILD_GREETING_OK",
      }),
    });
    await run.manager?.waitForAll();

    const id = /Agent ID: (\S+)/.exec(agentToolResults(run.parentSession).join("\n"))?.[1];
    expect(id).toBeTruthy();
    const record = run.manager?.getRecord(id as string) as { invocation?: Record<string, unknown> };
    const invocation = record?.invocation;

    expect(invocation?.modelId).toBe("faux/faux-1");
    expect(invocation?.modelName).toBe("faux-1");
    expect(typeof invocation?.thinking).toBe("string");
    expect(invocation?.thinking).not.toBe("");
  });

  it("spawns a FOREGROUND subagent and routes its real output back to the parent", async () => {
    run = await runPrintMode({
      prompt: "Delegate the greeting to a subagent.",
      beforeRun: installGeneralPurpose,
      respond: routeBySession({
        parentInitial: agentCall({
          subagent_type: "general-purpose",
          description: "greet",
          prompt: "Say hello.",
          run_in_background: false,
        }),
        parentFinal: (ctx: Context) => {
          const childOut = [...ctx.messages]
            .reverse()
            .find((m) => m.role === "toolResult" && (m as { toolName?: string }).toolName === "agent");
          const text = ((childOut?.content ?? []) as Array<{ text?: string }>)
            .map((b) => b.text ?? "")
            .join("");
          return `Parent relays: ${text.includes("CHILD_GREETING_OK") ? "CHILD_GREETING_OK" : "CHILD_MISSING"}`;
        },
        subagent: "CHILD_GREETING_OK",
      }),
    });

    const toolResults = agentToolResults(run.parentSession);
    expect(toolResults.length).toBe(1);
    expect(toolResults[0]).toContain("CHILD_GREETING_OK");
    expect(run.responseText).toContain("CHILD_GREETING_OK");
    expect(run.responseText).not.toContain("CHILD_MISSING");
    expect(run.modelCalls).toBeGreaterThanOrEqual(3);
  });

  it("the hold condition is load-bearing: it keeps a BACKGROUND child alive (vs abandoned without it)", async () => {
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
    const respond = async (ctx: Context) => {
      const isParent = contextToolNames(ctx).includes("agent");
      if (!isParent) {
        await sleep(80);
        return "CHILD_BG_RAN";
      }
      const spawned = ctx.messages.some(
        (m) => m.role === "toolResult" && (m as { toolName?: string }).toolName === "agent",
      );
      return spawned
        ? "summarized"
        : agentCall({ description: "bg work", prompt: "Do background work.", run_in_background: true });
    };

    const noHold = await runPrintMode({ prompt: "go", hold: false, respond, beforeRun: installGeneralPurpose });
    const abandonedCalls = noHold.modelCalls;
    await noHold.manager?.waitForAll();
    await noHold.dispose();

    run = await runPrintMode({ prompt: "go", hold: true, respond, beforeRun: installGeneralPurpose });

    expect(agentToolResults(run.parentSession)[0]).toMatch(/background/i);
    expect(abandonedCalls).toBe(2);
    expect(run.modelCalls).toBeGreaterThan(abandonedCalls);
    expect(run.modelCalls).toBeGreaterThanOrEqual(3);
  });

  it("spawns a FRONTMATTER-defined (.pi/agents/*.md) agent and its prompt reaches the child", async () => {
    const MARKER = "SPYMARKER_FRONTMATTER_REACHED_CHILD";
    const cwd = mkdtempSync(join(tmpdir(), "subagents-fm-"));
    tmpDirs.push(cwd);
    mkdirSync(join(cwd, ".pi", "agents"), { recursive: true });
    writeFileSync(
      join(cwd, ".pi", "agents", "echo-spy.md"),
      `---\ndescription: "Echoes a marker proving its frontmatter prompt reached the child."\n---\n${MARKER}\n`,
    );

    run = await runPrintMode({
      prompt: "Delegate to the echo-spy agent.",
      cwd,
      respond: routeBySession({
        parentInitial: agentCall({
          subagent_type: "echo-spy",
          description: "echo",
          prompt: "Report what you were told.",
          run_in_background: false,
        }),
        parentFinal: "Reported.",
        subagent: (ctx: Context) =>
          `child saw: ${contextSystemPrompt(ctx).includes(MARKER) ? MARKER : "MISSING"}`,
      }),
    });

    const toolResults = agentToolResults(run.parentSession);
    expect(toolResults.length).toBe(1);
    expect(toolResults[0]).toContain(MARKER);
    expect(toolResults[0]).not.toContain("MISSING");
    expect(toolResults[0]).not.toMatch(/Unknown agent type/i);
  });

  it("spawns a FRONTMATTER-defined (.agents/agents/*.md) agent and its prompt reaches the child", async () => {
    const MARKER = "SPYMARKER_AGENTS_FRONTMATTER_REACHED_CHILD";
    const cwd = mkdtempSync(join(tmpdir(), "subagents-agents-fm-"));
    tmpDirs.push(cwd);
    mkdirSync(join(cwd, ".agents", "agents"), { recursive: true });
    writeFileSync(
      join(cwd, ".agents", "agents", "agents-spy.md"),
      `---\ndescription: "Echoes a marker from the .agents/agents workspace dir."\n---\n${MARKER}\n`,
    );

    run = await runPrintMode({
      prompt: "Delegate to the agents-spy agent.",
      cwd,
      respond: routeBySession({
        parentInitial: agentCall({
          subagent_type: "agents-spy",
          description: "echo workspace",
          prompt: "Report what you were told.",
          run_in_background: false,
        }),
        parentFinal: "Reported.",
        subagent: (ctx: Context) =>
          `child saw: ${contextSystemPrompt(ctx).includes(MARKER) ? MARKER : "MISSING"}`,
      }),
    });

    const toolResults = agentToolResults(run.parentSession);
    expect(toolResults.length).toBe(1);
    expect(toolResults[0]).toContain(MARKER);
    expect(toolResults[0]).not.toContain("MISSING");
    expect(toolResults[0]).not.toMatch(/Unknown agent type/i);
  });

  it("a colored agent's name badge never reaches print-mode text", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "subagents-color-"));
    tmpDirs.push(cwd);
    mkdirSync(join(cwd, ".pi", "agents"), { recursive: true });
    writeFileSync(
      join(cwd, ".pi", "agents", "painted.md"),
      '---\nname: Painted Agent\ncolor: "#827DBD"\ndescription: "A colored agent."\n---\nBe brief.\n',
    );

    run = await runPrintMode({
      prompt: "Delegate to the painted agent.",
      cwd,
      respond: routeBySession({
        parentInitial: agentCall({
          subagent_type: "Painted Agent",
          description: "paint",
          prompt: "Report in.",
          run_in_background: false,
        }),
        parentFinal: "Done.",
        subagent: "Painted Agent reporting in.",
      }),
    });

    const result = agentToolResults(run.parentSession)[0];
    expect(result).toContain("Painted Agent reporting in.");
    expect(result).not.toContain("\u001b");
    expect(conversationText(run.parentSession)).not.toContain("\u001b");
  });

  it("errors clearly when faux mode is given no script", async () => {
    await expect(runPrintMode({ prompt: "x" })).rejects.toThrow(/provide `respond` or `steps`/);
  });

  it("times out with the runner's own descriptive error and restores the environment", async () => {
    const prevCwd = process.cwd();
    await expect(
      runPrintMode({ prompt: "stall", respond: () => new Promise(() => {}), timeoutMs: 300 }),
    ).rejects.toThrow(/print-mode runner timed out after 300ms/);
    expect(process.cwd()).toBe(prevCwd);
    expect((globalThis as Record<symbol, unknown>)[Symbol.for("pi-subagents:manager")]).toBeUndefined();
  });
});

const LIVE_TIMEOUT = 150_000;
const SELF_SMOKE_TIMEOUT = 600_000;
const VITEST_SLACK = 30_000;
const LIVE_VITEST_TIMEOUT = LIVE_TIMEOUT + VITEST_SLACK;
const SELF_SMOKE_VITEST_TIMEOUT = SELF_SMOKE_TIMEOUT + VITEST_SLACK;

describe.runIf(LIVE)("subagents print-mode e2e (live LLM, opt-in)", () => {
  let run: PrintModeRun | undefined;
  afterEach(async () => {
    await run?.dispose();
    run = undefined;
  });

  it(
    "FOREGROUND spawn — real model spawns a subagent and reports its output",
    async () => {
      run = await runPrintMode({
        prompt:
          "Use the agent tool to spawn a general-purpose subagent (run_in_background: false) " +
          "whose only task is to reply with the exact word PONG, then tell me what it replied.",
        timeoutMs: LIVE_TIMEOUT,
      });
      expect(run.modelCalls).toBe(0);
      expect(invokedToolNames(run.parentSession)).toContain("agent");
      expect(agentToolResults(run.parentSession).join("\n")).toMatch(/PONG/i);
      expect(run.responseText).toMatch(/PONG/i);
    },
    LIVE_VITEST_TIMEOUT,
  );

  it(
    "BACKGROUND spawn + get_subagent_result — model backgrounds work then retrieves it",
    async () => {
      run = await runPrintMode({
        prompt:
          "Spawn a general-purpose subagent IN THE BACKGROUND (run_in_background: true) whose " +
          "only task is to reply with the exact word BGPONG. After it finishes, use the " +
          "get_subagent_result tool to fetch its result, then tell me exactly what it said.",
        timeoutMs: LIVE_TIMEOUT,
      });
      const calls = agentToolCalls(run.parentSession);
      expect(calls.some((c) => c.run_in_background === true)).toBe(true);
      expect(agentToolResults(run.parentSession).join("\n")).toMatch(/background/i);
      expect(run.responseText).toMatch(/BGPONG/i);
    },
    LIVE_VITEST_TIMEOUT,
  );

  it(
    "Explore subagent_type — model dispatches a non-default agent type",
    async () => {
      run = await runPrintMode({
        prompt:
          "Use the agent tool with subagent_type 'Explore' to look at the current working " +
          "directory and report a one-line summary of what's there.",
        timeoutMs: LIVE_TIMEOUT,
      });
      const calls = agentToolCalls(run.parentSession);
      expect(
        calls.some((c) => String(c.subagent_type ?? "").toLowerCase() === "explore"),
      ).toBe(true);
      expect(run.responseText.length).toBeGreaterThan(0);
    },
    LIVE_VITEST_TIMEOUT,
  );

  it(
    "SELF-SMOKE — the agent drives a multi-feature smoke of its own agent toolset",
    async () => {
      run = await runPrintMode({
        prompt: [
          "You are smoke-testing your own agent toolset. Do these steps IN ORDER, then print a",
          "final report with one PASS/FAIL line per step:",
          "1) FOREGROUND: spawn a general-purpose subagent (run_in_background: false) whose only",
          "   task is to reply with the exact token FG_OK. Confirm you got FG_OK back.",
          "2) BACKGROUND: spawn a general-purpose subagent with run_in_background: true whose only",
          "   task is to reply with the exact token BG_OK. After it finishes, call get_subagent_result",
          "   to retrieve its output. Confirm you got BG_OK.",
          "3) EXPLORE: spawn a subagent with subagent_type 'Explore' to summarize the current",
          "   working directory in one line.",
          "Finish with: 'SELF-SMOKE COMPLETE' followed by the PASS/FAIL lines.",
        ].join("\n"),
        timeoutMs: SELF_SMOKE_TIMEOUT,
      });

      const calls = agentToolCalls(run.parentSession);
      const tools = invokedToolNames(run.parentSession);

      expect(calls.some((c) => c.run_in_background !== true)).toBe(true);
      expect(calls.some((c) => c.run_in_background === true)).toBe(true);
      expect(tools).toContain("get_subagent_result");
      expect(calls.some((c) => String(c.subagent_type ?? "").toLowerCase() === "explore")).toBe(true);
      const transcript = conversationText(run.parentSession);
      expect(transcript).toMatch(/FG_OK/i);
      expect(transcript).toMatch(/BG_OK/i);
      expect(transcript).toMatch(/SELF-SMOKE COMPLETE/i);
      expect(run.responseText.length).toBeGreaterThan(0);
    },
    SELF_SMOKE_VITEST_TIMEOUT,
  );
});
