import { describe, expect, it, vi } from "vitest";
import { renderRunningAgentStatus } from "../../src/tool/agent-tool-render.js";
import type { AgentActivity, WidgetMode } from "../../src/types.js";
import { fgPreservingNestedStyles, formatCost, formatSessionTokens } from "../../src/ui/agent-format.js";
import { AgentWidget as RealAgentWidget, statusBarText } from "../../src/ui/agent-widget.js";

const NO_VIEWER = { open: async () => {} };

class AgentWidget extends RealAgentWidget {
  constructor(
    manager: ConstructorParameters<typeof RealAgentWidget>[0],
    mode?: ConstructorParameters<typeof RealAgentWidget>[1],
    showCost?: ConstructorParameters<typeof RealAgentWidget>[2],
    showModel?: ConstructorParameters<typeof RealAgentWidget>[3],
    viewer: ConstructorParameters<typeof RealAgentWidget>[4] = NO_VIEWER,
  ) {
    super(manager, mode, showCost, showModel, viewer);
  }
}

function withActivity<T>(manager: T, activity: Map<string, unknown>): T {
  return { ...(manager as object), getActivity: (id: string) => activity.get(id) } as T;
}


describe("formatSessionTokens", () => {
  const theme = { fg: (c: string, s: string) => `<${c}>${s}</${c}>`, bold: (s: string) => s };
  const ansiTheme = {
    fg: (c: string, s: string) => {
      const codes: Record<string, string> = { dim: "2", warning: "33", accent: "35" };
      return `\u001b[${codes[c] ?? "31"}m${s}\u001b[39m`;
    },
    bold: (s: string) => s,
  };

  it("applies threshold colors (<70 dim, 70–85 warning, ≥85 error)", () => {
    expect(formatSessionTokens(1234, null, theme)).toBe("1.2k token");
    expect(formatSessionTokens(1234, 50, theme)).toBe("1.2k token (<dim>50%</dim>)");
    expect(formatSessionTokens(1234, 70, theme)).toBe("1.2k token (<warning>70%</warning>)");
    expect(formatSessionTokens(1234, 84, theme)).toBe("1.2k token (<warning>84%</warning>)");
    expect(formatSessionTokens(1234, 85, theme)).toBe("1.2k token (<error>85%</error>)");
    expect(formatSessionTokens(1234, 99, theme)).toBe("1.2k token (<error>99%</error>)");
  });

  it("annotates compaction count alongside percent", () => {
    expect(formatSessionTokens(1234, null, theme, 1)).toBe("1.2k token (<dim>⇊1</dim>)");
    expect(formatSessionTokens(1234, null, theme, 3)).toBe("1.2k token (<dim>⇊3</dim>)");
    expect(formatSessionTokens(1234, 45, theme, 2)).toBe("1.2k token (<dim>45%</dim> · <dim>⇊2</dim>)");
    expect(formatSessionTokens(1234, 88, theme, 4)).toBe("1.2k token (<error>88%</error> · <dim>⇊4</dim>)");
    expect(formatSessionTokens(1234, 45, theme, 0)).toBe("1.2k token (<dim>45%</dim>)");
  });

  it("preserves the outer style after nested annotation styles reset", () => {
    const tokenText = formatSessionTokens(1234, 70, ansiTheme);

    expect(fgPreservingNestedStyles(ansiTheme, "accent", tokenText)).toBe(
      "\u001b[35m1.2k token (\u001b[33m70%\u001b[39m\u001b[35m)\u001b[39m",
    );
  });
});

describe("renderRunningAgentStatus", () => {
  it("renders running status as separate component lines", () => {
    const theme = { fg: (_c: string, s: string) => s };
    const component = renderRunningAgentStatus("⠋", "thinking: xhigh · 4 tool uses", "thinking…", theme);

    expect(component.render(120).map((line) => line.trimEnd())).toEqual([
      "⠋ thinking: xhigh · 4 tool uses",
      "  ⎿  thinking…",
    ]);
  });
});

describe("AgentWidget", () => {
  const theme = { fg: (_c: string, s: string) => s, bold: (s: string) => s };

  function makeActivity(): AgentActivity {
    return {
      activeTools: new Map(),
      toolUses: 0,
      responseText: "",
      turnCount: 1,
    };
  }

  function makeRecord(
    id: string,
    opts: { isBackground?: boolean; parentAgentId?: string; status?: string; completedAt?: number } = {},
  ) {
    return {
      id,
      type: "general-purpose",
      description: `${id} description`,
      status: opts.status ?? "running",
      completedAt: opts.completedAt,
      toolUses: 0,
      startedAt: Date.now(),
      lifetimeUsage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      compactionCount: 0,
      invocation: { modelName: "sonnet 4.6", modelId: "anthropic/claude-sonnet-4-6", thinking: "high" },
      isBackground: opts.isBackground,
      parentAgentId: opts.parentAgentId,
    };
  }

  function renderLines(manager: unknown, activityId: string, mode?: () => WidgetMode, showModel = false): string {
    const widget = new AgentWidget(
      withActivity(manager as any, new Map([[activityId, makeActivity()]])),
      mode,
      () => false,
      () => showModel,
    );
    let factory: any;
    widget.setUICtx({
      setStatus: () => {},
      setWidget: (_key, content) => { factory = content; },
    });
    widget.update();
    if (!factory) return "";
    return factory({ terminal: { columns: 120 }, requestRender: () => {} }, theme)
      .render()
      .join("\n");
  }

  it("shows foreground agents in 'all' mode (and by default)", () => {
    const manager = { listAgents: () => [makeRecord("foreground", { isBackground: false })] };
    expect(renderLines(manager, "foreground")).toContain("foreground description");
    expect(renderLines(manager, "foreground", () => "all")).toContain("foreground description");
  });

  it("shows a running orphaned nested agent as a root row in every widget mode", () => {
    const manager = {
      listAgents: () => [makeRecord("nested", { isBackground: true, parentAgentId: "gone" })],
    };
    for (const mode of ["all", "background"] as const) {
      const lines = renderLines(manager, "nested", () => mode).split("\n");
      const row = lines.findIndex(l => l.includes("nested description"));
      expect(row).toBe(1);
      expect(lines[row]?.startsWith("   ")).toBe(false);
    }
  });

  it("indents the running children of an orphaned nested agent under it", () => {
    const manager = {
      listAgents: () => [
        makeRecord("orphan", { isBackground: true, parentAgentId: "gone" }),
        makeRecord("grandchild", { isBackground: true, parentAgentId: "orphan" }),
      ],
    };
    const lines = renderLines(manager, "orphan", () => "all").split("\n");
    expect(lines.findIndex(l => l.includes("orphan description"))).toBe(1);
    const child = lines.findIndex(l => l.includes("grandchild description"));
    expect(child).toBe(3);
    expect(lines[child]?.startsWith("   ")).toBe(true);
  });

  it("hides a running orphaned nested agent when widgetMode is off", () => {
    const manager = {
      listAgents: () => [makeRecord("nested", { isBackground: true, parentAgentId: "gone" })],
    };
    expect(renderLines(manager, "nested", () => "off")).toBe("");
  });

  it("hides a settled orphaned nested agent", () => {
    const manager = {
      listAgents: () => [makeRecord("nested", { parentAgentId: "gone", status: "completed", completedAt: Date.now() })],
    };
    expect(renderLines(manager, "nested", () => "all")).toBe("");
  });

  it("hides a running nested agent whose top-level ancestor widgetMode hides", () => {
    const manager = {
      listAgents: () => [
        makeRecord("parent", { isBackground: false }),
        makeRecord("child", { isBackground: true, parentAgentId: "parent" }),
      ],
    };
    expect(renderLines(manager, "child", () => "background")).toBe("");
    expect(renderLines(manager, "child", () => "off")).toBe("");
  });

  it("indents a running nested child under its parent", () => {
    const manager = {
      listAgents: () => [
        makeRecord("parent", { isBackground: true }),
        makeRecord("child", { isBackground: true, parentAgentId: "parent" }),
      ],
    };
    const lines = renderLines(manager, "parent", () => "all").split("\n");
    const parent = lines.findIndex(l => l.includes("parent description"));
    const child = lines.findIndex(l => l.includes("child description"));
    expect(parent).toBe(1);
    expect(child).toBe(3);
    expect(lines[child]?.startsWith("   ")).toBe(true);
  });

  it("drops a nested child once it leaves running", () => {
    const manager = {
      listAgents: () => [
        makeRecord("parent", { isBackground: true }),
        makeRecord("child", { isBackground: true, parentAgentId: "parent", status: "completed", completedAt: Date.now() }),
      ],
    };
    expect(renderLines(manager, "parent", () => "all")).not.toContain("child description");
  });

  it("excludes foreground agents in 'background' mode", () => {
    const manager = { listAgents: () => [makeRecord("foreground", { isBackground: false })] };
    expect(renderLines(manager, "foreground", () => "background")).toBe("");
  });

  it("renders background agents in 'background' mode", () => {
    const manager = { listAgents: () => [makeRecord("background", { isBackground: true })] };
    const lines = renderLines(manager, "background", () => "background");
    expect(lines).toContain("Agents");
    expect(lines).toContain("background description");
  });

  it("keeps agents with no isBackground flag in 'background' mode", () => {
    const manager = { listAgents: () => [makeRecord("unflagged", {})] };
    expect(renderLines(manager, "unflagged", () => "background")).toContain("unflagged description");
  });

  it("names the model and thinking on a running row under showModel", () => {
    const manager = { listAgents: () => [makeRecord("bg", { isBackground: true })] };

    expect(renderLines(manager, "bg", () => "background", true))
      .toContain("sonnet 4.6 · thinking: high");
  });

  it("renders the row exactly as before when showModel is off", () => {
    const manager = { listAgents: () => [makeRecord("bg", { isBackground: true })] };

    const off = renderLines(manager, "bg", () => "background");
    expect(off).toContain("bg description");
    expect(off).not.toContain("sonnet 4.6");
    expect(off).not.toContain("thinking:");
  });

  it("carries the short label, never the canonical id, onto the row", () => {
    const manager = { listAgents: () => [makeRecord("bg", { isBackground: true })] };

    expect(renderLines(manager, "bg", () => "background", true))
      .not.toContain("anthropic/claude-sonnet-4-6");
  });

  it("discloses a level the run did not honor", () => {
    const record = makeRecord("bg", { isBackground: true });
    record.invocation = { modelName: "haiku 4.5", thinking: "high", requestedThinking: "max" };
    const manager = { listAgents: () => [record] };

    expect(renderLines(manager, "bg", () => "background", true))
      .toContain("haiku 4.5 · thinking: high (asked max)");
  });

  it("keeps queued agents on one summary line and finished agents visible", () => {
    const records = [
      ...[1, 2, 3].map(i => ({ ...makeRecord(`run${i}`, { isBackground: true }), status: "running" })),
      ...[1, 2, 3, 4, 5, 6, 7].map(i => ({ ...makeRecord(`q${i}`, { isBackground: true }), status: "queued" })),
      ...[1, 2, 3].map(i => ({
        ...makeRecord(`fin${i}`, { isBackground: true }),
        status: "completed",
        completedAt: Date.now(),
      })),
    ];
    const widget = new AgentWidget(
      withActivity({ listAgents: () => records } as any, new Map()),
      () => "background",
      () => false,
      () => true,
    );
    let factory: any;
    widget.setUICtx({ setStatus: () => {}, setWidget: (_key, content) => { factory = content; } });
    for (const r of records) if (r.status === "completed") widget.markFinished(r.id);
    widget.update();
    const lines = factory({ terminal: { columns: 200 }, requestRender: () => {} }, theme).render().join("\n");

    expect(lines).toContain("7 queued");
    expect(lines).not.toContain("q1 description");
    for (const i of [1, 2, 3]) expect(lines).toContain(`fin${i} description`);
    expect(lines).not.toContain("more (");
  });

  describe("connectors", () => {
    function bodyLines(records: unknown[]): string[] {
      const widget = new AgentWidget(
        withActivity({ listAgents: () => records } as any, new Map()),
        () => "all",
        () => false,
        () => false,
      );
      let factory: any;
      widget.setUICtx({ setStatus: () => {}, setWidget: (_key, content) => { factory = content; } });
      for (const r of records as { id: string; status: string }[]) if (r.status === "completed") widget.markFinished(r.id);
      widget.update();
      return factory({ terminal: { columns: 200 }, requestRender: () => {} }, theme).render().slice(1);
    }
    const finished = (id: string) => ({ ...makeRecord(id, { status: "completed", completedAt: Date.now() }) });

    it("closes a last running agent with └─ and drops │ from its activity line", () => {
      const body = bodyLines([makeRecord("a"), makeRecord("b")]);
      expect(body).toHaveLength(4);
      expect(body[0]).toMatch(/^├─/);
      expect(body[1]).toMatch(/^│ /);
      expect(body[2]).toMatch(/^└─/);
      expect(body[3]).not.toContain("│");
      expect(body[3]).toMatch(/^ {5}⎿ /);
    });

    it("closes a queued line that comes last", () => {
      const body = bodyLines([makeRecord("a"), makeRecord("q", { status: "queued" })]);
      expect(body).toHaveLength(3);
      expect(body[0]).toMatch(/^├─/);
      expect(body[1]).toMatch(/^│ /);
      expect(body[2]).toMatch(/^└─ ◦ 1 queued/);
    });

    it("closes a finished line that comes last", () => {
      const body = bodyLines([finished("f")]);
      expect(body).toHaveLength(1);
      expect(body[0]).toMatch(/^└─/);
      const withQueued = bodyLines([finished("f"), makeRecord("q", { status: "queued" })]);
      expect(withQueued[0]).toMatch(/^├─/);
      expect(withQueued[1]).toMatch(/^└─/);
    });
  });

  it("renders nothing in 'off' mode", () => {
    const manager = { listAgents: () => [makeRecord("background", { isBackground: true })] };
    expect(renderLines(manager, "background", () => "off")).toBe("");
  });

  describe("selection (ADR 0038)", () => {
    const DOWN = "\x1b[B";
    const UP = "\x1b[A";
    const ESC = "\x1b";
    const ENTER = "\r";
    const DOWN_RELEASE = "\x1b[1;1:3B";
    const MANAGE = "↓ to manage";
    const SELECTING = "↑↓ select · enter open · esc done";

    type Row = ReturnType<typeof makeRecord>;

    interface Mounted {
      widget: AgentWidget;
      records: Row[];
      press: (data: string) => { consume?: boolean; data?: string } | undefined;
      lines: () => string[];
      selected: () => string[];
      setEditorText: (text: string) => void;
      setFocused: (component: unknown) => void;
      setMode: (mode: WidgetMode) => void;
      unsubscribe: ReturnType<typeof vi.fn>;
      open: ReturnType<typeof vi.fn>;
      closeViewer: () => Promise<void>;
    }

    function mount(records: Row[], mode: WidgetMode = "all"): Mounted {
      let handler: ((data: string) => { consume?: boolean; data?: string } | undefined) | undefined;
      let factory: any;
      let editorText = "";
      let focused: unknown;
      let currentMode = mode;
      let resolveViewer: (() => void) | undefined;
      const unsubscribe = vi.fn();
      const open = vi.fn(() => new Promise<void>((resolve) => { resolveViewer = resolve; }));
      const widget = new AgentWidget(
        withActivity({ listAgents: () => records } as any, new Map()),
        () => currentMode,
        () => false,
        () => false,
        { open },
      );
      widget.setUICtx({
        setStatus: () => {},
        setWidget: (_key, content) => { factory = content; },
      });
      widget.setInputCtx({
        onTerminalInput: (h) => { handler = h; return unsubscribe; },
        getEditorText: () => editorText,
        notify: () => {},
        custom: () => new Promise(() => {}),
      });
      widget.update();
      const tui = { terminal: { columns: 120 }, requestRender: () => {}, get focusedComponent() { return focused; } };
      const component = factory?.(tui, theme);
      const lines = (): string[] => component?.render() ?? [];
      return {
        widget,
        records,
        press: (data) => handler?.(data),
        lines,
        selected: () => lines().filter(line => line.includes("▸")),
        setEditorText: (text) => { editorText = text; },
        setFocused: (component) => { focused = component; },
        setMode: (next) => { currentMode = next; },
        unsubscribe,
        open,
        closeViewer: async () => {
          resolveViewer?.();
          await new Promise((resolve) => setImmediate(resolve));
        },
      };
    }

    const running = (...ids: string[]) => ids.map(id => makeRecord(id, { isBackground: true }));
    const drop = (rows: Row[], id: string) => rows.splice(rows.findIndex(row => row.id === id), 1);

    describe("rule 1: ↓ at an empty prompt starts selection on the first agent row", () => {
      it("starts on the first agent row and consumes the key", () => {
        const m = mount(running("a", "b"));
        expect(m.press(DOWN)).toEqual({ consume: true });
        expect(m.selected()).toHaveLength(1);
        expect(m.selected()[0]).toContain("a description");
      });

      it("starts on a finished row when finished rows draw first", () => {
        const finished = makeRecord("done", { isBackground: true, status: "completed", completedAt: Date.now() });
        const m = mount([...running("a"), finished]);
        m.widget.markFinished("done");
        m.press(DOWN);
        expect(m.selected()[0]).toContain("done description");
      });

      it("does not start while the prompt holds text", () => {
        const m = mount(running("a"));
        m.setEditorText("hello");
        expect(m.press(DOWN)).toBeUndefined();
        expect(m.selected()).toEqual([]);
      });

      it("does not start while another component has focus", () => {
        const m = mount(running("a"));
        m.setFocused({ kind: "selector" });
        expect(m.press(DOWN)).toBeUndefined();
        expect(m.selected()).toEqual([]);
      });

      it("does not start when the widget shows no agent row", () => {
        const m = mount([makeRecord("q", { isBackground: true, status: "queued" })]);
        expect(m.press(DOWN)).toBeUndefined();
        expect(m.selected()).toEqual([]);
      });

      it("ignores key releases and keys other than ↓", () => {
        const m = mount(running("a"));
        expect(m.press(DOWN_RELEASE)).toBeUndefined();
        expect(m.press(UP)).toBeUndefined();
        expect(m.press("x")).toBeUndefined();
        expect(m.selected()).toEqual([]);
      });
    });

    describe("rule 2: only agent rows take the cursor", () => {
      it("never selects the queued row or the overflow line", () => {
        const rows = [...running("r1", "r2", "r3", "r4", "r5", "r6", "r7"), makeRecord("q1", { isBackground: true, status: "queued" })];
        const m = mount(rows);
        m.press(DOWN);
        for (let step = 0; step < 10; step++) {
          const selected = m.selected();
          expect(selected).toHaveLength(1);
          expect(selected[0]).toMatch(/r\d description/);
          expect(selected[0]).not.toContain("queued");
          expect(selected[0]).not.toContain("more (");
          m.press(DOWN);
        }
        expect(m.lines().join("\n")).toContain("1 queued");
      });
    });

    describe("rule 3: ↑ and ↓ move the cursor", () => {
      it("moves down and up through agent rows", () => {
        const m = mount(running("a", "b", "c"));
        m.press(DOWN);
        expect(m.press(DOWN)).toEqual({ consume: true });
        expect(m.selected()[0]).toContain("b description");
        m.press(DOWN);
        expect(m.selected()[0]).toContain("c description");
        expect(m.press(UP)).toEqual({ consume: true });
        expect(m.selected()[0]).toContain("b description");
      });

      it("ends selection on ↑ at the first agent row", () => {
        const m = mount(running("a", "b"));
        m.press(DOWN);
        expect(m.press(UP)).toEqual({ consume: true });
        expect(m.selected()).toEqual([]);
        expect(m.lines()[0]).toContain(MANAGE);
      });

      it("keeps the cursor on the last row at ↓", () => {
        const m = mount(running("a", "b"));
        m.press(DOWN);
        m.press(DOWN);
        expect(m.press(DOWN)).toEqual({ consume: true });
        expect(m.selected()).toHaveLength(1);
        expect(m.selected()[0]).toContain("b description");
      });

      it("walks nested agents in the order the widget draws them", () => {
        const m = mount([
          makeRecord("parent", { isBackground: true }),
          makeRecord("child", { isBackground: true, parentAgentId: "parent" }),
          makeRecord("other", { isBackground: true }),
        ]);
        m.press(DOWN);
        const order: string[] = [];
        for (let step = 0; step < 3; step++) {
          order.push(/(parent|child|other) description/.exec(m.selected()[0] ?? "")?.[1] ?? "");
          m.press(DOWN);
        }
        expect(order).toEqual(["parent", "child", "other"]);
      });
    });

    describe("rule 4: Enter opens the conversation viewer", () => {
      it("opens the selected agent through the viewer opener", () => {
        const rows = running("a", "b");
        const m = mount(rows);
        m.press(DOWN);
        m.press(DOWN);
        expect(m.press(ENTER)).toEqual({ consume: true });
        expect(m.open).toHaveBeenCalledTimes(1);
        expect(m.open.mock.calls[0]?.[1]).toEqual({ kind: "live", record: rows[1] });
      });

      it("lets keys pass to the viewer while it is open", () => {
        const m = mount(running("a"));
        m.press(DOWN);
        m.press(ENTER);
        expect(m.press(DOWN)).toBeUndefined();
        expect(m.press(ESC)).toBeUndefined();
      });

      it("keeps the row of a nested agent that settles while its viewer is open", () => {
        const rows = [makeRecord("parent", { isBackground: true }), makeRecord("child", { isBackground: true, parentAgentId: "parent" })];
        const m = mount(rows);
        m.press(DOWN);
        m.press(DOWN);
        m.press(ENTER);
        rows[1].status = "completed";
        rows[1].completedAt = Date.now();
        expect(m.lines().join("\n")).toContain("child description");
      });

      it("keeps the row of a top-level agent past its linger time while its viewer is open", () => {
        const rows = [makeRecord("a", { isBackground: true }), makeRecord("b", { isBackground: true })];
        const m = mount(rows);
        m.press(DOWN);
        m.press(DOWN);
        m.press(ENTER);
        rows[1].status = "completed";
        rows[1].completedAt = Date.now();
        m.widget.markFinished("b");
        m.widget.onTurnStart();
        m.widget.onTurnStart();
        expect(m.lines().join("\n")).toContain("b description");
      });

      it("returns to selection on the same row when the viewer closes", async () => {
        const m = mount(running("a", "b", "c"));
        m.press(DOWN);
        m.press(DOWN);
        m.press(ENTER);
        await m.closeViewer();
        expect(m.selected()).toHaveLength(1);
        expect(m.selected()[0]).toContain("b description");
        expect(m.press(DOWN)).toEqual({ consume: true });
        expect(m.selected()[0]).toContain("c description");
      });

      it("returns to selection when the viewer fails to open", async () => {
        const m = mount(running("a"));
        m.open.mockImplementationOnce(() => Promise.reject(new Error("boom")));
        m.press(DOWN);
        m.press(ENTER);
        await new Promise((resolve) => setImmediate(resolve));
        expect(m.selected()).toHaveLength(1);
        expect(m.press(DOWN)).toEqual({ consume: true });
      });

      it("drops a nested row after the viewer closes and the cursor moves off it", async () => {
        const rows = [makeRecord("parent", { isBackground: true }), makeRecord("child", { isBackground: true, parentAgentId: "parent" })];
        const m = mount(rows);
        m.press(DOWN);
        m.press(DOWN);
        m.press(ENTER);
        rows[1].status = "completed";
        rows[1].completedAt = Date.now();
        await m.closeViewer();
        expect(m.selected()[0]).toContain("child description");
        m.press(DOWN);
        expect(m.selected()[0]).toContain("parent description");
        expect(m.lines().join("\n")).not.toContain("child description");
      });
    });

    describe("rule 5: Esc and other keys end selection", () => {
      it("ends selection on Esc and consumes the key", () => {
        const m = mount(running("a"));
        m.press(DOWN);
        expect(m.press(ESC)).toEqual({ consume: true });
        expect(m.selected()).toEqual([]);
        expect(m.open).not.toHaveBeenCalled();
      });

      it("ends selection on any other key and passes it through", () => {
        for (const key of ["x", "\x1b[D", "\x1b[C", "\t"]) {
          const m = mount(running("a"));
          m.press(DOWN);
          expect(m.press(key), JSON.stringify(key)).toBeUndefined();
          expect(m.selected()).toEqual([]);
          expect(m.press(UP)).toBeUndefined();
        }
      });

      it("ends selection when the editor loses focus", () => {
        const m = mount(running("a"));
        m.press(DOWN);
        m.setFocused({ kind: "selector" });
        expect(m.press(DOWN)).toBeUndefined();
        expect(m.selected()).toEqual([]);
      });
    });

    describe("rule 6: the cursor follows the agent", () => {
      it("stays on its agent when an earlier row goes away", () => {
        const rows = running("a", "b", "c");
        const m = mount(rows);
        m.press(DOWN);
        m.press(DOWN);
        drop(rows, "a");
        expect(m.selected()).toHaveLength(1);
        expect(m.selected()[0]).toContain("b description");
      });

      it("moves to the agent row that now holds the index when the selected row goes away", () => {
        const rows = running("a", "b", "c");
        const m = mount(rows);
        m.press(DOWN);
        m.press(DOWN);
        drop(rows, "b");
        expect(m.selected()).toHaveLength(1);
        expect(m.selected()[0]).toContain("c description");
      });

      it("moves to the last agent row when no row holds the index", () => {
        const rows = running("a", "b", "c");
        const m = mount(rows);
        m.press(DOWN);
        m.press(DOWN);
        m.press(DOWN);
        drop(rows, "c");
        expect(m.selected()).toHaveLength(1);
        expect(m.selected()[0]).toContain("b description");
      });

      it("stays on a nested agent that leaves running while selected", () => {
        const rows = [makeRecord("parent", { isBackground: true }), makeRecord("child", { isBackground: true, parentAgentId: "parent" })];
        const m = mount(rows);
        m.press(DOWN);
        m.press(DOWN);
        rows[1].status = "completed";
        rows[1].completedAt = Date.now();
        expect(m.selected()).toHaveLength(1);
        expect(m.selected()[0]).toContain("child description");
      });

      it("ends selection when the widget shows no agent row", () => {
        const rows = running("a");
        const m = mount(rows);
        m.press(DOWN);
        drop(rows, "a");
        expect(m.lines()).toEqual([]);
        rows.push(...running("b"));
        expect(m.selected()).toEqual([]);
        expect(m.lines()[0]).toContain(MANAGE);
      });
    });

    describe("rule 7: the selected row always draws", () => {
      it("draws a selected running row that the budget would hide", () => {
        const rows = running("r1", "r2", "r3", "r4", "r5", "r6", "r7", "r8", "r9");
        const m = mount(rows);
        expect(m.lines().join("\n")).not.toContain("r9 description");
        m.press(DOWN);
        for (let step = 0; step < 8; step++) m.press(DOWN);
        const lines = m.lines();
        expect(m.selected()[0]).toContain("r9 description");
        expect(lines.length).toBeLessThanOrEqual(12);
        expect(lines.join("\n")).toContain("more (");
      });

      it("draws a selected finished row that the budget would hide", () => {
        const finished = Array.from({ length: 6 }, (_, i) => makeRecord(`f${i}`, { isBackground: true, status: "completed", completedAt: Date.now() }));
        const rows = [...running("r1", "r2", "r3", "r4", "r5"), ...finished];
        const m = mount(rows);
        for (const record of finished) m.widget.markFinished(record.id);
        m.press(DOWN);
        for (let step = 0; step < 5; step++) m.press(DOWN);
        expect(m.selected()[0]).toContain("f5 description");
        expect(m.lines().length).toBeLessThanOrEqual(12);
      });

      it("hides other rows first and keeps every selected position within the line cap", () => {
        const rows = [...running("r1", "r2", "r3", "r4", "r5", "r6", "r7"), makeRecord("q1", { isBackground: true, status: "queued" })];
        const m = mount(rows);
        m.press(DOWN);
        for (let step = 0; step < 8; step++) {
          const lines = m.lines();
          expect(lines.length).toBeLessThanOrEqual(12);
          expect(m.selected()).toHaveLength(1);
          expect(lines.join("\n")).toContain("1 queued");
          m.press(DOWN);
        }
      });
    });

    describe("rule 8: the heading shows the available keys", () => {
      it("shows '↓ to manage' while selection can start", () => {
        const m = mount(running("a"));
        expect(m.lines()[0]).toBe(`● Agents ${MANAGE}`);
      });

      it("shows the selection keys while selection runs", () => {
        const m = mount(running("a"));
        m.press(DOWN);
        expect(m.lines()[0]).toBe(`● Agents ${SELECTING}`);
        expect(m.lines()[0]).not.toContain(MANAGE);
      });

      it("drops the hint while selection cannot start", () => {
        const m = mount(running("a"));
        m.setEditorText("draft");
        expect(m.lines()[0]).toBe("● Agents");
        m.setEditorText("");
        m.setFocused({ kind: "selector" });
        expect(m.lines()[0]).toBe("● Agents");
      });

      it("re-reads the condition on every render", () => {
        const m = mount(running("a"));
        expect(m.lines()[0]).toContain(MANAGE);
        m.setEditorText("draft");
        expect(m.lines()[0]).not.toContain(MANAGE);
        m.setEditorText("");
        expect(m.lines()[0]).toContain(MANAGE);
      });

      it("shows the manage hint again after selection ends", () => {
        const m = mount(running("a"));
        m.press(DOWN);
        m.press(ESC);
        expect(m.lines()[0]).toBe(`● Agents ${MANAGE}`);
      });
    });

    describe("rule 9: widgetMode off", () => {
      it("never starts selection", () => {
        const m = mount(running("a"), "off");
        expect(m.press(DOWN)).toBeUndefined();
        expect(m.lines()).toEqual([]);
      });

      it("ends a running selection when the mode turns off", () => {
        const m = mount(running("a"));
        m.press(DOWN);
        m.setMode("off");
        expect(m.press(DOWN)).toBeUndefined();
        expect(m.selected()).toEqual([]);
        m.setMode("all");
        expect(m.selected()).toEqual([]);
      });
    });

    describe("terminal input subscription", () => {
      it("unsubscribes on dispose", () => {
        const m = mount(running("a"));
        m.widget.dispose();
        expect(m.unsubscribe).toHaveBeenCalledTimes(1);
      });

      it("moves the subscription when the input context changes", () => {
        const m = mount(running("a"));
        m.widget.setInputCtx({ onTerminalInput: () => () => {}, getEditorText: () => "", notify: () => {}, custom: () => new Promise(() => {}) });
        expect(m.unsubscribe).toHaveBeenCalledTimes(1);
      });
    });
  });
});

describe("statusBarText", () => {
  it("formats running and queued counts", () => {
    expect(statusBarText(1, 0)).toBe("1 running agent");
    expect(statusBarText(2, 1)).toBe("2 running, 1 queued agents");
    expect(statusBarText(0, 1)).toBe("1 queued agent");
    expect(statusBarText(0, 2)).toBe("2 queued agents");
  });
});

describe("AgentWidget status bar and teardown", () => {
  function rec(id: string, status: string) {
    return { id, type: "general-purpose", description: id, status, toolUses: 0, startedAt: Date.now() };
  }

  it("sets status on change, clears it and unregisters the widget when the agents are gone", () => {
    let agents: any[] = [rec("a", "running"), rec("b", "running"), rec("c", "queued")];
    const widget = new AgentWidget({ listAgents: () => agents, getActivity: () => undefined } as any, () => "all");
    const statuses: (string | undefined)[] = [];
    const widgets: unknown[] = [];
    widget.setUICtx({
      setStatus: (_k: string, text: string | undefined) => { statuses.push(text); },
      setWidget: (_k: string, content: unknown) => { widgets.push(content); },
    } as any);

    widget.update();
    expect(statuses).toEqual(["2 running, 1 queued agents"]);
    expect(widgets).toHaveLength(1);
    expect(widgets[0]).toBeTypeOf("function");

    widget.update();
    expect(statuses).toHaveLength(1);

    agents = [rec("a", "running")];
    widget.update();
    expect(statuses).toEqual(["2 running, 1 queued agents", "1 running agent"]);

    agents = [];
    widget.update();
    expect(statuses).toHaveLength(3);
    expect(statuses.at(-1)).toBeUndefined();
    expect(widgets).toHaveLength(2);
    expect(widgets[1]).toBeUndefined();
  });
});

describe("formatCost", () => {
  it("keeps the precision that distinguishes one run from another", () => {
    expect(formatCost(0.0042)).toBe("~$0.0042");
    expect(formatCost(0.0123)).toBe("~$0.0123");
    expect(formatCost(1.239)).toBe("~$1.24");
  });

  it("never pads a round figure with noise, nor cuts it below cents", () => {
    expect(formatCost(0.05)).toBe("~$0.05");
    expect(formatCost(0.4)).toBe("~$0.40");
    expect(formatCost(12)).toBe("~$12.00");
  });

  it("shows nothing when there is nothing to show", () => {
    expect(formatCost(0)).toBe("");
    expect(formatCost(Number.NaN)).toBe("");
    expect(formatCost(-1)).toBe("");
  });

  it("says a real but tiny cost is tiny, not zero", () => {
    expect(formatCost(0.00002)).toBe("<$0.0001");
    expect(formatCost(0)).toBe("");
  });

  it("marks the figure as an estimate", () => {
    expect(formatCost(0.5).startsWith("~")).toBe(true);
  });
});

describe("AgentWidget cost display", () => {
  const theme = { fg: (_c: string, s: string) => s, bold: (s: string) => s };

  function render(showCost: boolean, cost: number): string {
    const agent = {
      id: "a1",
      type: "general-purpose",
      description: "spending agent",
      status: "running",
      toolUses: 1,
      startedAt: Date.now(),
      lifetimeUsage: { input: 1000, output: 200, cacheWrite: 0, cost },
      compactionCount: 0,
    };
    const activity = new Map([["a1", {
      activeTools: new Map(),
      toolUses: 1,
      responseText: "",
      turnCount: 1,
      lifetimeUsage: { input: 9, output: 9, cacheWrite: 0, cost: 0.9 },
    } as unknown as AgentActivity]]);
    const widget = new AgentWidget(
      withActivity({ listAgents: () => [agent] } as any, activity),
      () => "all",
      () => showCost,
    );
    let factory: any;
    widget.setUICtx({ setStatus: () => {}, setWidget: (_k, c) => { factory = c; } } as any);
    widget.update();
    return factory({ terminal: { columns: 200 }, requestRender: () => {} }, theme).render().join("\n");
  }

  it("shows the cost beside the token count when enabled", () => {
    const line = render(true, 0.0042);
    expect(line).toContain("1.2k token");
    expect(line).toContain("~$0.0042");
  });

  it("shows no cost when disabled", () => {
    const line = render(false, 0.0042);
    expect(line).toContain("1.2k token");
    expect(line).not.toContain("$");
  });

  it("shows no cost for an unpriced model, even when enabled", () => {
    const line = render(true, 0);
    expect(line).toContain("1.2k token");
    expect(line).not.toContain("$");
  });

  it("keeps the cost visible after the agent finishes", () => {
    const finished = {
      id: "a1", type: "general-purpose", description: "done agent", status: "completed",
      toolUses: 2, startedAt: Date.now() - 1000, completedAt: Date.now(),
      lifetimeUsage: { input: 1000, output: 200, cacheWrite: 0, cost: 0.0042 },
      compactionCount: 0,
    };
    const widget = new AgentWidget(
      withActivity({ listAgents: () => [finished] } as any, new Map()), () => "all", () => true,
    );
    let factory: any;
    widget.setUICtx({ setStatus: () => {}, setWidget: (_k, c) => { factory = c; } } as any);
    widget.update();
    const out = factory({ terminal: { columns: 200 }, requestRender: () => {} }, theme).render().join("\n");

    expect(out).toContain("done agent");
    expect(out).toContain("~$0.0042");
  });

  it("shows stats for an agent nobody is tracking live", () => {
    const running = {
      id: "untracked", type: "general-purpose", description: "untracked agent", status: "running",
      toolUses: 1, startedAt: Date.now(),
      lifetimeUsage: { input: 1000, output: 200, cacheWrite: 0, cost: 0.0042 },
      compactionCount: 0,
    };
    const widget = new AgentWidget(
      withActivity({ listAgents: () => [running] } as any, new Map()), () => "all", () => true,
    );
    let factory: any;
    widget.setUICtx({ setStatus: () => {}, setWidget: (_k, c) => { factory = c; } } as any);
    widget.update();
    const out = factory({ terminal: { columns: 200 }, requestRender: () => {} }, theme).render().join("\n");

    expect(out).toContain("1.2k token");
    expect(out).toContain("~$0.0042");
  });

  it("defaults to hiding it", () => {
    const agent = {
      id: "a1", type: "general-purpose", description: "d", status: "running",
      toolUses: 0, startedAt: Date.now(),
      lifetimeUsage: { input: 1000, output: 200, cacheWrite: 0, cost: 0.5 }, compactionCount: 0,
    };
    const activity = new Map([["a1", {
      activeTools: new Map(), toolUses: 0, responseText: "", turnCount: 1,
    } as AgentActivity]]);
    const widget = new AgentWidget(withActivity({ listAgents: () => [agent] } as any, activity), () => "all");
    let factory: any;
    widget.setUICtx({ setStatus: () => {}, setWidget: (_k, c) => { factory = c; } } as any);
    widget.update();
    expect(factory({ terminal: { columns: 200 }, requestRender: () => {} }, theme).render().join("\n"))
      .not.toContain("$");
  });
});

describe("AgentWidget overflow accounting", () => {
  const theme = { fg: (_c: string, s: string) => s, bold: (s: string) => s };

  function record(id: string, status: string) {
    return {
      id,
      type: "general-purpose",
      description: `${id} description`,
      status,
      toolUses: 0,
      startedAt: Date.now(),
      completedAt: status === "completed" ? Date.now() : undefined,
      lifetimeUsage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      compactionCount: 0,
      isBackground: true,
    };
  }

  function renderMix(counts: { running: number; queued: number; finished: number }): string[] {
    const agents = [
      ...Array.from({ length: counts.running }, (_, i) => record(`run${i}`, "running")),
      ...Array.from({ length: counts.queued }, (_, i) => record(`q${i}`, "queued")),
      ...Array.from({ length: counts.finished }, (_, i) => record(`fin${i}`, "completed")),
    ];
    const activity = new Map(agents.map(a => [a.id, {
      activeTools: new Map(),
      toolUses: 0,
      responseText: "",
      turnCount: 1,
    } as AgentActivity]));
    const widget = new AgentWidget(withActivity({ listAgents: () => agents } as any, activity), () => "all");
    let factory: any;
    widget.setUICtx({ setStatus: () => {}, setWidget: (_k, c) => { factory = c; } } as any);
    widget.update();
    if (!factory) return [];
    return factory({ terminal: { columns: 200 }, requestRender: () => {} }, theme).render();
  }

  const footer = (lines: string[]) => lines.find(l => l.includes("more ("));

  const SHAPES: { running: number; queued: number; finished: number }[] = [];
  for (let running = 0; running <= 8; running++)
    for (let queued = 0; queued <= 8; queued++)
      for (let finished = 0; finished <= 8; finished++) SHAPES.push({ running, queued, finished });

  it("never exceeds the line cap, for any agent mix", () => {
    for (const counts of SHAPES) {
      expect(renderMix(counts).length, JSON.stringify(counts)).toBeLessThanOrEqual(12);
    }
  });

  it("never prints a footer that miscounts what it hid, for any agent mix", () => {
    for (const counts of SHAPES) {
      const f = footer(renderMix(counts));
      if (!f) continue;
      const total = Number(/\+(\d+) more/.exec(f)?.[1]);
      const where = `${JSON.stringify(counts)} → ${f}`;
      expect(total, where).toBeGreaterThan(0);
      expect(total, where).toBeLessThanOrEqual(counts.running + counts.finished);
    }
  });

  it("keeps the queued summary visible when the running agents fill the widget", () => {
    const lines = renderMix({ running: 5, queued: 3, finished: 1 });
    expect(lines.join("\n")).toContain("3 queued");
  });

  it("counts everything it hid — the footer total matches what is missing", () => {
    const counts = { running: 5, queued: 3, finished: 1 };
    const lines = renderMix(counts);
    const body = lines.join("\n");

    const shownRunning = counts.running - [...Array(counts.running).keys()]
      .filter(i => !body.includes(`run${i} description`)).length;
    const shownFinished = counts.finished - [...Array(counts.finished).keys()]
      .filter(i => !body.includes(`fin${i} description`)).length;
    const actuallyHidden = (counts.running - shownRunning) + (counts.finished - shownFinished);

    const reported = Number(/\+(\d+) more/.exec(footer(lines) ?? "")?.[1] ?? -1);
    expect(reported).toBe(actuallyHidden);
  });

  it("gives the queued summary priority over finished lines", () => {
    const lines = renderMix({ running: 4, queued: 2, finished: 3 });
    expect(lines.join("\n")).toContain("2 queued");
  });

  it("renders everything with no footer when the rows fit", () => {
    const lines = renderMix({ running: 2, queued: 1, finished: 1 });
    expect(lines.join("\n")).toContain("1 queued");
    expect(footer(lines)).toBeUndefined();
  });

  it("shows the completion line again after a finished agent is resumed", () => {
    const agent = record("resumed", "completed");
    const activity = new Map([[agent.id, {
      activeTools: new Map(),
      toolUses: 0,
      responseText: "",
      turnCount: 1,
    } as AgentActivity]]);
    const widget = new AgentWidget(withActivity({ listAgents: () => [agent] } as any, activity), () => "all");
    let factory: any;
    widget.setUICtx({ setStatus: () => {}, setWidget: (_k: any, c: any) => { factory = c; } } as any);
    const render = () => {
      widget.update();
      return (factory?.({ terminal: { columns: 200 }, requestRender: () => {} }, theme).render() ?? []).join("\n");
    };

    widget.markFinished(agent.id);
    widget.onTurnStart();
    widget.onTurnStart();
    expect(render()).not.toContain("resumed description");

    agent.status = "running";
    widget.markRunning(agent.id);
    expect(render()).toContain("resumed description");

    agent.status = "completed";
    widget.markFinished(agent.id);
    expect(render()).toContain("resumed description");
  });
});

describe("AgentWidget status presentation", () => {
  const tagTheme = { fg: (c: string, s: string) => `<${c}>${s}</${c}>`, bold: (s: string) => s };

  function widgetFor(status: string, error?: string) {
    const agent = {
      id: "s1",
      type: "general-purpose",
      description: "probe",
      status,
      error,
      completedAt: status === "running" || status === "queued" ? undefined : Date.now(),
      toolUses: 0,
      startedAt: Date.now(),
      lifetimeUsage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      compactionCount: 0,
    };
    const widget = new AgentWidget(withActivity({ listAgents: () => [agent] } as any, new Map()), () => "all");
    let factory: any;
    widget.setUICtx({ setStatus: () => {}, setWidget: (_k: any, c: any) => { factory = c; } } as any);
    widget.markFinished(agent.id);
    const render = (): string => {
      widget.update();
      return (factory?.({ terminal: { columns: 200 }, requestRender: () => {} }, tagTheme).render() ?? []).join("\n");
    };
    return { widget, render };
  }

  it.each([
    ["completed", "<success>✓</success> "],
    ["steered", "<warning>✓</warning> "],
    ["aborted", "<error>✗</error> "],
    ["error", "<error>✗</error> "],
    ["stopped", "<dim>■</dim> "],
    ["queued", "<muted>◦</muted> "],
  ])("shows the %s icon", (status, icon) => {
    expect(widgetFor(status).render()).toContain(icon);
  });

  it("shows a spinner frame in the accent color for running", () => {
    expect(widgetFor("running").render()).toMatch(/<accent>[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]<\/accent> /);
  });

  it.each([
    ["steered", "<warning> (turn limit)</warning>"],
    ["aborted", "<error> aborted</error>"],
    ["error", "<error> error: boom</error>"],
    ["stopped", "<dim> stopped</dim>"],
  ])("writes the %s status text in the mapped color", (status, text) => {
    expect(widgetFor(status, "boom").render()).toContain(text);
  });

  it.each([
    ["completed", 1],
    ["steered", 1],
    ["stopped", 1],
    ["aborted", 2],
    ["error", 2],
  ])("keeps a %s row for %i turn start(s)", (status, turns) => {
    const { widget, render } = widgetFor(status);
    for (let i = 0; i < turns - 1; i++) widget.onTurnStart();
    expect(render()).toContain("probe");
    widget.onTurnStart();
    expect(render()).not.toContain("probe");
  });
});
