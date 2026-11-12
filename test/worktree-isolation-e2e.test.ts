import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Context } from "@earendil-works/pi-ai";
import { fauxToolCall } from "@earendil-works/pi-ai";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { setWorktreeIsolationEnabled } from "../src/platform/worktree.js";
import { agentCall, type FauxReply, type PrintModeRun, runPrintMode } from "./helpers/print-mode-runner.js";

vi.setConfig({ testTimeout: 30_000 });

const MARKER_FILE = "agent-work.txt";
const CHILD_MARKER = "CHILD-EDITED-ITS-TREE";
const CHILD_PROMPT = "Create the marker file.";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, stdio: "pipe", timeout: 10_000 }).toString().trim();
}

function initGitRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "wt-iso-e2e-"));
  git(dir, "init");
  git(dir, "config", "user.email", "test@test.com");
  git(dir, "config", "user.name", "Test");
  git(dir, "config", "commit.gpgsign", "false");
  writeFileSync(join(dir, "README.md"), "# Test repo");
  git(dir, "add", "README.md");
  git(dir, "commit", "-m", "initial");
  return dir;
}

function installGeneralPurpose(): void {
  const dir = join(getAgentDir(), "agents");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "general-purpose.md"), "---\ndescription: general-purpose\n---\n\nYou are general-purpose.\n");
}

function firstUserText(context: Context): string {
  const first = context.messages.find((m) => m.role === "user");
  const content = first?.content;
  if (typeof content === "string") return content;
  return ((content ?? []) as Array<{ text?: string }>).map((b) => b.text ?? "").join("");
}

function toolResultNames(context: Context): string[] {
  return context.messages
    .filter((m) => m.role === "toolResult")
    .map((m) => (m as { toolName?: string }).toolName ?? "");
}

function agentResultText(session: Context): string {
  return session.messages
    .filter((m) => m.role === "toolResult" && (m as { toolName?: string }).toolName === "agent")
    .flatMap((m) => ((m.content ?? []) as Array<{ text?: string }>).map((b) => b.text ?? ""))
    .join("\n");
}

function respondSpawning(isolation: "worktree" | undefined): (context: Context) => FauxReply {
  return (context: Context): FauxReply => {
    if (firstUserText(context).includes(CHILD_PROMPT)) {
      if (!toolResultNames(context).includes("bash")) {
        return fauxToolCall("bash", { command: `echo isolated > ${MARKER_FILE}` });
      }
      return CHILD_MARKER;
    }
    if (toolResultNames(context).includes("agent")) {
      return `parent saw: ${agentResultText(context)}`;
    }
    return agentCall({
      run_in_background: false,
      description: "worktree work",
      prompt: CHILD_PROMPT,
      ...(isolation ? { isolation } : {}),
    });
  };
}

describe("worktree isolation e2e (real git, real pi-mono, faux model)", () => {
  let run: PrintModeRun | undefined;
  const repos: string[] = [];

  afterEach(async () => {
    await run?.dispose();
    run = undefined;
    setWorktreeIsolationEnabled(true);
    for (const dir of repos.splice(0)) {
      try { git(dir, "worktree", "prune"); } catch { }
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("runs the child in the copy and lands its changes on a branch, not the main checkout", async () => {
    const repo = initGitRepo();
    repos.push(repo);

    run = await runPrintMode({
      prompt: "Delegate the work.",
      cwd: repo,
      beforeRun: installGeneralPurpose,
      respond: respondSpawning("worktree"),
      live: false,
    });

    expect(existsSync(join(repo, MARKER_FILE))).toBe(false);

    const result = agentResultText(run.parentSession);
    expect(result).toContain(CHILD_MARKER);

    const branch = /Changes saved to branch `(pi-agent-[^`]+)`/.exec(result)?.[1];
    expect(branch).toBeTruthy();
    expect(result).toContain(`git merge ${branch}`);

    expect(git(repo, "branch", "--list", branch!)).toContain(branch!);
    expect(git(repo, "ls-tree", "--name-only", branch!)).toContain(MARKER_FILE);

    expect(git(repo, "worktree", "list").split("\n")).toHaveLength(1);
  });

  it("downgrades to the main checkout when the project set worktreeIsolation: false", async () => {
    const repo = initGitRepo();
    repos.push(repo);
    mkdirSync(join(repo, ".pi"), { recursive: true });
    writeFileSync(join(repo, ".pi", "subagents.json"), JSON.stringify({ worktreeIsolation: false }));

    run = await runPrintMode({
      prompt: "Delegate the work.",
      cwd: repo,
      beforeRun: installGeneralPurpose,
      respond: respondSpawning("worktree"),
      live: false,
    });

    const result = agentResultText(run.parentSession);
    expect(result).toContain(CHILD_MARKER);

    expect(existsSync(join(repo, MARKER_FILE))).toBe(true);
    expect(git(repo, "branch", "--list", "pi-agent-*")).toBe("");
    expect(git(repo, "worktree", "list").split("\n")).toHaveLength(1);

    expect(result).not.toContain("Changes saved to branch");
  });
});
