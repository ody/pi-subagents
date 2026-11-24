import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import type { AgentSession, EventBus } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  agentCall,
  type FauxResponder,
  type PrintModeRun,
  routeBySession,
  runPrintMode,
} from "../harness/print-mode-runner.js";

function agentToolResult(session: AgentSession): string {
  const msg = [...session.messages].reverse().find(
    (m) => m.role === "toolResult" && (m as { toolName?: string }).toolName === "agent",
  );
  return ((msg?.content ?? []) as Array<{ text?: string }>).map((b) => b.text ?? "").join("");
}

vi.setConfig({ testTimeout: 30_000 });

function installGeneralPurpose(): void {
  const dir = join(getAgentDir(), "agents");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "general-purpose.md"), "---\ndescription: general-purpose\n---\n\nYou are general-purpose.\n");
}

const FATAL = "invalid request: provider rejected the prompt";

describe("issue #144 — empty-error final turns must not be 'completed'", () => {
  let run: PrintModeRun | undefined;
  afterEach(async () => {
    await run?.dispose();
    run = undefined;
  });

  it("a run whose ONLY turn errors with no output is a failure, not an empty success", async () => {
    run = await runPrintMode({
      prompt: "Delegate.",
      beforeRun: installGeneralPurpose,
      respond: routeBySession({
        parentInitial: agentCall({ run_in_background: false, description: "doomed", prompt: "Do work." }),
        parentFinal: "parent done",
        subagent: () => fauxAssistantMessage([], { stopReason: "error", errorMessage: FATAL }),
      }),
      live: false,
    });

    const toolResult = agentToolResult(run.parentSession);
    expect(toolResult).toContain(FATAL);
    expect(toolResult).not.toContain("No output.");
  });

  it("an earlier turn's text must not mask a failed final turn as a fresh success", async () => {
    run = await runPrintMode({
      prompt: "Delegate.",
      beforeRun: installGeneralPurpose,
      respond: routeBySession({
        parentInitial: agentCall({ run_in_background: false, description: "masked", prompt: "Do work." }),
        parentFinal: "parent done",
        subagent: (ctx) => {
          const hasToolResult = ctx.messages.some((m) => m.role === "toolResult");
          return hasToolResult
            ? fauxAssistantMessage([], { stopReason: "error", errorMessage: FATAL })
            : fauxAssistantMessage([
                fauxText("EARLIER-PARTIAL-TEXT"),
                fauxToolCall("bash", { command: "echo hi" }),
              ]);
        },
      }),
      live: false,
    });

    const toolResult = agentToolResult(run.parentSession);
    expect(toolResult).toContain(FATAL);
    expect(toolResult).toContain("Partial output before the failure:");
    expect(toolResult).toContain("EARLIER-PARTIAL-TEXT");
    expect(toolResult.indexOf(FATAL)).toBeLessThan(toolResult.indexOf("EARLIER-PARTIAL-TEXT"));
  });

  it("a pure empty-error run shows no 'partial output' section", async () => {
    run = await runPrintMode({
      prompt: "Delegate.",
      beforeRun: installGeneralPurpose,
      respond: routeBySession({
        parentInitial: agentCall({ run_in_background: false, description: "empty", prompt: "Do work." }),
        parentFinal: "parent done",
        subagent: () => fauxAssistantMessage([], { stopReason: "error", errorMessage: FATAL }),
      }),
      live: false,
    });

    const toolResult = agentToolResult(run.parentSession);
    expect(toolResult).toContain(FATAL);
    expect(toolResult).not.toContain("Partial output before the failure:");
  });
});

type BusEvent = { name: string; data: Record<string, unknown> };

function captureSettles(events: BusEvent[]) {
  return (bus: EventBus) => {
    for (const name of ["agent:failed", "agent:completed"]) {
      bus.on(name, (data) => { events.push({ name, data: data as Record<string, unknown> }); });
    }
  };
}

async function settleOf(subagent: FauxResponder): Promise<{ events: BusEvent[]; run: PrintModeRun }> {
  const events: BusEvent[] = [];
  const run = await runPrintMode({
    prompt: "Delegate.",
    beforeRun: installGeneralPurpose,
    onBus: captureSettles(events),
    respond: routeBySession({
      parentInitial: agentCall({ run_in_background: false, description: "stage", prompt: "Do work." }),
      parentFinal: "parent done",
      subagent,
    }),
    live: false,
  });
  return { events, run };
}

describe("ADR 0051 — provider-stage failure on agent:failed", () => {
  let run: PrintModeRun | undefined;
  afterEach(async () => {
    await run?.dispose();
    run = undefined;
  });

  it("marks a final stopReason error with no response text as a provider-stage failure", async () => {
    const settled = await settleOf(() => fauxAssistantMessage([], { stopReason: "error", errorMessage: FATAL }));
    run = settled.run;
    expect(settled.events).toHaveLength(1);
    expect(settled.events[0]).toMatchObject({ name: "agent:failed", data: { status: "error", failure: { stage: "provider" } } });
  });

  it("marks a provider error after earlier response text", async () => {
    const settled = await settleOf((ctx) => ctx.messages.some((m) => m.role === "toolResult")
      ? fauxAssistantMessage([], { stopReason: "error", errorMessage: FATAL })
      : fauxAssistantMessage([fauxText("EARLIER"), fauxToolCall("bash", { command: "echo hi" })]));
    run = settled.run;
    expect(settled.events[0]).toMatchObject({ name: "agent:failed", data: { failure: { stage: "provider" } } });
  });

  it("omits the stage when only the response text mentions a rate limit", async () => {
    const settled = await settleOf(() => fauxAssistantMessage([fauxText("429 rate limit exceeded; quota exhausted")]));
    run = settled.run;
    expect(settled.events[0]).toMatchObject({ name: "agent:completed", data: { status: "completed" } });
    expect(settled.events[0].data).not.toHaveProperty("failure");
  });
});
