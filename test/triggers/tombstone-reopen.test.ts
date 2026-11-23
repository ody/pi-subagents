import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { type RetentionDeps, resolveMention } from "../../src/manager/agent-retention.js";
import { registerMentionInput } from "../../src/triggers/mention-input.js";
import type { AgentTombstone } from "../../src/types.js";

describe("reopening a tombstone", () => {
  it("keeps the tombstone and reports the missing session path", async () => {
    const directory = mkdtempSync(join(tmpdir(), "missing-agent-session-"));
    try {
      const entry: AgentTombstone = {
        id: "agent-id", handle: "audit", alias: "reviewer", type: "Explore",
        description: "audit", sessionFile: join(directory, "missing.jsonl"),
        completedAt: 1, status: "completed", result: "saved result",
      };
      const retention: RetentionDeps = {
        agents: new Map(), activities: new Map(), startups: new Map(),
        tombstones: new Map([[entry.handle, entry]]),
      };
      const on = vi.fn();
      const notify = vi.fn();
      const spawnResolved = vi.fn();
      registerMentionInput({ on } as never, {
        manager: { resolveMention: (handle) => resolveMention(retention, handle), steer: vi.fn(), awaitStartup: vi.fn() },
        settings: { agentMentionMode: "direct" },
        isAgentMentionsEnabled: () => true,
        spawnResolved,
        spawnTopLevel: vi.fn(),
        startBackgroundResume: vi.fn(),
        reloadCustomAgents: vi.fn(),
        agentTool: undefined,
      } as never);
      const input = on.mock.calls[0][1];

      expect(await input({ source: "interactive", text: "@reviewer continue" }, { mode: "tui", ui: { notify } })).toEqual({ action: "handled" });
      expect(notify).toHaveBeenCalledWith(`Could not resume @reviewer — its session file is missing: ${entry.sessionFile}`, "warning");
      expect(resolveMention(retention, "reviewer")).toEqual({ kind: "tombstone", entry });
      expect(retention.tombstones.get("audit")?.result).toBe("saved result");
      expect(spawnResolved).not.toHaveBeenCalled();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
