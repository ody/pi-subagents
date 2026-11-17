import { createBashToolDefinition, initTheme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";
import type { AgentRecord } from "../../src/types.js";
import { ConversationViewer } from "../../src/ui/conversation-viewer.js";

initTheme();

const CTRL_O = "\x0f";

function mockTui(rows = 40, columns = 80) {
  return {
    terminal: { rows, columns },
    requestRender: vi.fn(),
  } as any;
}

function mockSession(messages: any[] = [], messageRenderer?: unknown) {
  return {
    messages,
    subscribe: vi.fn(() => vi.fn()),
    dispose: vi.fn(),
    getSessionStats: () => ({ tokens: { input: 0, output: 0, cacheWrite: 0 } }),
    getToolDefinition: (name: string) => (name === "bash" ? createBashToolDefinition("/work") : undefined),
    extensionRunner: {
      getMessageRenderer: () => messageRenderer,
      resolveToolRenderers: (_name: string, base: () => unknown) => base(),
    },
    sessionManager: { getCwd: () => "/work" },
  } as any;
}

function mockRecord(overrides: Partial<AgentRecord> = {}): AgentRecord {
  return {
    id: "test-1",
    type: "general-purpose",
    description: "test agent",
    status: "running",
    toolUses: 0,
    startedAt: Date.now(),
    ...overrides,
  } as AgentRecord;
}

function ansiTheme() {
  return {
    fg: (_color: string, text: string) => `\x1b[38;5;240m${text}\x1b[0m`,
    bold: (text: string) => `\x1b[1m${text}\x1b[22m`,
  } as any;
}

function assertAllLinesFit(lines: string[], width: number) {
  for (let i = 0; i < lines.length; i++) {
    const vw = visibleWidth(lines[i]);
    expect(vw, `line ${i} exceeds width (${vw} > ${width}): ${JSON.stringify(lines[i])}`).toBeLessThanOrEqual(width);
  }
}

const strip = (text: string) => text.replace(/\x1b\[[0-9;]*m/g, "");

const userMessage = (content: string) => ({ role: "user", content, timestamp: 0 });
const assistantMessage = (...content: any[]) => ({
  role: "assistant", content, stopReason: "stop", timestamp: 0,
});
const text = (value: string) => ({ type: "text", text: value });
const toolCall = (id: string, name: string, args: Record<string, unknown> = {}) => ({
  type: "toolCall", id, name, arguments: args,
});
const toolResult = (id: string, name: string, value: string) => ({
  role: "toolResult", toolCallId: id, toolName: name, content: [text(value)], isError: false, timestamp: 0,
});

describe("ConversationViewer invocation line", () => {
  function invocationLine(invocation: AgentRecord["invocation"]): string {
    const viewer = new ConversationViewer(
      mockTui(30, 200), mockSession([]), mockRecord({ invocation }), undefined,
      { fg: (_c: string, t: string) => t, bold: (t: string) => t } as any,
      vi.fn(),
    );
    const row = viewer.render(200).find(l => l.includes("↳"));
    return row ? row.slice(row.indexOf("↳")).replace(/\s*│\s*$/, "") : "";
  }

  it("names the model with its provider", () => {
    expect(invocationLine({
      modelName: "sonnet 4.6",
      modelId: "anthropic/claude-sonnet-4-6",
      thinking: "high",
      maxTurns: 60,
    })).toBe("↳ anthropic/claude-sonnet-4-6 · thinking: high · max turns: 60");
  });

  it("falls back to the short label when no canonical id was captured", () => {
    expect(invocationLine({ modelName: "sonnet 4.6", thinking: "high" }))
      .toBe("↳ sonnet 4.6 · thinking: high");
  });

  it("discloses a model and level the run did not honor", () => {
    expect(invocationLine({
      modelName: "haiku 4.5",
      modelId: "anthropic/claude-haiku-4-5",
      pinnedModel: "google/gemini-3-pro",
      thinking: "low",
      requestedThinking: "max",
    })).toBe("↳ anthropic/claude-haiku-4-5 (over pinned google/gemini-3-pro) · thinking: low (asked max)");
  });

  it("renders no row at all for a record with no invocation", () => {
    expect(invocationLine(undefined)).toBe("");
  });
});

describe("ConversationViewer cost display", () => {
  function header(on: boolean, cost: number): string {
    const record = mockRecord({
      lifetimeUsage: { input: 1000, output: 200, cacheWrite: 0, cost },
    } as Partial<AgentRecord>);
    const viewer = new ConversationViewer(
      mockTui(30, 200), mockSession([]), record, undefined,
      { fg: (_c: string, t: string) => t, bold: (t: string) => t } as any,
      vi.fn(), undefined, undefined, undefined, on,
    );
    return viewer.render(200).join("\n");
  }

  it("shows the cost beside the token count when enabled", () => {
    const out = header(true, 0.0042);
    expect(out).toContain("1.2k token");
    expect(out).toContain("~$0.0042");
  });

  it("shows no cost when disabled", () => {
    const out = header(false, 0.0042);
    expect(out).toContain("1.2k token");
    expect(out).not.toContain("$");
  });

  it("shows no cost for a model with no pricing data", () => {
    expect(header(true, 0)).not.toContain("$");
  });
});

describe("ConversationViewer header and footer", () => {
  const tagTheme = {
    fg: (c: string, t: string) => `<${c}>${t}</${c}>`,
    bold: (t: string) => t,
  } as any;

  function render(record: AgentRecord, session = mockSession(), rows = 30): string[] {
    return new ConversationViewer(mockTui(rows, 120), session, record, undefined, tagTheme, vi.fn()).render(120);
  }

  it.each([
    ["running", "<accent>●</accent>"],
    ["queued", "<muted>◦</muted>"],
    ["completed", "<success>✓</success>"],
    ["steered", "<warning>✓</warning>"],
    ["aborted", "<error>✗</error>"],
    ["error", "<error>✗</error>"],
    ["stopped", "<dim>■</dim>"],
  ])("shows the %s status icon in the header", (status, icon) => {
    const lines = render(mockRecord({ status: status as AgentRecord["status"] }));
    expect(lines[1]).toContain(`</border> ${icon} `);
  });

  it("reads 100% when all content fits the viewport", () => {
    const session = mockSession([assistantMessage(text("hi"))]);
    const footer = render(mockRecord({ status: "completed" }), session).at(-2) ?? "";
    expect(footer).toMatch(/\d+ lines · 100%/);
  });

  it("reads a partial percentage when content overflows the viewport", () => {
    const body = Array.from({ length: 60 }, (_, i) => `line ${i}`).join("\n");
    const session = mockSession([assistantMessage(text(body))]);
    const viewer = new ConversationViewer(mockTui(20, 120), session, mockRecord({ status: "completed" }), undefined, tagTheme, vi.fn());
    viewer.render(200);
    viewer.handleInput("\x1b[H");
    const footer = viewer.render(200).at(-2) ?? "";
    const m = footer.match(/(\d+) lines · (\d+)%/);
    expect(m).not.toBeNull();
    expect(Number(m?.[2])).toBeGreaterThan(0);
    expect(Number(m?.[2])).toBeLessThan(100);
  });
});

describe("ConversationViewer", () => {
  it("closes with Ctrl+C when not composing", () => {
    const done = vi.fn();
    const viewer = new ConversationViewer(
      mockTui(), mockSession(), mockRecord(), undefined, ansiTheme(), done,
    );

    viewer.handleInput("\x03");

    expect(done).toHaveBeenCalledOnce();
    expect(done).toHaveBeenCalledWith(undefined);
  });

  describe("render width safety", () => {
    const widths = [8, 20, 40, 80, 120, 216];

    function fitsAt(messages: any[], activity?: unknown) {
      for (const w of widths) {
        const viewer = new ConversationViewer(
          mockTui(30, w), mockSession(messages), mockRecord(), activity as any, ansiTheme(), vi.fn(),
        );
        assertAllLinesFit(viewer.render(w), w);
      }
    }

    it("fits with empty messages", () => {
      fitsAt([]);
    });

    it("fits with plain text messages", () => {
      fitsAt([userMessage("Hello, how are you?"), assistantMessage(text("I am fine, thank you for asking."))]);
    });

    it("keeps bordered rows exact-width at a double-width truncation boundary", () => {
      const width = 40;
      for (let prefixLength = 0; prefixLength < width; prefixLength++) {
        const viewer = new ConversationViewer(
          mockTui(30, width),
          mockSession([]),
          mockRecord({ description: `${"a".repeat(prefixLength)}界more` }),
          undefined,
          ansiTheme(),
          vi.fn(),
        );

        for (const line of viewer.render(width)) {
          expect(
            visibleWidth(line),
            `prefix ${prefixLength} produced an under-width bordered row: ${JSON.stringify(line)}`,
          ).toBe(width);
        }
      }
    });

    it("fits with text longer than the viewport", () => {
      const longLine = "A".repeat(500);
      fitsAt([
        userMessage(longLine),
        assistantMessage(text(longLine), toolCall("t1", "read", { path: longLine })),
        toolResult("t1", "read", longLine),
      ]);
    });

    it("fits with embedded ANSI escape codes in a tool result", () => {
      const ansiText = `\x1b[1mBold heading\x1b[22m and \x1b[31mred text\x1b[0m ${"X".repeat(300)}`;
      fitsAt([assistantMessage(toolCall("t1", "bash")), toolResult("t1", "bash", ansiText)]);
    });

    it("fits with long URLs", () => {
      const url = `https://example.com/${"a/b/c/d/e/".repeat(30)}?q=${"x".repeat(100)}`;
      fitsAt([assistantMessage(text(`Check this link: ${url}`))]);
    });

    it("fits with wide table-like content", () => {
      const header = `| ${Array.from({ length: 20 }, (_, i) => `Column${i}`).join(" | ")} |`;
      const dataRow = `| ${Array.from({ length: 20 }, () => "value123").join(" | ")} |`;
      fitsAt([assistantMessage(text([header, dataRow, dataRow, dataRow].join("\n")))]);
    });

    it("fits with bashExecution messages", () => {
      fitsAt([{
        role: "bashExecution", command: `cat ${"/very/long/path/".repeat(20)}file.txt`,
        output: "O".repeat(600), exitCode: 0, cancelled: false, truncated: false, timestamp: 0,
      }]);
    });

    it("fits with a running activity indicator", () => {
      const activity = {
        activeTools: new Map([["read", "file.ts"], ["grep", "pattern"]]),
        toolUses: 5, tokens: "10k", responseText: "R".repeat(400),
        session: { getSessionStats: () => ({ tokens: { total: 50000 } }) },
      };
      fitsAt([userMessage("do the thing"), assistantMessage(text("working on it"))], activity);
    });

    it("fits with a long tool name", () => {
      fitsAt([assistantMessage(text("Let me check that."), toolCall("t1", `very_long_tool_name_${"x".repeat(200)}`))]);
    });

    it("fits with mixed ANSI and unicode content", () => {
      const mixed = `\x1b[32m✓\x1b[0m Test passed — 日本語テスト ${"あ".repeat(50)} \x1b[33m⚠\x1b[0m`;
      fitsAt([assistantMessage(toolCall("t1", "bash")), toolResult("t1", "bash", mixed)]);
    });
  });

  describe("stop key", () => {
    const W = 80;

    it("two-press x stops a running agent (first arms, second aborts)", () => {
      const onStop = vi.fn();
      const tui = mockTui(30, W);
      const viewer = new ConversationViewer(
        tui, mockSession(), mockRecord({ status: "running" }), undefined, ansiTheme(), vi.fn(), onStop,
      );

      expect(viewer.render(W).join("\n")).toContain("x stop");

      viewer.handleInput("x");
      expect(onStop).not.toHaveBeenCalled();
      expect(tui.requestRender).toHaveBeenCalled();
      expect(viewer.render(W).join("\n")).toContain("x again to STOP");

      viewer.handleInput("x");
      expect(onStop).toHaveBeenCalledTimes(1);
    });

    it("any other key disarms the confirm", () => {
      const onStop = vi.fn();
      const viewer = new ConversationViewer(
        mockTui(30, W), mockSession(), mockRecord({ status: "running" }), undefined, ansiTheme(), vi.fn(), onStop,
      );

      viewer.handleInput("x");
      viewer.handleInput("j");
      expect(viewer.render(W).join("\n")).toContain("x stop");
      expect(viewer.render(W).join("\n")).not.toContain("x again to STOP");

      viewer.handleInput("x");
      expect(onStop).not.toHaveBeenCalled();
    });

    it("does not offer or perform stop once the agent is no longer running", () => {
      const onStop = vi.fn();
      const viewer = new ConversationViewer(
        mockTui(30, W), mockSession(), mockRecord({ status: "completed" }), undefined, ansiTheme(), vi.fn(), onStop,
      );

      expect(viewer.render(W).join("\n")).not.toContain("x stop");
      viewer.handleInput("x");
      viewer.handleInput("x");
      expect(onStop).not.toHaveBeenCalled();
    });

    it("no stop affordance when no onStop handler is provided (read-only history)", () => {
      const viewer = new ConversationViewer(
        mockTui(30, W), mockSession(), mockRecord({ status: "running" }), undefined, ansiTheme(), vi.fn(),
      );
      expect(viewer.render(W).join("\n")).not.toContain("x stop");
      expect(() => { viewer.handleInput("x"); viewer.handleInput("x"); }).not.toThrow();
    });
  });

  describe("steer composer", () => {
    const W = 80;

    function makeViewer(opts: { status?: AgentRecord["status"]; onSteer?: (m: string) => void } = {}) {
      const onSteer = opts.onSteer ?? vi.fn();
      const tui = mockTui(30, W);
      const viewer = new ConversationViewer(
        tui, mockSession(), mockRecord({ status: opts.status ?? "running" }),
        undefined, ansiTheme(), vi.fn(), undefined, undefined, onSteer,
      );
      return { viewer, tui, onSteer };
    }

    it("offers the steer affordance for a running agent and opens on Enter", () => {
      const { viewer } = makeViewer();
      expect(viewer.render(W).join("\n")).toContain("Enter steer");

      viewer.handleInput("\r");
      const out = viewer.render(W).join("\n");
      expect(out).toContain("Enter send · Esc cancel");
      expect(out).not.toContain("Enter steer");
    });

    it("typing then Enter sends the trimmed message and closes the composer", () => {
      const { viewer, onSteer } = makeViewer();
      viewer.handleInput("\r");
      for (const ch of "  hello  ") viewer.handleInput(ch);
      viewer.handleInput("\r");

      expect(onSteer).toHaveBeenCalledWith("hello");
      expect(viewer.render(W).join("\n")).not.toContain("Enter send");
    });

    it("Esc cancels the composer without sending", () => {
      const { viewer, onSteer } = makeViewer();
      viewer.handleInput("\r");
      for (const ch of "draft") viewer.handleInput(ch);
      viewer.handleInput("\x1b");

      expect(onSteer).not.toHaveBeenCalled();
      expect(viewer.render(W).join("\n")).not.toContain("Enter send");
    });

    it("an empty submit just returns (like Esc), without calling onSteer", () => {
      const { viewer, onSteer } = makeViewer();
      viewer.handleInput("\r");
      viewer.handleInput("\r");
      expect(onSteer).not.toHaveBeenCalled();
      expect(viewer.render(W).join("\n")).not.toContain("Enter send");
    });

    it("scroll keys are inert while composing (input owns them)", () => {
      const { viewer } = makeViewer();
      viewer.handleInput("\r");
      viewer.handleInput("j");
      expect(viewer.render(W).join("\n")).toContain("Enter send · Esc cancel");
    });

    it("no steer affordance once the agent is no longer running", () => {
      const { viewer, onSteer } = makeViewer({ status: "completed" });
      expect(viewer.render(W).join("\n")).not.toContain("Enter steer");
      viewer.handleInput("\r");
      expect(viewer.render(W).join("\n")).not.toContain("Enter send");
      expect(onSteer).not.toHaveBeenCalled();
    });

    it("no steer affordance when no onSteer handler is provided", () => {
      const viewer = new ConversationViewer(
        mockTui(30, W), mockSession(), mockRecord({ status: "running" }), undefined, ansiTheme(), vi.fn(),
      );
      expect(viewer.render(W).join("\n")).not.toContain("Enter steer");
      expect(() => viewer.handleInput("\r")).not.toThrow();
    });

    it("composer rows never exceed width", () => {
      for (const w of [40, 80, 120]) {
        const tui = mockTui(30, w);
        const viewer = new ConversationViewer(
          tui, mockSession(), mockRecord({ status: "running" }),
          undefined, ansiTheme(), vi.fn(), undefined, undefined, vi.fn(),
        );
        viewer.handleInput("\r");
        for (const ch of "x".repeat(200)) viewer.handleInput(ch);
        assertAllLinesFit(viewer.render(w), w);
      }
    });
  });
});

describe("ConversationViewer transcript", () => {
  function viewerFor(messages: any[], opts: { rows?: number; messageRenderer?: unknown } = {}) {
    return new ConversationViewer(
      mockTui(opts.rows ?? 200, 80), mockSession(messages, opts.messageRenderer), mockRecord({ status: "completed" }),
      undefined, ansiTheme(), vi.fn(),
    );
  }

  const bodyOf = (viewer: ConversationViewer) => strip(viewer.render(80).join("\n"));

  it("renders a user message", () => {
    expect(bodyOf(viewerFor([userMessage("hello there")]))).toContain("hello there");
  });

  it("renders skill blocks as a skill invocation followed by the user text", () => {
    const block = '<skill name="lint" location="/skills/lint/SKILL.md">\nRun the linter.\n</skill>\n\nplease go';
    const out = bodyOf(viewerFor([userMessage(block)]));

    expect(out).toContain("[skill] lint");
    expect(out).toContain("please go");
    expect(out).not.toContain("<skill");
  });

  it("skips a user message with no text", () => {
    const empty = viewerFor([userMessage("   ")]);
    expect(bodyOf(empty)).toContain("(waiting for first message...)");
  });

  it("renders assistant text as Markdown", () => {
    const out = bodyOf(viewerFor([assistantMessage(text("some **bold** words"))]));

    expect(out).toContain("some bold words");
    expect(out).not.toContain("**bold**");
  });

  it("renders a tool call with its result", () => {
    const messages = [
      assistantMessage(toolCall("t1", "bash", { command: "cat a.ts" })),
      toolResult("t1", "bash", "file body"),
    ];
    const out = bodyOf(viewerFor(messages));

    expect(out).toContain("cat a.ts");
    expect(out).toContain("file body");
  });

  it("renders a tool call that has no result yet", () => {
    const out = bodyOf(viewerFor([assistantMessage(toolCall("t1", "grep", { pattern: "needle" }))]));

    expect(out).toContain("grep");
  });

  it("shows a tool call of an aborted turn as an error", () => {
    const aborted = { ...assistantMessage(toolCall("t1", "bash", { command: "sleep 9" })), stopReason: "aborted" };

    expect(bodyOf(viewerFor([aborted]))).toContain("Operation aborted");
  });

  it("does not render a tool result on its own", () => {
    expect(bodyOf(viewerFor([toolResult("t1", "read", "orphan body")]))).not.toContain("orphan body");
  });

  it("renders a bash execution with its command and output", () => {
    const out = bodyOf(viewerFor([{
      role: "bashExecution", command: "ls", output: "alpha\nbeta", exitCode: 0, cancelled: false,
      truncated: false, timestamp: 0,
    }]));

    expect(out).toContain("$ ls");
    expect(out).toContain("alpha");
    expect(out).toContain("beta");
  });

  it("renders a displayed custom message with the extension renderer", () => {
    const renderer = (message: { content: string }) => ({
      render: () => [`custom:${message.content}`],
      invalidate: () => {},
    });
    const messages = [{ role: "custom", customType: "note", content: "payload", display: true, timestamp: 0 }];

    expect(bodyOf(viewerFor(messages, { messageRenderer: renderer }))).toContain("custom:payload");
  });

  it("skips a custom message that is not displayed", () => {
    const messages = [{ role: "custom", customType: "note", content: "hidden payload", display: false, timestamp: 0 }];

    expect(bodyOf(viewerFor(messages))).not.toContain("hidden payload");
  });

  it("renders a compaction summary", () => {
    const messages = [{ role: "compactionSummary", summary: "older work", tokensBefore: 42000, timestamp: 0 }];

    expect(bodyOf(viewerFor(messages))).toContain("[compaction]");
  });

  it("renders a branch summary", () => {
    const messages = [{ role: "branchSummary", summary: "side path", fromId: "x", timestamp: 0 }];

    expect(bodyOf(viewerFor(messages))).toContain("[branch]");
  });

  it("skips a message kind pi does not render", () => {
    const out = bodyOf(viewerFor([{ role: "mystery", content: "ignored" }]));

    expect(out).not.toContain("ignored");
    expect(out).toContain("(waiting for first message...)");
  });

  it("shows the waiting placeholder for an empty transcript", () => {
    expect(bodyOf(viewerFor([]))).toContain("(waiting for first message...)");
  });

  it("appends the streaming line for a running agent with activity", () => {
    const viewer = new ConversationViewer(
      mockTui(60, 60), mockSession([userMessage("go")]), mockRecord({ status: "running" }),
      { activeTools: new Map(), toolUses: 0, tokens: "", responseText: "", session: undefined } as any,
      ansiTheme(), vi.fn(),
    );
    expect(viewer.render(60).some(l => l.includes("▍ "))).toBe(true);
  });

  it("re-renders a message whose text is still streaming", () => {
    const messages = [assistantMessage(text("first draft"))];
    const viewer = viewerFor(messages);
    expect(bodyOf(viewer)).toContain("first draft");

    messages[0].content = [text("second draft")];
    viewer.invalidate();
    const out = bodyOf(viewer);

    expect(out).toContain("second draft");
    expect(out).not.toContain("first draft");
  });

  describe("expand", () => {
    const longResult = Array.from({ length: 40 }, (_, i) => `row ${i}`).join("\n");
    const messages = () => [
      assistantMessage(toolCall("t1", "bash", { command: "seq" })),
      toolResult("t1", "bash", longResult),
    ];

    it("folds a long tool result until app.tools.expand is pressed", () => {
      const viewer = viewerFor(messages());

      expect(bodyOf(viewer)).toContain("row 39");
      expect(bodyOf(viewer)).not.toContain("row 0");

      viewer.handleInput(CTRL_O);
      expect(bodyOf(viewer)).toContain("row 0");
    });

    it("folds again on a second press", () => {
      const viewer = viewerFor(messages());

      viewer.handleInput(CTRL_O);
      viewer.handleInput(CTRL_O);

      expect(bodyOf(viewer)).not.toContain("row 0");
    });

    it("expands a message that arrives after the key press", () => {
      const live = [assistantMessage(toolCall("t1", "bash", { command: "seq" }))];
      const viewer = viewerFor(live);
      viewer.handleInput(CTRL_O);
      live.push(toolResult("t1", "bash", longResult) as never);

      expect(bodyOf(viewer)).toContain("row 0");
    });

    it("expands the output of a bash execution", () => {
      const output = Array.from({ length: 60 }, (_, i) => `out ${i}`).join("\n");
      const viewer = viewerFor([{
        role: "bashExecution", command: "seq", output, exitCode: 0, cancelled: false, truncated: false, timestamp: 0,
      }]);

      expect(bodyOf(viewer)).not.toContain("out 0");
      viewer.handleInput(CTRL_O);
      expect(bodyOf(viewer)).toContain("out 0");
    });

    it("requests a render", () => {
      const tui = mockTui(200, 80);
      const viewer = new ConversationViewer(
        tui, mockSession(messages()), mockRecord({ status: "completed" }), undefined, ansiTheme(), vi.fn(),
      );
      viewer.handleInput(CTRL_O);

      expect(tui.requestRender).toHaveBeenCalled();
    });
  });
});

describe("ConversationViewer follow", () => {
  const tagTheme = { fg: (_c: string, t: string) => t, bold: (t: string) => t } as any;
  const UP = "\x1b[A";
  const DOWN = "\x1b[B";
  const PAGE_UP = "\x1b[5~";
  const PAGE_DOWN = "\x1b[6~";
  const HOME = "\x1b[H";
  const END = "\x1b[F";

  function viewerWith(lineCount: number) {
    const body = Array.from({ length: lineCount }, (_, i) => `line ${i}`).join("\n");
    const session = mockSession([assistantMessage(text(body))]);
    const viewer = new ConversationViewer(mockTui(20, 120), session, mockRecord({ status: "running" }), undefined, tagTheme, vi.fn());
    viewer.render(120);
    return viewer;
  }

  const footerOf = (viewer: ConversationViewer) => viewer.render(120).at(-2) ?? "";
  const following = (viewer: ConversationViewer): boolean => (viewer as any).autoScroll;

  it("follows when the viewer opens", () => {
    expect(following(viewerWith(60))).toBe(true);
  });

  it("keeps follow on when PgUp is pressed and the view still shows the latest line", () => {
    const viewer = viewerWith(10);
    viewer.handleInput(PAGE_UP);
    expect(following(viewer)).toBe(true);
  });

  it("keeps follow on when Home is pressed and the view still shows the latest line", () => {
    const viewer = viewerWith(10);
    viewer.handleInput(HOME);
    expect(following(viewer)).toBe(true);
  });

  it("turns follow off when PgUp moves away from the latest line", () => {
    const viewer = viewerWith(60);
    viewer.handleInput(PAGE_UP);
    expect(following(viewer)).toBe(false);
  });

  it("turns follow off when Home moves away from the latest line", () => {
    const viewer = viewerWith(60);
    viewer.handleInput(HOME);
    expect(following(viewer)).toBe(false);
  });

  it("turns follow back on when a line scroll reaches the latest line", () => {
    const viewer = viewerWith(60);
    viewer.handleInput(UP);
    expect(following(viewer)).toBe(false);
    viewer.handleInput(DOWN);
    expect(following(viewer)).toBe(true);
  });

  it("turns follow back on when PgDn reaches the latest line", () => {
    const viewer = viewerWith(60);
    viewer.handleInput(PAGE_UP);
    viewer.handleInput(PAGE_DOWN);
    expect(following(viewer)).toBe(true);
  });

  it("turns follow on with End and shows the latest line", () => {
    const viewer = viewerWith(60);
    viewer.handleInput(HOME);
    viewer.handleInput(END);
    expect(following(viewer)).toBe(true);
    expect(viewer.render(120).join("\n")).toContain("line 59");
  });

  it("says follow is off and names End while follow is off", () => {
    const viewer = viewerWith(60);
    expect(footerOf(viewer)).not.toContain("follow off");
    viewer.handleInput(HOME);
    expect(footerOf(viewer)).toContain("follow off · End to follow");
  });

  it("drops the follow notice when follow turns back on", () => {
    const viewer = viewerWith(60);
    viewer.handleInput(HOME);
    viewer.handleInput(END);
    expect(footerOf(viewer)).not.toContain("follow off");
  });
});
