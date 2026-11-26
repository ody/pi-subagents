import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initTheme, SessionManager } from "@earendil-works/pi-coding-agent";
import { KeybindingsManager, TUI_KEYBINDINGS } from "@earendil-works/pi-tui";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentRecord, AgentTombstone } from "../../src/types.js";
import { ConversationViewerOpener, type ViewerUI } from "../../src/ui/conversation-viewer-opener.js";
import { MainSessionStatus } from "../../src/ui/main-session-status.js";

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

function tombstone(over: Partial<AgentTombstone> = {}): AgentTombstone {
  return {
    handle: "fixer",
    id: "h1",
    type: "general-purpose",
    description: "the finished one",
    sessionFile: "/sessions/h1.jsonl",
    completedAt: Date.now(),
    status: "completed",
    ...over,
  };
}

function setup() {
  const manager = { getActivity: vi.fn(() => undefined), abort: vi.fn(() => true), steer: vi.fn(() => true) };
  const opener = new ConversationViewerOpener({
    manager,
    showCost: () => false,
    mainSession: new MainSessionStatus(),
  });
  const notify = vi.fn();
  const customOptions: unknown[] = [];
  const components: { handleInput(data: string): void; render(width: number): string[] }[] = [];
  const dones: ((r: undefined) => void)[] = [];
  const custom = vi.fn((factory: (...args: unknown[]) => { handleInput(data: string): void }, options: unknown) => {
    customOptions.push(options);
    return new Promise<undefined>((resolve) => {
      const done = (r: undefined) => resolve(r);
      dones.push(done);
      components.push(factory(tui, theme, new KeybindingsManager(TUI_KEYBINDINGS), done));
    });
  });
  const ui = { notify, custom } as unknown as ViewerUI;
  return { manager, opener, ui, notify, custom, customOptions, components, dones };
}

const strip = (text: string) => text.replace(/\x1b\[[0-9;]*m/g, "");

describe("ConversationViewerOpener", () => {
  it("opens a centred overlay 95% wide with a maximum height of 90%", () => {
    const t = setup();
    void t.opener.open(t.ui, { kind: "live", record: record() });
    expect(t.customOptions).toEqual([
      { overlay: true, overlayOptions: { anchor: "center", width: "95%", maxHeight: "90%" } },
    ]);
  });

  it.each(["queued", "running", "completed", "error"] as const)("names status %s in the no-session notice and opens nothing", async (status) => {
    const t = setup();
    await t.opener.open(t.ui, { kind: "live", record: record({ status, session: undefined }) });
    expect(t.notify).toHaveBeenCalledWith(`Agent is ${status} — no session available.`, "info");
    expect(t.custom).not.toHaveBeenCalled();
  });

  it("wires steer to manager.steer with the agent id", () => {
    const t = setup();
    void t.opener.open(t.ui, { kind: "live", record: record({ id: "live" }) });
    const viewer = t.components[0];
    viewer.handleInput("\r");
    for (const ch of "go left") viewer.handleInput(ch);
    viewer.handleInput("\r");
    expect(t.manager.steer).toHaveBeenCalledWith("live", "go left");
  });

  it("reports a stop through the same ui it opened on", () => {
    const t = setup();
    void t.opener.open(t.ui, { kind: "live", record: record({ id: "live", description: "the one" }) });
    const viewer = t.components[0];
    viewer.handleInput("x");
    viewer.handleInput("x");
    expect(t.manager.abort).toHaveBeenCalledWith("live", "user");
    expect(t.notify).toHaveBeenCalledWith('Stopped "the one".', "info");
  });

  it("close() closes every open viewer", async () => {
    const t = setup();
    const first = t.opener.open(t.ui, { kind: "live", record: record({ id: "a1" }) });
    const second = t.opener.open(t.ui, { kind: "live", record: record({ id: "a2" }) });
    t.opener.close();
    await expect(Promise.all([first, second])).resolves.toEqual([undefined, undefined]);
  });

  it("close() does nothing once the viewer has closed", async () => {
    const t = setup();
    const opened = t.opener.open(t.ui, { kind: "live", record: record() });
    t.dones[0](undefined);
    await opened;
    t.opener.close();
    expect(t.custom).toHaveBeenCalledTimes(1);
  });
});

describe("ConversationViewerOpener history", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "pi-viewer-history-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function writeSession(...contents: string[]): string {
    const sessionDir = join(dir, "sessions");
    mkdirSync(sessionDir, { recursive: true });
    const manager = SessionManager.create(dir, sessionDir);
    for (const content of contents) manager.appendMessage({ role: "user", content, timestamp: 0 });
    const file = manager.getSessionFile();
    if (!file) throw new Error("the session file was not written");
    return file;
  }

  it("opens a tombstone's stored transcript from its session file", async () => {
    const t = setup();
    const sessionFile = writeSession("first stored line", "second stored line");
    const entry = tombstone({ sessionFile, description: "the finished one" });

    void t.opener.open(t.ui, { kind: "history", entry });

    expect(t.customOptions).toEqual([
      { overlay: true, overlayOptions: { anchor: "center", width: "95%", maxHeight: "90%" } },
    ]);
    const out = strip(t.components[0].render(120).join("\n"));
    expect(out).toContain("first stored line");
    expect(out).toContain("second stored line");
    expect(out).toContain("the finished one");
  });

  it("names the path in the notice when the session file is missing", async () => {
    const t = setup();
    const sessionFile = join(dir, "gone.jsonl");

    await t.opener.open(t.ui, { kind: "history", entry: tombstone({ sessionFile }) });

    expect(t.notify).toHaveBeenCalledWith(
      `Could not open @fixer — its session file is missing or unreadable: ${sessionFile}`,
      "warning",
    );
    expect(t.custom).not.toHaveBeenCalled();
  });

  it("names the alias in the notice and opens nothing when the file is unreadable", async () => {
    const t = setup();
    const entry = tombstone({ alias: "reviewer", sessionFile: dir });

    await t.opener.open(t.ui, { kind: "history", entry });

    expect(t.notify).toHaveBeenCalledWith(
      `Could not open @reviewer — its session file is missing or unreadable: ${dir}`,
      "warning",
    );
    expect(t.custom).not.toHaveBeenCalled();
  });

  it("keeps the live no-session notice for records", async () => {
    const t = setup();
    await t.opener.open(t.ui, { kind: "live", record: record({ status: "completed", session: undefined }) });
    expect(t.notify).toHaveBeenCalledWith("Agent is completed — no session available.", "info");
  });

  it("never starts a run, never aborts, and leaves the tombstone and its file in place", async () => {
    const t = setup();
    const sessionFile = writeSession("stored line");
    const entry = tombstone({ sessionFile });

    const opened = t.opener.open(t.ui, { kind: "history", entry });
    const viewer = t.components[0];
    viewer.handleInput("x");
    viewer.handleInput("x");
    viewer.handleInput("\r");
    t.dones[0](undefined);
    await opened;

    expect(t.manager.abort).not.toHaveBeenCalled();
    expect(t.manager.steer).not.toHaveBeenCalled();
    expect(entry.sessionFile).toBe(sessionFile);
    expect(SessionManager.open(sessionFile).buildSessionContext().messages).toHaveLength(1);
  });
});
