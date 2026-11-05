import { Editor, visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";
import { registerAgents } from "../src/agents/agent-types.js";
import type { AgentManager } from "../src/manager/agent-manager.js";
import type { AgentActivity, AgentConfig, AgentRecord, ViewerMarkdownMode } from "../src/types.js";
import { getDisplayName } from "../src/ui/agent-format.js";
import {
  FleetList,
  type FleetUICtx,
  formatFleetElapsed,
  formatFleetTokens,
} from "../src/ui/fleet-list.js";

const DOWN = "\x1b[B";
const UP = "\x1b[A";
const LEFT = "\x1b[D";
const RIGHT = "\x1b[C";
const ESC = "\x1b";
const ENTER = "\r";
const DOWN_RELEASE = "\x1b[1;1:3B";

const theme = { fg: (c: string, s: string) => `<${c}>${s}</${c}>`, bold: (s: string) => `*${s}*` };

const BADGED_TYPE = "colored-reviewer";
const PURPLE_BACKGROUND = "\u001b[48;2;130;125;189m";
const BADGED_CONFIG: AgentConfig = {
  name: BADGED_TYPE,
  displayName: "Code Reviewer",
  color: "purple",
  description: "Reviews code",
  extensions: false,
  skills: false,
  systemPrompt: "Review code.",
  promptMode: "replace",
};

function plain(row: string): string {
  return row.replace(/\u001b\[[0-9;]*m/g, "").replace(/<\/?[a-zA-Z]+>|\*/g, "");
}

const FAKE_SESSION = { subscribe: () => () => {}, messages: [] };

function makeRecord(over: Partial<AgentRecord> = {}): AgentRecord {
  return {
    id: "a1",
    type: "general-purpose",
    description: "Sleep then report 1",
    status: "running",
    toolUses: 0,
    startedAt: Date.now(),
    session: FAKE_SESSION as any,
    lifetimeUsage: { input: 13100, output: 0, cacheWrite: 0 },
    compactionCount: 0,
    ...over,
  } as AgentRecord;
}

function withActivity(manager: AgentManager, activity: Map<string, AgentActivity>): AgentManager {
  return { ...(manager as object), getActivity: (id: string) => activity.get(id) } as AgentManager;
}

function fakeManager(agents: AgentRecord[]): AgentManager {
  return {
    listAgents: () => agents,
    getActivity: () => undefined,
    abort: () => true,
    steer: vi.fn(() => true),
  } as unknown as AgentManager;
}

interface Harness {
  fleet: FleetList;
  ui: FleetUICtx;
  manager: AgentManager;
  overlayComponent: () => { handleInput(data: string): void } | undefined;
  press: (data: string) => { consume?: boolean } | undefined;
  render: (width?: number) => string[];
  setEditorText: (t: string) => void;
  overlayOpened: () => boolean;
  overlayClosed: () => boolean;
  closeOverlay: () => Promise<void>;
  widgetTui: { requestRender(): void; focusedComponent?: unknown };
}

function harness(
  agents: AgentRecord[],
  opts: {
    viewerMarkdown?: () => ViewerMarkdownMode;
    onViewerMarkdown?: (mode: ViewerMarkdownMode) => void;
  } = {},
): Harness {
  let inputHandler: ((data: string) => { consume?: boolean } | undefined) | undefined;
  let widgetFactory: ((tui: any, theme: any) => { render(w: number): string[] }) | undefined;
  let editorText = "";
  let opened = false;
  let closed = false;
  let overlayDone: ((r: undefined) => void) | undefined;
  let overlayComponent: { handleInput(data: string): void } | undefined;
  const fakeTui = { requestRender: () => {}, terminal: { columns: 120, rows: 40 } };

  const ui: FleetUICtx = {
    setWidget: (_key, content) => { widgetFactory = content as any; },
    onTerminalInput: (h) => { inputHandler = h; return () => { inputHandler = undefined; }; },
    getEditorText: () => editorText,
    notify: () => {},
    custom: ((factory: any) => {
      opened = true;
      return new Promise<undefined>((resolve) => {
        const done = (r: undefined) => { closed = true; overlayDone = undefined; resolve(r); };
        overlayDone = done;
        overlayComponent = factory(fakeTui, theme, undefined, done);
      });
    }) as FleetUICtx["custom"],
  };

  const manager = fakeManager(agents);
  const fleet = new FleetList(manager, undefined, opts.viewerMarkdown, opts.onViewerMarkdown);
  fleet.setUICtx(ui);
  fleet.update();

  return {
    fleet,
    ui,
    manager,
    overlayComponent: () => overlayComponent,
    press: (data) => inputHandler?.(data),
    render: (width = 120) => (widgetFactory ? widgetFactory(fakeTui, theme).render(width) : []),
    setEditorText: (t) => { editorText = t; },
    overlayOpened: () => opened,
    overlayClosed: () => closed,
    closeOverlay: async () => { overlayDone?.(undefined); await Promise.resolve(); },
    widgetTui: fakeTui,
  };
}

describe("formatFleetElapsed", () => {
  it("renders integer seconds (no decimal, no suffix)", () => {
    expect(formatFleetElapsed(0)).toBe("0s");
    expect(formatFleetElapsed(11_000)).toBe("11s");
    expect(formatFleetElapsed(11_400)).toBe("11s");
    expect(formatFleetElapsed(11_600)).toBe("12s");
  });
  it("floors negatives to 0s", () => {
    expect(formatFleetElapsed(-500)).toBe("0s");
  });
});

describe("formatFleetTokens", () => {
  it("prefixes a down-arrow and uses plural 'tokens'", () => {
    expect(formatFleetTokens(13_100)).toBe("↓ 13.1k tokens");
    expect(formatFleetTokens(950)).toBe("↓ 950 tokens");
    expect(formatFleetTokens(1_200_000)).toBe("↓ 1.2M tokens");
  });
});

describe("FleetList navigation", () => {
  it("does not register a widget when there are no agents", () => {
    const h = harness([]);
    expect(h.render()).toEqual([]);
  });

  it("nests a child record under its parent, indented", () => {
    const h = harness([
      makeRecord({ id: "top", description: "top-level" }),
      makeRecord({ id: "nested", description: "nested-child", parentAgentId: "top" }),
    ]);
    const rows = h.render();
    const parent = rows.findIndex(l => l.includes("top-level"));
    const child = rows.findIndex(l => l.includes("nested-child"));
    expect(parent).toBeGreaterThan(0);
    expect(child).toBe(parent + 1);
    expect(rows[parent]).toContain("▾");
    expect(plain(rows[child] ?? "").indexOf("○")).toBeGreaterThan(plain(rows[parent] ?? "").indexOf("▾"));
  });

  it("collapses and re-expands a parent with ← and →", () => {
    const h = harness([
      makeRecord({ id: "top", description: "top-level" }),
      makeRecord({ id: "nested", description: "nested-child", parentAgentId: "top" }),
    ]);
    h.press(DOWN);
    h.press(DOWN);
    expect(h.press(LEFT)).toEqual({ consume: true });
    expect(h.render().join("\n")).not.toContain("nested-child");
    expect(h.render().find(l => l.includes("top-level"))).toContain("▸");
    expect(h.press(RIGHT)).toEqual({ consume: true });
    expect(h.render().join("\n")).toContain("nested-child");
  });

  it("moves ← from a leaf child up to its parent", () => {
    const h = harness([
      makeRecord({ id: "top", description: "top-level" }),
      makeRecord({ id: "nested", description: "nested-child", parentAgentId: "top" }),
    ]);
    h.press(DOWN);
    h.press(DOWN);
    h.press(DOWN);
    expect(h.render().find(l => l.includes("nested-child"))).toContain("●");
    h.press(LEFT);
    expect(h.render().find(l => l.includes("top-level"))).toContain("●");
  });

  it("keeps the selection on the same agent when a sibling appears", () => {
    const agents = [
      makeRecord({ id: "a1", description: "first", startedAt: 10 }),
      makeRecord({ id: "a2", description: "second", startedAt: 20 }),
    ];
    const h = harness(agents);
    h.press(DOWN);
    h.press(DOWN);
    h.press(DOWN);
    expect(h.render().find(l => l.includes("second"))).toContain("●");
    agents.push(makeRecord({ id: "a0", description: "earlier", startedAt: 1 }));
    expect(h.render().find(l => l.includes("second"))).toContain("●");
  });

  it("opens a grandchild's own conversation, and steers that record", () => {
    const h = harness([
      makeRecord({ id: "top", description: "top-level" }),
      makeRecord({ id: "mid", description: "middle", parentAgentId: "top" }),
      makeRecord({ id: "deep", description: "grandchild", parentAgentId: "mid" }),
    ]);
    h.press(DOWN);
    h.press(DOWN);
    h.press(DOWN);
    h.press(DOWN);
    expect(h.render().find(l => l.includes("grandchild"))).toContain("●");
    h.press(ENTER);
    expect(h.overlayOpened()).toBe(true);
    h.fleet.dispose();
  });

  it("marks an agent whose parent is gone as detached", () => {
    const h = harness([makeRecord({ id: "orphan", description: "lost", parentAgentId: "evicted" })]);
    expect(h.render().find(l => l.includes("lost"))).toContain("↯");
  });

  it("activates on ↓ at an empty prompt, consuming the key", () => {
    const h = harness([makeRecord()]);
    const res = h.press(DOWN);
    expect(res).toEqual({ consume: true });
    expect(h.render().some(l => l.includes("enter view"))).toBe(true);
  });

  it("also activates on ← (matches the '← for agents' hint)", () => {
    const h = harness([makeRecord()]);
    expect(h.press(LEFT)).toEqual({ consume: true });
  });

  it("does NOT activate when the prompt is non-empty (typing is preserved)", () => {
    const h = harness([makeRecord()]);
    h.setEditorText("hello");
    expect(h.press(DOWN)).toBeUndefined();
  });

  it("ignores key-release events so one tap moves exactly one row", () => {
    const h = harness([
      makeRecord({ id: "a1", description: "one" }),
      makeRecord({ id: "a2", description: "two" }),
    ]);
    h.press(DOWN);
    h.press(DOWN_RELEASE);
    expect(h.render().find(l => l.includes("main"))).toContain("●");
    h.press(DOWN);
    h.press(DOWN_RELEASE);
    expect(h.render().find(l => l.includes("one"))).toContain("●");
    expect(h.render().find(l => l.includes("two"))).toContain("○");
  });

  it("renders the whole selected row in the theme's primary text color (#230)", () => {
    const h = harness([
      makeRecord({ id: "a1", description: "one" }),
      makeRecord({ id: "a2", description: "two" }),
    ]);
    h.press(DOWN);
    h.press(DOWN);
    const selected = h.render().find(l => l.includes("one"))!;
    expect(selected).toContain("<accent>●</accent>");
    expect(selected).toContain("<text>one</text>");
    expect(selected).toMatch(/<text>\d+s · ↓ [\d.]+k? tokens<\/text>/);
    expect(selected).toContain(`<text>${getDisplayName("general-purpose")}</text>`);
    const unselected = h.render().find(l => l.includes("two"))!;
    expect(unselected).toContain("<dim>○</dim>");
    expect(unselected).toMatch(/<dim>\d+s · ↓ [\d.]+k? tokens<\/dim>/);
    expect(unselected).not.toContain("<text>");
  });

  it("keeps a color badge on the selected row, bolded, without shifting it (#230)", () => {
    registerAgents(new Map([[BADGED_TYPE, BADGED_CONFIG]]));
    try {
      const h = harness([
        makeRecord({ id: "a1", type: BADGED_TYPE, description: "one" }),
        makeRecord({ id: "a2", type: BADGED_TYPE, description: "two" }),
      ]);
      h.press(DOWN);
      const before = h.render().find(l => l.includes("one"))!;
      expect(before).toContain(`${PURPLE_BACKGROUND}`);
      expect(before).toContain(` ${BADGED_CONFIG.displayName} `);

      h.press(DOWN);
      const selected = h.render().find(l => l.includes("one"))!;
      expect(selected).toContain(PURPLE_BACKGROUND);
      expect(selected).toContain(`* ${BADGED_CONFIG.displayName} *`);
      expect(selected).not.toContain(`<text>${BADGED_CONFIG.displayName}`);
      expect(plain(selected).indexOf("one")).toBe(plain(before).indexOf("one"));
    } finally {
      registerAgents(new Map());
    }
  });

  it("moves selection down/up and clamps at the ends", () => {
    const agents = [
      makeRecord({ id: "a1", description: "one" }),
      makeRecord({ id: "a2", description: "two" }),
    ];
    const h = harness(agents);
    h.press(DOWN);
    h.press(DOWN);
    expect(h.render().find(l => l.includes("one"))).toContain("●");
    h.press(DOWN);
    h.press(DOWN);
    expect(h.render().find(l => l.includes("two"))).toContain("●");
    expect(h.render().find(l => l.includes("one"))).toContain("○");
  });

  it("↑ above 'main' deactivates (returns to the prompt)", () => {
    const h = harness([makeRecord()]);
    h.press(DOWN);
    expect(h.press(UP)).toEqual({ consume: true });
    expect(h.render().some(l => l.includes("← for agents"))).toBe(true);
  });

  it("Esc deactivates", () => {
    const h = harness([makeRecord()]);
    h.press(DOWN);
    expect(h.press(ESC)).toEqual({ consume: true });
    expect(h.render().some(l => l.includes("← for agents"))).toBe(true);
  });

  it("↑ from a lower row moves up one row and stays active", () => {
    const h = harness([
      makeRecord({ id: "a1", description: "one" }),
      makeRecord({ id: "a2", description: "two" }),
    ]);
    h.press(DOWN);
    h.press(DOWN);
    h.press(DOWN);
    expect(h.press(UP)).toEqual({ consume: true });
    expect(h.render().find(l => l.includes("one"))).toContain("●");
    expect(h.render().some(l => l.includes("enter view"))).toBe(true);
  });

  it("consumes → on a leaf and ← on main without changing selection", () => {
    const h = harness([makeRecord({ id: "a1", description: "one" })]);
    h.press(DOWN);
    expect(h.press(LEFT)).toEqual({ consume: true });
    expect(h.render().find(l => l.includes("main"))).toContain("●");
    expect(h.press(RIGHT)).toEqual({ consume: true });
    h.press(DOWN);
    expect(h.press(RIGHT)).toEqual({ consume: true });
    expect(h.render().find(l => l.includes("one"))).toContain("●");
  });

  it("passes non-nav keys through and cancels navigation", () => {
    const h = harness([makeRecord()]);
    h.press(DOWN);
    expect(h.press("x")).toBeUndefined();
    expect(h.render().some(l => l.includes("← for agents"))).toBe(true);
  });

  it("ignores all input while disabled and hides the widget", () => {
    const h = harness([makeRecord()]);
    h.fleet.setEnabled(false);
    expect(h.press(DOWN)).toBeUndefined();
    expect(h.render()).toEqual([]);
  });

  it("re-arms the refresh timer when the list is re-shown (toggle off→on)", () => {
    vi.useFakeTimers();
    try {
      const agents = [makeRecord({ id: "a1" })];
      const listAgents = vi.fn(() => agents);
      const manager = { listAgents, abort: () => true } as unknown as AgentManager;
      const fleet = new FleetList(manager);
      fleet.setUICtx({
        setWidget: () => {}, onTerminalInput: () => () => {}, getEditorText: () => "",
        notify: () => {}, custom: (() => new Promise<undefined>(() => {})) as FleetUICtx["custom"],
      });
      fleet.update();
      fleet.setEnabled(false);
      fleet.setEnabled(true);
      const before = listAgents.mock.calls.length;
      vi.advanceTimersByTime(250);
      expect(listAgents.mock.calls.length).toBeGreaterThan(before);
      fleet.dispose();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("FleetList vs other focused components (#123)", () => {
  function realEditor(): Editor {
    const fakeTui = { requestRender: () => {} };
    const theme = { borderColor: (s: string) => s, selectList: {} };
    return new Editor(fakeTui as any, theme as any);
  }

  function focusInHarness(h: Harness, focused: unknown): void {
    h.widgetTui.focusedComponent = focused;
    h.render();
  }

  it("does not steal ↓ from a focused selector (activation)", () => {
    const h = harness([makeRecord()]);
    focusInHarness(h, { kind: "selector" });
    expect(h.press(DOWN)).toBeUndefined();
  });

  it("does not steal navigation keys from a selector opened while the list was active", () => {
    const h = harness([makeRecord()]);
    focusInHarness(h, realEditor());
    expect(h.press(DOWN)).toEqual({ consume: true });
    focusInHarness(h, { kind: "selector" });
    expect(h.press(DOWN)).toBeUndefined();
    expect(h.press(ENTER)).toBeUndefined();
    expect(h.press(ESC)).toBeUndefined();
    expect(h.render().some(l => l.includes("← for agents"))).toBe(true);
  });

  it("still activates when the prompt editor has focus", () => {
    const h = harness([makeRecord()]);
    focusInHarness(h, realEditor());
    expect(h.press(DOWN)).toEqual({ consume: true });
  });

  it("assumes the editor when focus is unknowable (no tui yet / nothing focused)", () => {
    const h = harness([makeRecord()]);
    expect(h.press(DOWN)).toEqual({ consume: true });
  });
});

describe("FleetList rendering", () => {
  it("renders main + agent rows with markers, type, description and right-aligned stats", () => {
    const h = harness([makeRecord({ description: "Sleep then report 1" })]);
    const lines = h.render(120);
    expect(lines[0]).toContain("← for agents");
    expect(lines.find(l => l.includes("main"))).toContain("●");
    const agentLine = lines.find(l => l.includes("Sleep then report 1"))!;
    expect(agentLine).toContain("○");
    expect(agentLine).toContain(getDisplayName("general-purpose"));
    expect(agentLine).toContain("↓ 13.1k tokens");
    expect(agentLine).toMatch(/\d+s · ↓/);
  });

  it("orders agents earliest-launched first (top)", () => {
    const agents = [
      makeRecord({ id: "new", description: "newest", startedAt: 2000 }),
      makeRecord({ id: "old", description: "oldest", startedAt: 1000 }),
    ];
    const lines = harness(agents).render();
    const oldIdx = lines.findIndex(l => l.includes("oldest"));
    const newIdx = lines.findIndex(l => l.includes("newest"));
    expect(oldIdx).toBeGreaterThanOrEqual(0);
    expect(oldIdx).toBeLessThan(newIdx);
  });

  it("hides agents that have no session yet (pending)", () => {
    const agents = [
      makeRecord({ id: "live", description: "running one" }),
      makeRecord({ id: "pending", description: "queued one", status: "queued", session: undefined }),
    ];
    const lines = harness(agents).render();
    expect(lines.some(l => l.includes("running one"))).toBe(true);
    expect(lines.some(l => l.includes("queued one"))).toBe(false);
  });

  it("collapses overflow into a '↓ N more' indicator", () => {
    const agents = Array.from({ length: 8 }, (_, i) =>
      makeRecord({ id: `a${i}`, description: `report ${i}` }));
    const h = harness(agents);
    const lines = h.render(120);
    expect(lines.some(l => l.includes("↓ 3 more"))).toBe(true);
  });

  it("never emits a line wider than the terminal (guards wrap-induced flicker)", () => {
    const agents = Array.from({ length: 8 }, (_, i) =>
      makeRecord({ id: `a${i}`, description: `a very long agent description number ${i} that keeps going` }));
    const h = harness(agents);
    for (const w of [4, 8, 12, 20, 40, 80, 200]) {
      for (const line of h.render(w)) {
        expect(visibleWidth(line)).toBeLessThanOrEqual(w);
      }
    }
  });

  it("windows the visible agents so the selection stays on screen", () => {
    const agents = Array.from({ length: 8 }, (_, i) =>
      makeRecord({ id: `a${i}`, description: `report ${i}` }));
    const h = harness(agents);
    h.press(DOWN);
    for (let i = 0; i < 8; i++) h.press(DOWN);
    const lines = h.render(120);
    expect(lines.find(l => l.includes("report 7"))).toContain("●");
    expect(lines.some(l => l.includes("↑"))).toBe(true);
  });
});

describe("FleetList overlay lifecycle", () => {
  it("Enter on 'main' just deactivates (no overlay)", () => {
    const h = harness([makeRecord()]);
    h.press(DOWN);
    h.press(ENTER);
    expect(h.overlayOpened()).toBe(false);
    expect(h.render().some(l => l.includes("← for agents"))).toBe(true);
  });

  it("keeps the cursor on the viewed agent after closing, even if the list reordered", async () => {
    const fakeSession = { subscribe: () => () => {}, messages: [] };
    const agents = [
      makeRecord({ id: "a1", description: "one", session: fakeSession as any }),
      makeRecord({ id: "a2", description: "two", session: fakeSession as any }),
      makeRecord({ id: "a3", description: "three", session: fakeSession as any }),
    ];
    const h = harness(agents);
    h.press(DOWN);
    h.press(DOWN);
    h.press(DOWN);
    h.press(ENTER);
    agents.splice(0, 1);
    await h.closeOverlay();
    expect(h.render().find(l => l.includes("two"))).toContain("●");
    expect(h.render().find(l => l.includes("three"))).toContain("○");
  });

  it("wires the viewer's steer composer to manager.steer with the agent id", () => {
    const agents = [makeRecord({ id: "live", description: "the one" })];
    const h = harness(agents);
    h.press(DOWN);
    h.press(DOWN);
    h.press(ENTER);

    const viewer = h.overlayComponent();
    expect(viewer).toBeDefined();
    viewer!.handleInput("\r");
    for (const ch of "go left") viewer!.handleInput(ch);
    viewer!.handleInput("\r");

    expect(h.manager.steer).toHaveBeenCalledWith("live", "go left");
  });

  it("hands the viewer the user's markdown setting, and persists a mode chosen with m", () => {
    const persisted: ViewerMarkdownMode[] = [];
    const h = harness([makeRecord({ id: "live", description: "the one" })], {
      viewerMarkdown: () => "all",
      onViewerMarkdown: (mode) => persisted.push(mode),
    });
    h.press(DOWN);
    h.press(DOWN);
    h.press(ENTER);

    h.overlayComponent()!.handleInput("m");

    expect(persisted).toEqual(["off"]);
  });

  it("does NOT auto-close when the viewed agent finishes (final output stays readable)", () => {
    const agents = [makeRecord({ id: "live", description: "the one" })];
    const h = harness(agents);
    h.press(DOWN);
    h.press(DOWN);
    h.press(ENTER);
    expect(h.overlayOpened()).toBe(true);
    agents[0] = makeRecord({ id: "live", description: "the one", status: "completed", completedAt: Date.now() - 60_000 });
    h.fleet.onAgentFinished("live");
    expect(h.overlayClosed()).toBe(false);
    expect(h.render().some(l => l.includes("the one"))).toBe(true);
  });

  it("lingers a finished agent in the list, then drops it after the window", () => {
    const recent = makeRecord({ id: "r", description: "recent done", status: "completed", completedAt: Date.now() });
    expect(harness([recent]).render().some(l => l.includes("recent done"))).toBe(true);
    const old = makeRecord({ id: "o", description: "old done", status: "completed", completedAt: Date.now() - 60_000 });
    expect(harness([old]).render().some(l => l.includes("old done"))).toBe(false);
  });
});

describe("FleetList cost display", () => {
  const theme = { fg: (_c: string, s: string) => s, bold: (s: string) => s };

  function row(showCost: boolean, cost: number, activity?: Map<string, AgentActivity>): string {
    const record = makeRecord({ lifetimeUsage: { input: 13100, output: 0, cacheWrite: 0, cost } });
    const fleet = new FleetList(withActivity(fakeManager([record]), activity ?? new Map()), () => showCost);
    let factory: any;
    fleet.setUICtx({
      setWidget: (_k: string, c: any) => { factory = c; },
      onTerminalInput: () => () => {},
      getEditorText: () => "",
      notify: () => {},
      custom: (() => new Promise(() => {})) as any,
    } as any);
    fleet.update();
    return factory({ requestRender: () => {}, terminal: { columns: 120, rows: 40 } }, theme).render(120).join("\n");
  }

  it("appends the cost after the token count when enabled", () => {
    const out = row(true, 0.0042);
    expect(out).toContain("13.1k tokens");
    expect(out).toContain("~$0.0042");
  });

  it("shows no cost when disabled, and none for an unpriced model", () => {
    expect(row(false, 0.0042)).not.toContain("$");
    expect(row(true, 0)).not.toContain("$");
  });

  it("reads the record, so the figures do not change when the agent finishes", () => {
    const tracked = new Map<string, AgentActivity>([["a1", {
      activeTools: new Map(), toolUses: 0, responseText: "", turnCount: 1,
      lifetimeUsage: { input: 1, output: 1, cacheWrite: 0, cost: 0.9 },
    } as unknown as AgentActivity]]);

    expect(row(true, 0.0042, tracked)).toBe(row(true, 0.0042));
  });
});
