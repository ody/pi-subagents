import { initTheme } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import type { AgentRecord } from "../../src/types.js";
import { ConversationViewerOpener, type ViewerUI } from "../../src/ui/conversation-viewer-opener.js";

initTheme();

const theme = { fg: (_c: string, s: string) => s, bold: (s: string) => s } as never;
const tui = { requestRender: () => {}, terminal: { columns: 120, rows: 40 } } as never;
const session = { subscribe: () => () => {}, messages: [] };

function record(over: Partial<AgentRecord> = {}): AgentRecord {
  return {
    id: "a1",
    type: "general-purpose",
    description: "the one",
    status: "running",
    toolUses: 0,
    startedAt: Date.now(),
    session,
    lifetimeUsage: { input: 0, output: 0, cacheWrite: 0 },
    compactionCount: 0,
    ...over,
  } as unknown as AgentRecord;
}

function setup() {
  const manager = { getActivity: vi.fn(() => undefined), abort: vi.fn(() => true), steer: vi.fn(() => true) };
  const opener = new ConversationViewerOpener({
    manager,
    showCost: () => false,
  });
  const notify = vi.fn();
  const customOptions: unknown[] = [];
  const components: { handleInput(data: string): void }[] = [];
  const dones: ((r: undefined) => void)[] = [];
  const custom = vi.fn((factory: (...args: unknown[]) => { handleInput(data: string): void }, options: unknown) => {
    customOptions.push(options);
    return new Promise<undefined>((resolve) => {
      const done = (r: undefined) => resolve(r);
      dones.push(done);
      components.push(factory(tui, theme, undefined, done));
    });
  });
  const ui = { notify, custom } as unknown as ViewerUI;
  return { manager, opener, ui, notify, custom, customOptions, components, dones };
}

describe("ConversationViewerOpener", () => {
  it("opens a centred overlay 95% wide with a maximum height of 90%", () => {
    const t = setup();
    void t.opener.open(t.ui, record());
    expect(t.customOptions).toEqual([
      { overlay: true, overlayOptions: { anchor: "center", width: "95%", maxHeight: "90%" } },
    ]);
  });

  it.each(["queued", "running", "completed", "error"] as const)("names status %s in the no-session notice and opens nothing", async (status) => {
    const t = setup();
    await t.opener.open(t.ui, record({ status, session: undefined }));
    expect(t.notify).toHaveBeenCalledWith(`Agent is ${status} — no session available.`, "info");
    expect(t.custom).not.toHaveBeenCalled();
  });

  it("wires steer to manager.steer with the agent id", () => {
    const t = setup();
    void t.opener.open(t.ui, record({ id: "live" }));
    const viewer = t.components[0];
    viewer.handleInput("\r");
    for (const ch of "go left") viewer.handleInput(ch);
    viewer.handleInput("\r");
    expect(t.manager.steer).toHaveBeenCalledWith("live", "go left");
  });

  it("reports a stop through the same ui it opened on", () => {
    const t = setup();
    void t.opener.open(t.ui, record({ id: "live", description: "the one" }));
    const viewer = t.components[0];
    viewer.handleInput("x");
    viewer.handleInput("x");
    expect(t.manager.abort).toHaveBeenCalledWith("live", "user");
    expect(t.notify).toHaveBeenCalledWith('Stopped "the one".', "info");
  });

  it("close() closes every open viewer", async () => {
    const t = setup();
    const first = t.opener.open(t.ui, record({ id: "a1" }));
    const second = t.opener.open(t.ui, record({ id: "a2" }));
    t.opener.close();
    await expect(Promise.all([first, second])).resolves.toEqual([undefined, undefined]);
  });

  it("close() does nothing once the viewer has closed", async () => {
    const t = setup();
    const opened = t.opener.open(t.ui, record());
    t.dones[0](undefined);
    await opened;
    t.opener.close();
    expect(t.custom).toHaveBeenCalledTimes(1);
  });
});
