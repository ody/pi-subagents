import { describe, expect, it, vi } from "vitest";

const FS_CALLS: string[] = [];

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  const watch = ["readFileSync", "readdirSync", "existsSync", "statSync", "lstatSync", "realpathSync"] as const;
  const wrapped: Record<string, unknown> = { ...actual };
  for (const name of watch) {
    const original = (actual as any)[name];
    wrapped[name] = (...args: unknown[]) => {
      FS_CALLS.push(`${name}(${String(args[0])})`);
      return original(...args);
    };
  }
  return { ...wrapped, default: wrapped };
});

const { AgentWidget } = await import("../../src/ui/agent-widget.js");
const { ConversationViewer } = await import("../../src/ui/conversation-viewer.js");
const { makeFleet, makeSession, mountViewer, mountWidget } = await import("../helpers/perf-fixtures.js");

describe("a rendered frame touches no filesystem", () => {
  it("AgentWidget.render", () => {
    const w = mountWidget(AgentWidget, makeFleet({ running: 5, queued: 3, finished: 2 }));
    w.render();
    FS_CALLS.length = 0;

    w.render();
    w.render();
    w.dispose();

    expect(FS_CALLS).toEqual([]);
  });

  it("ConversationViewer.render", () => {
    const viewer = mountViewer(ConversationViewer, makeSession(40));
    viewer.render(120);
    FS_CALLS.length = 0;

    viewer.render(120);
    viewer.render(120);

    expect(FS_CALLS).toEqual([]);
  });
});
