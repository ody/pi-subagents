import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai";
import {
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { streamToOutputFile, writeInitialEntry } from "../src/platform/output-file.js";
import { fauxModelBackend } from "./helpers/faux-model-backend.js";
import { registerFauxProvider } from "./helpers/pi-ai.js";

const TURNS_BEFORE_COMPACT = 6;

describe("output-file streaming across a real compaction (#145)", () => {
  let tmp: string;
  let prevAgentDir: string | undefined;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "issue-145-"));
    prevAgentDir = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = tmp;
  });

  afterEach(() => {
    if (prevAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = prevAgentDir;
    rmSync(tmp, { recursive: true, force: true });
  });

  it("keeps writing post-compaction messages to the output file", async () => {
    const cwd = tmp;
    const faux = registerFauxProvider({
      provider: "faux",
      models: [{ id: "faux-1", contextWindow: 200_000 }],
    });
    const model = faux.getModel();
    const backend = fauxModelBackend(model);
    const respond = (context: { messages: Array<{ role: string; content: unknown }> }) => {
      const last = context.messages[context.messages.length - 1];
      const text = typeof last?.content === "string"
        ? last.content
        : JSON.stringify(last?.content ?? "");
      if (text.includes("conversation to summarize") || text.includes("PREFIX of a turn")) {
        return fauxAssistantMessage([fauxText("summary of everything so far")]);
      }
      if (text.includes("final question")) {
        return fauxAssistantMessage([fauxText("POST-COMPACTION-ANSWER")]);
      }
      const q = text.match(/question (\d+)/);
      if (last?.role === "user" && q) {
        return fauxAssistantMessage([fauxText(`answer-${q[1]} ${"filler ".repeat(200)}`)]);
      }
      throw new Error(`unexpected faux request: ${text.slice(0, 120)}`);
    };
    faux.setResponses(Array.from({ length: 16 }, () => respond));

    const agentDir = getAgentDir();
    const loader = new DefaultResourceLoader({
      cwd,
      agentDir,
      systemPromptOverride: () => "You are a test agent.",
      appendSystemPromptOverride: () => [],
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
    });
    await loader.reload();

    const { session } = await createAgentSession({
      cwd,
      agentDir,
      model,
      modelRuntime: backend.modelRuntime as never,
      resourceLoader: loader,
      sessionManager: SessionManager.inMemory(cwd),
      settingsManager: SettingsManager.inMemory({
        compaction: { enabled: false, keepRecentTokens: 500 },
        retry: { enabled: false },
      }),
    });

    const outPath = join(tmp, "agent.output");
    writeInitialEntry(outPath, "agent-145", "repro", cwd);
    const cleanup = streamToOutputFile(session as never, outPath, "agent-145", cwd);

    const readEntries = () =>
      readFileSync(outPath, "utf-8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as Record<string, unknown>);

    for (let i = 0; i < TURNS_BEFORE_COMPACT; i++) {
      await session.prompt(`question ${i}`);
    }
    const writtenBeforeCompact = readEntries().length;
    expect(writtenBeforeCompact).toBeGreaterThan(TURNS_BEFORE_COMPACT);

    const lenBefore = session.messages.length;
    const result = await session.compact();
    expect(result?.summary).toContain("summary");
    expect(session.messages.length).toBeLessThan(lenBefore);

    await session.prompt("final question");
    cleanup();

    const entries = readEntries();
    const all = JSON.stringify(entries);
    expect(all).toContain("final question");
    expect(all).toContain("POST-COMPACTION-ANSWER");
    for (let i = 0; i < TURNS_BEFORE_COMPACT; i++) {
      expect(all.split(`answer-${i} `).length - 1).toBe(1);
    }
    expect(entries.length).toBe(writtenBeforeCompact + 2);
  }, 30_000);
});
