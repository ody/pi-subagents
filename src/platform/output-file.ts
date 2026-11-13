import { appendFileSync, chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentSession, AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { SETTING_SPECS } from "../config/settings-defaults.js";

let outputTranscriptDefault = SETTING_SPECS.outputTranscript.default;

export function getOutputTranscriptDefault(): boolean { return outputTranscriptDefault; }
export function setOutputTranscriptDefault(b: boolean): void { outputTranscriptDefault = b; }

export function encodeCwd(cwd: string): string {
  return cwd
    .replace(/[/\\]/g, "-")
    .replace(/^[A-Za-z]:-/, "")
    .replace(/^-+/, "");
}

export function sessionTaskDir(cwd: string, sessionId: string): string {
  const encoded = encodeCwd(cwd);
  const root = join(tmpdir(), `pi-subagents-${process.getuid?.() ?? 0}`);
  mkdirSync(root, { recursive: true, mode: 0o700 });
  try {
    chmodSync(root, 0o700);
  } catch (err) {
    if (process.platform !== "win32") throw err;
  }
  const dir = join(root, encoded, sessionId, "tasks");
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function createOutputFilePath(cwd: string, agentId: string, sessionId: string): string {
  return join(sessionTaskDir(cwd, sessionId), `${agentId}.output`);
}

export function ensureOutputFile(path: string): void {
  try {
    appendFileSync(path, "", "utf-8");
  } catch {}
}

export function writeInitialEntry(path: string, agentId: string, prompt: string, cwd: string): void {
  const entry = {
    isSidechain: true,
    agentId,
    type: "user",
    message: { role: "user", content: prompt },
    timestamp: new Date().toISOString(),
    cwd,
  };
  writeFileSync(path, JSON.stringify(entry) + "\n", "utf-8");
}

export function streamToOutputFile(
  session: AgentSession,
  path: string,
  agentId: string,
  cwd: string,
  startIndex?: number,
): () => void {
  let writtenCount = startIndex ?? 1;

  const flush = () => {
    const messages = session.messages;
    while (writtenCount < messages.length) {
      const msg = messages[writtenCount];
      const entry = {
        isSidechain: true,
        agentId,
        type: msg.role === "assistant" ? "assistant" : msg.role === "user" ? "user" : "toolResult",
        message: msg,
        timestamp: new Date().toISOString(),
        cwd,
      };
      try {
        appendFileSync(path, JSON.stringify(entry) + "\n", "utf-8");
      } catch {}
      writtenCount++;
    }
  };

  const unsubscribe = session.subscribe((event: AgentSessionEvent) => {
    if (event.type === "turn_end") flush();
    if (event.type === "compaction_start") flush();
    if (event.type === "compaction_end" && !event.aborted && event.result) {
      queueMicrotask(() => { writtenCount = session.messages.length; });
    }
  });

  return () => {
    flush();
    unsubscribe();
  };
}
