import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Context } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  agentCall,
  agentToolResults,
  type PrintModeRun,
  runPrintMode,
} from "./helpers/print-mode-runner.js";

vi.setConfig({ testTimeout: 60_000 });

const LIVE = /^(1|true|yes)$/i.test(process.env.PI_E2E_LIVE ?? "");

const CHILD_HOLD_MS = 120;

describe.skipIf(LIVE)("maxConcurrentForeground e2e (real pi agent loop)", () => {
  let run: PrintModeRun | undefined;
  const tmpDirs: string[] = [];

  afterEach(async () => {
    await run?.dispose();
    run = undefined;
    for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  function projectDir(settings: Record<string, unknown>): string {
    const dir = mkdtempSync(join(tmpdir(), "pi-fgconc-e2e-"));
    tmpDirs.push(dir);
    mkdirSync(join(dir, ".pi"), { recursive: true });
    writeFileSync(
      join(dir, ".pi", "subagents.json"),
      JSON.stringify({ outputTranscript: false, ...settings }),
    );
    return dir;
  }

  async function twoBlockingAgents(settings: Record<string, unknown>) {
    let inFlight = 0;
    let maxInFlight = 0;
    const order: string[] = [];

    run = await runPrintMode({
      prompt: "Delegate two independent jobs and report both.",
      cwd: projectDir(settings),
      live: false,
      respond: async (context: Context) => {
        const isParent = (context.tools ?? []).some(t => t.name === "agent");
        if (isParent) {
          const alreadySpawned = context.messages.some(
            m => m.role === "toolResult" && (m as { toolName?: string }).toolName === "agent",
          );
          if (alreadySpawned) return "Both jobs are done.";
          return [
            agentCall({ prompt: "JOB-ALPHA", description: "alpha", run_in_background: false }),
            agentCall({ prompt: "JOB-BETA", description: "beta", run_in_background: false }),
          ];
        }

        const label = JSON.stringify(context.messages).includes("JOB-ALPHA") ? "alpha" : "beta";
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        order.push(`start:${label}`);
        await new Promise(r => setTimeout(r, CHILD_HOLD_MS));
        order.push(`end:${label}`);
        inFlight--;
        return `${label.toUpperCase()}-RESULT`;
      },
    });

    return { maxInFlight, order };
  }

  it("runs a turn's two blocking Agent calls one at a time when the limit is 1", async () => {
    const { maxInFlight, order } = await twoBlockingAgents({ maxConcurrentForeground: 1 });

    expect(maxInFlight).toBe(1);
    expect(order).toHaveLength(4);
    expect(order[1]).toBe(order[0].replace("start:", "end:"));

    const results = agentToolResults(run!.parentSession).join("\n");
    expect(results).toContain("ALPHA-RESULT");
    expect(results).toContain("BETA-RESULT");

    expect(run!.responseText).toContain("Both jobs are done.");
  });

  it("runs them concurrently when the limit is unset — the detector works", async () => {
    const { maxInFlight, order } = await twoBlockingAgents({ maxConcurrentForeground: 0 });

    expect(maxInFlight).toBe(2);
    expect(order.slice(0, 2).every(e => e.startsWith("start:"))).toBe(true);

    const results = agentToolResults(run!.parentSession).join("\n");
    expect(results).toContain("ALPHA-RESULT");
    expect(results).toContain("BETA-RESULT");
  });
});
