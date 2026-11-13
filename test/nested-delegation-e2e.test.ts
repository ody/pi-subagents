import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Context, fauxToolCall } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerAgents } from "../src/agents/agent-types.js";
import { loadCustomAgents } from "../src/agents/custom-agents.js";
import { encodeCwd } from "../src/platform/output-file.js";
import {
  agentCall,
  contextToolNames,
  type FauxReply,
  type PrintModeRun,
  runPrintMode,
} from "./helpers/print-mode-runner.js";

vi.setConfig({ testTimeout: 30_000 });

const WORKER_MARKER = "WORKER-REACHED-THE-TOP";

function firstUserText(context: Context): string {
  const first = context.messages.find((m) => m.role === "user");
  const content = first?.content;
  if (typeof content === "string") return content;
  return ((content ?? []) as Array<{ text?: string }>).map((b) => b.text ?? "").join("");
}

function toolResultTexts(context: Context): Array<{ name: string; text: string }> {
  const out: Array<{ name: string; text: string }> = [];
  for (const m of context.messages) {
    if (m.role !== "toolResult") continue;
    const name = (m as { toolName?: string }).toolName ?? "";
    const text = ((m.content ?? []) as Array<{ text?: string }>).map((b) => b.text ?? "").join("");
    out.push({ name, text });
  }
  return out;
}

function findOutputFiles(root: string): string[] {
  let entries: string[];
  try { entries = readdirSync(root); } catch { return []; }
  return entries.flatMap((e) => {
    const full = join(root, e);
    if (statSync(full).isDirectory()) return findOutputFiles(full);
    return full.endsWith(".output") ? [full] : [];
  });
}

function writeAgents(cwd: string): void {
  const dir = join(cwd, ".pi", "agents");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "orchestrator.md"),
    "---\ndescription: Delegating orchestrator\ntools: read\nextensions: false\nallowed_subagents: worker\n---\nDelegate to worker.\n",
  );
  writeFileSync(
    join(dir, "worker.md"),
    "---\ndescription: Leaf worker\ntools: read\nextensions: false\n---\nDo the work.\n",
  );
}

describe("nested delegation e2e (real pi-mono, faux model)", () => {
  let run: PrintModeRun | undefined;
  const tmpDirs: string[] = [];

  afterEach(async () => {
    await run?.dispose();
    run = undefined;
    for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  it("a child with allowed_subagents spawns its own child, and the output travels back up", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "nested-e2e-"));
    tmpDirs.push(cwd);
    writeAgents(cwd);

    const toolsSeen = new Map<string, string[]>();

    const respond = (context: Context): FauxReply => {
      const text = firstUserText(context);
      const names = contextToolNames(context);

      if (text.includes("Do the leaf work")) {
        toolsSeen.set("worker", names);
        return WORKER_MARKER;
      }

      if (text.includes("Delegate this downward")) {
        toolsSeen.set("orchestrator", names);
        const alreadySpawned = context.messages.some(
          (m) => m.role === "toolResult" && (m as { toolName?: string }).toolName === "agent",
        );
        if (alreadySpawned) {
          const result = [...context.messages]
            .reverse()
            .find((m) => m.role === "toolResult" && (m as { toolName?: string }).toolName === "agent");
          const inner = ((result?.content ?? []) as Array<{ text?: string }>)
            .map((b) => b.text ?? "")
            .join("");
          return `orchestrator saw: ${inner}`;
        }
        return agentCall({
          subagent_type: "worker",
          description: "leaf work",
          prompt: "Do the leaf work.",
        });
      }

      toolsSeen.set("parent", names);
      const spawned = context.messages.some(
        (m) => m.role === "toolResult" && (m as { toolName?: string }).toolName === "agent",
      );
      if (spawned) {
        const result = [...context.messages]
          .reverse()
          .find((m) => m.role === "toolResult" && (m as { toolName?: string }).toolName === "agent");
        const inner = ((result?.content ?? []) as Array<{ text?: string }>)
          .map((b) => b.text ?? "")
          .join("");
        return `parent saw: ${inner}`;
      }
      return agentCall({
        subagent_type: "orchestrator",
        description: "delegate",
        prompt: "Delegate this downward.",
        run_in_background: false,
      });
    };

    run = await runPrintMode({
      prompt: "Delegate the work.",
      cwd,
      respond,
      live: false,
      beforeRun: () => { registerAgents(loadCustomAgents(cwd)); },
    });

    expect(toolsSeen.get("orchestrator")).toContain("agent");
    expect(toolsSeen.get("orchestrator")).toContain("get_subagent_result");
    expect(toolsSeen.get("orchestrator")).toContain("steer_subagent");
    expect(toolsSeen.get("orchestrator")).toContain("stop_subagent");

    expect(toolsSeen.get("worker")).toBeDefined();
    expect(toolsSeen.get("worker")).not.toContain("agent");

    expect(run.responseText).toContain(WORKER_MARKER);
  });

  it("backgrounds a nested child, polls it by id, and streams its transcript", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "nested-e2e-bg-"));
    tmpDirs.push(cwd);
    writeAgents(cwd);
    const transcriptRoot = join(tmpdir(), `pi-subagents-${process.getuid?.() ?? 0}`, encodeCwd(cwd));
    rmSync(transcriptRoot, { recursive: true, force: true });

    const respond = (context: Context): FauxReply => {
      const text = firstUserText(context);

      if (text.includes("Do the leaf work")) return WORKER_MARKER;

      if (text.includes("Delegate this downward")) {
        const results = toolResultTexts(context);
        const spawned = results.find((r) => r.name === "agent")?.text ?? "";
        const polled = results.find((r) => r.name === "get_subagent_result")?.text;
        if (polled !== undefined) return `orchestrator polled: ${polled}`;
        if (spawned) {
          const id = /Agent ID:\s*(\S+)/.exec(spawned)?.[1];
          expect(id).toBeTruthy();
          return fauxToolCall("get_subagent_result", { agent_id: id as string, wait: true });
        }
        return agentCall({
          subagent_type: "worker",
          description: "leaf work",
          prompt: "Do the leaf work.",
          run_in_background: true,
        });
      }

      if (toolResultTexts(context).some((r) => r.name === "agent")) return "parent done";
      return agentCall({
        subagent_type: "orchestrator",
        description: "delegate",
        prompt: "Delegate this downward.",
        run_in_background: false,
      });
    };

    try {
      run = await runPrintMode({
        prompt: "Delegate the work.",
        cwd,
        respond,
        live: false,
        beforeRun: () => { registerAgents(loadCustomAgents(cwd)); },
      });

      const orchestratorResult = run.parentSession.messages
        .filter((m) => m.role === "toolResult")
        .flatMap((m) => (m.content as Array<{ text?: string }>).map((b) => b.text ?? ""))
        .join("\n");
      expect(orchestratorResult).toContain("orchestrator polled");
      expect(orchestratorResult).toContain(WORKER_MARKER);

      const transcripts = findOutputFiles(transcriptRoot).map((f) => readFileSync(f, "utf-8"));
      const workerTranscript = transcripts.find((t) => {
        const first = JSON.parse(t.split("\n")[0]) as { message?: { content?: unknown } };
        return first.message?.content === "Do the leaf work.";
      });
      expect(workerTranscript).toBeDefined();
      expect(workerTranscript).toContain(WORKER_MARKER);
    } finally {
      rmSync(transcriptRoot, { recursive: true, force: true });
    }
  });
});
