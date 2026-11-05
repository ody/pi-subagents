import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  agentCall,
  type PrintModeRun,
  routeBySession,
  runPrintMode,
} from "./helpers/print-mode-runner.js";

function agentToolResult(session: AgentSession): string {
  const msg = [...session.messages].reverse().find(
    (m) => m.role === "toolResult" && (m as { toolName?: string }).toolName === "Agent",
  );
  return ((msg?.content ?? []) as Array<{ text?: string }>).map((b) => b.text ?? "").join("");
}

vi.setConfig({ testTimeout: 30_000 });

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
