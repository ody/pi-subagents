import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentRecord } from "../src/types.js";

let wrapOverride: ((text: string, width: number) => string[]) | null = null;
let markdownConstructions = 0;
let markdownRenderCalls = 0;
let markdownThrows = false;

vi.mock("@earendil-works/pi-tui", async (importOriginal) => {
  const original = await importOriginal<typeof import("@earendil-works/pi-tui")>();
  return {
    ...original,
    Markdown: class extends original.Markdown {
      constructor(...args: ConstructorParameters<typeof original.Markdown>) {
        markdownConstructions++;
        super(...args);
      }
      render(width: number): string[] {
        markdownRenderCalls++;
        if (markdownThrows) throw new RangeError("Maximum call stack size exceeded");
        return super.render(width);
      }
    },
    wrapTextWithAnsi: (...args: [string, number]) => {
      if (wrapOverride) return wrapOverride(...args);
      return original.wrapTextWithAnsi(...args);
    },
  };
});

const { visibleWidth } = await import("@earendil-works/pi-tui");
const { ConversationViewer, RESULT_MAX_CHARS } = await import("../src/ui/conversation-viewer.js");

function mockTui(rows = 40, columns = 80) {
  return {
    terminal: { rows, columns },
    requestRender: vi.fn(),
  } as any;
}

function mockSession(messages: any[] = []) {
  return {
    messages,
    subscribe: vi.fn(() => vi.fn()),
    dispose: vi.fn(),
    getSessionStats: () => ({ tokens: { input: 0, output: 0, cacheWrite: 0 } }),
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

beforeEach(() => {
  wrapOverride = null;
  markdownConstructions = 0;
  markdownRenderCalls = 0;
  markdownThrows = false;
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
    ["completed", "<success>✓</success>"],
    ["error", "<error>✗</error>"],
    ["stopped", "<dim>○</dim>"],
  ])("shows the %s status icon in the header", (status, icon) => {
    const lines = render(mockRecord({ status: status as AgentRecord["status"] }));
    expect(lines[1]).toContain(`</border> ${icon} `);
  });

  it("reads 100% when all content fits the viewport", () => {
    const session = mockSession([{ role: "assistant", content: [{ type: "text", text: "hi" }] }]);
    const footer = render(mockRecord({ status: "completed" }), session).at(-2) ?? "";
    expect(footer).toMatch(/\d+ lines · 100%/);
  });

  it("reads a partial percentage when content overflows the viewport", () => {
    const text = Array.from({ length: 60 }, (_, i) => `line ${i}`).join("\n");
    const session = mockSession([{ role: "assistant", content: [{ type: "text", text }] }]);
    const viewer = new ConversationViewer(mockTui(20, 120), session, mockRecord({ status: "completed" }), undefined, tagTheme, vi.fn());
    viewer.handleInput("\x1b[H");
    const footer = viewer.render(120).at(-2) ?? "";
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
    const widths = [40, 80, 120, 216];

    it("no line exceeds width with empty messages", () => {
      for (const w of widths) {
        const viewer = new ConversationViewer(
          mockTui(30, w), mockSession([]), mockRecord(), undefined, ansiTheme(), vi.fn(),
        );
        assertAllLinesFit(viewer.render(w), w);
      }
    });

    it("no line exceeds width with plain text messages", () => {
      const messages = [
        { role: "user", content: "Hello, how are you?" },
        { role: "assistant", content: [{ type: "text", text: "I am fine, thank you for asking." }] },
      ];
      for (const w of widths) {
        const viewer = new ConversationViewer(
          mockTui(30, w), mockSession(messages), mockRecord(), undefined, ansiTheme(), vi.fn(),
        );
        assertAllLinesFit(viewer.render(w), w);
      }
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

    it("no line exceeds width when text is longer than viewport", () => {
      const longLine = "A".repeat(500);
      const messages = [
        { role: "user", content: longLine },
        { role: "assistant", content: [{ type: "text", text: longLine }] },
        { role: "toolResult", toolUseId: "t1", content: [{ type: "text", text: longLine }] },
      ];
      for (const w of widths) {
        const viewer = new ConversationViewer(
          mockTui(30, w), mockSession(messages), mockRecord(), undefined, ansiTheme(), vi.fn(),
        );
        assertAllLinesFit(viewer.render(w), w);
      }
    });

    it("no line exceeds width with embedded ANSI escape codes in content", () => {
      const ansiText = `\x1b[1mBold heading\x1b[22m and \x1b[31mred text\x1b[0m ${"X".repeat(300)}`;
      const messages = [
        { role: "toolResult", toolUseId: "t1", content: [{ type: "text", text: ansiText }] },
      ];
      for (const w of widths) {
        const viewer = new ConversationViewer(
          mockTui(30, w), mockSession(messages), mockRecord(), undefined, ansiTheme(), vi.fn(),
        );
        assertAllLinesFit(viewer.render(w), w);
      }
    });

    it("no line exceeds width with long URLs", () => {
      const url = "https://example.com/" + "a/b/c/d/e/".repeat(30) + "?q=" + "x".repeat(100);
      const messages = [
        { role: "assistant", content: [{ type: "text", text: `Check this link: ${url}` }] },
      ];
      for (const w of widths) {
        const viewer = new ConversationViewer(
          mockTui(30, w), mockSession(messages), mockRecord(), undefined, ansiTheme(), vi.fn(),
        );
        assertAllLinesFit(viewer.render(w), w);
      }
    });

    it("no line exceeds width with wide table-like content", () => {
      const header = "| " + Array.from({ length: 20 }, (_, i) => `Column${i}`).join(" | ") + " |";
      const dataRow = "| " + Array.from({ length: 20 }, () => "value123").join(" | ") + " |";
      const table = [header, dataRow, dataRow, dataRow].join("\n");
      const messages = [
        { role: "toolResult", toolUseId: "t1", content: [{ type: "text", text: table }] },
      ];
      for (const w of widths) {
        const viewer = new ConversationViewer(
          mockTui(30, w), mockSession(messages), mockRecord(), undefined, ansiTheme(), vi.fn(),
        );
        assertAllLinesFit(viewer.render(w), w);
      }
    });

    it("no line exceeds width with bashExecution messages", () => {
      const messages = [
        {
          role: "bashExecution", command: "cat " + "/very/long/path/".repeat(20) + "file.txt",
          output: "O".repeat(600),
          exitCode: 0, cancelled: false, truncated: false, timestamp: Date.now(),
        },
      ];
      for (const w of widths) {
        const viewer = new ConversationViewer(
          mockTui(30, w), mockSession(messages), mockRecord(), undefined, ansiTheme(), vi.fn(),
        );
        assertAllLinesFit(viewer.render(w), w);
      }
    });

    it("no line exceeds width with running activity indicator", () => {
      const activity = {
        activeTools: new Map([["read", "file.ts"], ["grep", "pattern"]]),
        toolUses: 5, tokens: "10k", responseText: "R".repeat(400),
        session: { getSessionStats: () => ({ tokens: { total: 50000 } }) },
      };
      const messages = [
        { role: "user", content: "do the thing" },
        { role: "assistant", content: [{ type: "text", text: "working on it" }] },
      ];
      for (const w of widths) {
        const viewer = new ConversationViewer(
          mockTui(30, w), mockSession(messages), mockRecord({ status: "running" }), activity as any, ansiTheme(), vi.fn(),
        );
        assertAllLinesFit(viewer.render(w), w);
      }
    });

    it("no line exceeds width with tool calls", () => {
      const messages = [
        {
          role: "assistant",
          content: [
            { type: "text", text: "Let me check that." },
            { type: "toolCall", toolUseId: "t1", name: "very_long_tool_name_" + "x".repeat(200), input: {} },
          ],
        },
      ];
      for (const w of widths) {
        const viewer = new ConversationViewer(
          mockTui(30, w), mockSession(messages), mockRecord(), undefined, ansiTheme(), vi.fn(),
        );
        assertAllLinesFit(viewer.render(w), w);
      }
    });

    it("no line exceeds width at narrow terminal", () => {
      const messages = [
        { role: "user", content: "Hello world, this is a normal sentence." },
        { role: "assistant", content: [{ type: "text", text: "Sure, here's the answer." }] },
      ];
      for (const w of [8, 10, 15, 20]) {
        const viewer = new ConversationViewer(
          mockTui(30, w), mockSession(messages), mockRecord(), undefined, ansiTheme(), vi.fn(),
        );
        assertAllLinesFit(viewer.render(w), w);
      }
    });

    it("no line exceeds width with mixed ANSI + unicode content", () => {
      const text = `\x1b[32m✓\x1b[0m Test passed — 日本語テスト ${"あ".repeat(50)} \x1b[33m⚠\x1b[0m`;
      const messages = [
        { role: "toolResult", toolUseId: "t1", content: [{ type: "text", text }] },
      ];
      for (const w of widths) {
        const viewer = new ConversationViewer(
          mockTui(30, w), mockSession(messages), mockRecord(), undefined, ansiTheme(), vi.fn(),
        );
        assertAllLinesFit(viewer.render(w), w);
      }
    });
  });

  describe("Markdown rendering", () => {
    const strip = (text: string) => text.replace(/\x1b\[[0-9;]*m/g, "");

    function viewerFor(
      messages: any[],
      mode?: "off" | "assistant" | "all",
      onMode?: (m: any) => void,
      rows = 200,
    ) {
      return new ConversationViewer(
        mockTui(rows, 80), mockSession(messages), mockRecord({ status: "completed" }), undefined,
        ansiTheme(), vi.fn(), undefined, undefined, undefined, false,
        mode ? () => mode : undefined, onMode,
      );
    }

    const assistant = (text: string) => [{ role: "assistant", content: [{ type: "text", text }] }];
    const result = (text: string) => [{ role: "toolResult", toolUseId: "t1", content: [{ type: "text", text }] }];

    it("renders assistant Markdown by default instead of raw source markers", () => {
      const out = strip(viewerFor(assistant("# Heading\n\n- first\n- second\n\n**bold**")).render(80).join("\n"));

      expect(out).toContain("Heading");
      expect(out).not.toContain("# Heading");
      expect(out).not.toContain("**bold**");
      expect(out).toContain("bold");
    });

    it("leaves assistant text verbatim under `off`", () => {
      const out = strip(viewerFor(assistant("# Heading\n\n**bold**"), "off").render(80).join("\n"));

      expect(out).toContain("# Heading");
      expect(out).toContain("**bold**");
    });

    it("leaves tool results byte-exact under the default mode", () => {
      const raw = [
        "#!/bin/sh",
        "# section",
        "3) alpha",
        "7) beta",
        "9) gamma",
        "Section",
        "---",
        "next",
      ].join("\n");
      const out = strip(viewerFor(result(raw)).render(80).join("\n"));

      for (const line of raw.split("\n")) expect(out).toContain(line);
    });

    it("renders tool-result Markdown under `all`", () => {
      const out = strip(viewerFor(result("## ctx_execute\n\n- one\n- two"), "all").render(80).join("\n"));

      expect(out).toContain("ctx_execute");
      expect(out).not.toContain("## ctx_execute");
    });

    it("does not renumber ordered lists even when it does render them", () => {
      const out = strip(viewerFor(result("3) alpha\n7) beta\n9) gamma"), "all").render(80).join("\n"));

      expect(out).toContain("3) alpha");
      expect(out).not.toContain("4. beta");
    });

    it("`m` cycles the mode, persists it, and shows it in the footer", () => {
      const onMode = vi.fn();
      const viewer = viewerFor(assistant("# Heading"), "assistant", onMode);

      expect(strip(viewer.render(80).join("\n"))).toContain("m md");

      viewer.handleInput("m");
      expect(onMode).toHaveBeenLastCalledWith("all");
      expect(strip(viewer.render(80).join("\n"))).toContain("m md+");

      viewer.handleInput("m");
      expect(onMode).toHaveBeenLastCalledWith("off");
      const off = strip(viewer.render(80).join("\n"));
      expect(off).toContain("m raw");
      expect(off).toContain("# Heading");

      viewer.handleInput("m");
      expect(onMode).toHaveBeenLastCalledWith("assistant");
    });

    it("`m` still cycles when no persist hook is wired", () => {
      const viewer = viewerFor(assistant("# Heading"), "assistant");
      viewer.handleInput("m");
      viewer.handleInput("m");

      expect(strip(viewer.render(80).join("\n"))).toContain("# Heading");
    });

    it("`m` disarms a pending stop rather than confirming it", () => {
      const onStop = vi.fn();
      const viewer = new ConversationViewer(
        mockTui(200, 80), mockSession(assistant("hi")), mockRecord({ status: "running" }), undefined,
        ansiTheme(), vi.fn(), onStop,
      );

      viewer.handleInput("x");
      viewer.handleInput("m");
      viewer.handleInput("x");

      expect(onStop).not.toHaveBeenCalled();
    });

    it("keeps the footer's navigation hints intact at 80 columns", () => {
      const viewer = new ConversationViewer(
        mockTui(200, 80), mockSession(assistant("hi")), mockRecord({ status: "running" }), undefined,
        ansiTheme(), vi.fn(), vi.fn(), undefined, vi.fn(),
      );
      const lines = viewer.render(80);
      const footer = strip(lines[lines.length - 2]);

      expect(footer).toContain("Enter steer");
      expect(footer).toContain("x stop");
      expect(footer).toContain("m md");
      expect(footer).toContain("Esc close");
    });

    it("caps a tool result at RESULT_MAX_CHARS, not 500, and says what it dropped", () => {
      const lines = Array.from({ length: 3000 }, (_, i) => `line ${i}`);
      const out = strip(viewerFor(result(lines.join("\n")), undefined, undefined, 4000).render(80).join("\n"));

      expect(out).toContain("line 100");
      expect(out).not.toContain("line 2999");
      expect(out).toMatch(/\.\.\. \(truncated, [\d.]+[kM]? more characters\)/);
    });

    it("puts the truncation notice outside the code fence it cut into", () => {
      const text = `\`\`\`js\n${"const a = 1;\n".repeat(2000)}\`\`\``;
      const viewer = viewerFor(result(text), "all", undefined, 4000);
      const content = ((viewer as any).buildContentLines(76) as string[]).map(strip);
      const note = content.find(l => l.includes("... (truncated"));

      expect(note).toMatch(/^\.\.\. \(truncated, [\d.]+[kM]? more characters\)$/);
    });

    it("reports the exact omitted character count", () => {
      const text = `${"x".repeat(RESULT_MAX_CHARS)}😀x`;
      const viewer = viewerFor(result(text));
      const content = ((viewer as any).buildContentLines(76) as string[]).map(strip);

      expect(content).toContain("... (truncated, 3 more characters)");
    });

    it("abbreviates a large omitted count so the notice fits a narrow frame", () => {
      const text = `${"x".repeat(RESULT_MAX_CHARS)}${"y".repeat(1_100_000)}`;
      const note = viewerFor(result(text)).render(50).map(strip).find(l => l.includes("truncated,"));

      expect(note).toContain("1.1M more characters)");
    });

    it("rounds into the M bracket rather than reporting 1000k", () => {
      const text = `${"x".repeat(RESULT_MAX_CHARS)}${"y".repeat(999_999)}`;
      const note = strip(viewerFor(result(text)).render(80).join("\n")).split("\n").find(l => l.includes("truncated,"));

      expect(note).toContain("1M more characters");
    });

    it("falls back to literal wrapping once for an unsafe streaming prefix", () => {
      const messages = result("# heading");
      const viewer = viewerFor(messages, "all");
      markdownThrows = true;

      expect(() => viewer.render(80)).not.toThrow();
      expect(strip(viewer.render(80).join("\n"))).toContain("# heading");

      messages[0].content[0].text += "\nmore";
      expect(strip(viewer.render(80).join("\n"))).toContain("more");
      expect(markdownRenderCalls).toBe(1);

      markdownThrows = false;
      expect(strip(viewer.render(80).join("\n"))).toContain("# heading");
      expect(markdownRenderCalls).toBe(1);

      messages[0].content[0].text = "## safe";
      const replaced = strip(viewer.render(80).join("\n"));
      expect(markdownRenderCalls).toBe(2);
      expect(replaced).toContain("safe");
      expect(replaced).not.toContain("## safe");
    });

    it("tracks a tool result that keeps growing past the cap", () => {
      const msg = { role: "toolResult", toolUseId: "t", content: [{ type: "text", text: `${"row\n".repeat(4500)}` }] };
      const viewer = viewerFor([msg]);
      const elided = () => {
        const m = strip(((viewer as any).buildContentLines(76) as string[]).join("\n"))
          .match(/truncated, ([\d.]+)([kM]?) more/);
        return Number(m?.[1]) * (m?.[2] === "M" ? 1e6 : m?.[2] === "k" ? 1e3 : 1);
      };

      const before = elided();
      msg.content[0].text += "row\n".repeat(1000);
      const after = elided();

      expect(before).toBeGreaterThan(0);
      expect(after).toBeGreaterThan(before);
      expect(markdownConstructions).toBe(0);
    });

    it("leaves a result under the cap untouched", () => {
      const text = `head\n${"filler line\n".repeat(200)}tail`;
      const out = strip(viewerFor(result(text), undefined, undefined, 600).render(80).join("\n"));

      expect(text.length).toBeLessThan(RESULT_MAX_CHARS);
      expect(out).toContain("head");
      expect(out).toContain("tail");
      expect(out).not.toContain("truncated");
    });

    it("caps bash output with the same rule as a tool result", () => {
      const messages = [{ role: "bashExecution", command: "yes", output: "y\n".repeat(20000) }];
      const out = strip(viewerFor(messages).render(80).join("\n"));

      expect(out).toMatch(/\.\.\. \(truncated, [\d.]+[kM]? more characters\)/);
    });

    it("keeps tool results dim even when rendering them as Markdown", () => {
      const viewer = viewerFor(result("plain result text"), "all");
      const line = (viewer as any).buildContentLines(76)
        .find((l: string) => strip(l).includes("plain result text"));

      expect(line).toContain("\x1b[38;5;240m");
    });

    it("keeps tool results dim on the literal path too", () => {
      const viewer = viewerFor(result("plain result text"));
      const line = (viewer as any).buildContentLines(76)
        .find((l: string) => strip(l).includes("plain result text"));

      expect(line).toContain("\x1b[38;5;240m");
    });

    it("reuses one Markdown per message across renders", () => {
      const viewer = viewerFor(assistant("# Heading"));
      viewer.render(80);
      const afterFirst = markdownConstructions;
      viewer.render(80);
      viewer.render(80);

      expect(afterFirst).toBe(1);
      expect(markdownConstructions).toBe(afterFirst);
    });

    it("re-renders a message whose text is still streaming", () => {
      const messages = assistant("# One");
      const viewer = viewerFor(messages);
      expect(strip(viewer.render(80).join("\n"))).toContain("One");

      messages[0].content[0].text = "# Two";
      const out = strip(viewer.render(80).join("\n"));

      expect(out).toContain("Two");
      expect(out).not.toContain("One");
      expect(markdownConstructions).toBe(1);
    });

    it("renders Markdown to fit, so the overwidth clamp never has to cut it", () => {
      const text = `# ${"Heading ".repeat(20)}\n\n| a | b |\n|---|---|\n| ${"x".repeat(90)} | 2 |\n\n\`\`\`js\nconst x = ${"1".repeat(120)};\n\`\`\``;
      for (const w of [20, 40, 80, 120]) {
        const viewer = new ConversationViewer(
          mockTui(30, w), mockSession(assistant(text)), mockRecord(), undefined, ansiTheme(), vi.fn(),
        );
        const content = (viewer as any).buildContentLines(w) as string[];

        assertAllLinesFit(content, w);
        expect(content.filter(l => strip(l).endsWith("..."))).toEqual([]);
      }
    });
  });

  describe("safety net against upstream wrapTextWithAnsi bugs", () => {
    function callBuildContentLines(viewer: InstanceType<typeof ConversationViewer>, width: number): string[] {
      return (viewer as any).buildContentLines(width);
    }

    it("mock is intercepting wrapTextWithAnsi", async () => {
      const { wrapTextWithAnsi } = await import("@earendil-works/pi-tui");
      wrapOverride = () => ["MOCK_SENTINEL"];
      expect(wrapTextWithAnsi("anything", 10)).toEqual(["MOCK_SENTINEL"]);
      wrapOverride = null;
    });

    it("clamps overwidth lines from toolResult content", () => {
      const w = 80;
      wrapOverride = () => ["X".repeat(w + 50)];

      const messages = [
        { role: "toolResult", toolUseId: "t1", content: [{ type: "text", text: "output" }] },
      ];
      const viewer = new ConversationViewer(
        mockTui(30, w), mockSession(messages), mockRecord(), undefined, ansiTheme(), vi.fn(),
      );
      assertAllLinesFit(callBuildContentLines(viewer, w), w);
    });

    it("clamps overwidth lines from user message content", () => {
      const w = 80;
      wrapOverride = () => ["Y".repeat(w + 100)];

      const messages = [{ role: "user", content: "hello" }];
      const viewer = new ConversationViewer(
        mockTui(30, w), mockSession(messages), mockRecord(), undefined, ansiTheme(), vi.fn(),
      );
      assertAllLinesFit(callBuildContentLines(viewer, w), w);
    });

    it("clamps overwidth lines from assistant message content", () => {
      const w = 80;
      wrapOverride = () => ["Z".repeat(w + 100)];

      const messages = [
        { role: "assistant", content: [{ type: "text", text: "response" }] },
      ];
      const viewer = new ConversationViewer(
        mockTui(30, w), mockSession(messages), mockRecord(), undefined, ansiTheme(), vi.fn(),
      );
      assertAllLinesFit(callBuildContentLines(viewer, w), w);
    });

    it("clamps overwidth lines from bashExecution output", () => {
      const w = 80;
      wrapOverride = () => ["B".repeat(w + 100)];

      const messages = [
        {
          role: "bashExecution", command: "ls", output: "out",
          exitCode: 0, cancelled: false, truncated: false, timestamp: Date.now(),
        },
      ];
      const viewer = new ConversationViewer(
        mockTui(30, w), mockSession(messages), mockRecord(), undefined, ansiTheme(), vi.fn(),
      );
      assertAllLinesFit(callBuildContentLines(viewer, w), w);
    });

    it("clamps overwidth lines that also contain ANSI codes", () => {
      const w = 80;
      wrapOverride = () => [`\x1b[1m\x1b[31m${"W".repeat(w + 30)}\x1b[0m`];

      const messages = [
        { role: "toolResult", toolUseId: "t1", content: [{ type: "text", text: "output" }] },
      ];
      const viewer = new ConversationViewer(
        mockTui(30, w), mockSession(messages), mockRecord(), undefined, ansiTheme(), vi.fn(),
      );
      assertAllLinesFit(callBuildContentLines(viewer, w), w);
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

describe("ConversationViewer transcript lines", () => {
  const plain = { fg: (_c: string, t: string) => t, bold: (t: string) => t } as any;

  function body(messages: any[]): string[] {
    const viewer = new ConversationViewer(
      mockTui(60, 60), mockSession(messages), mockRecord({ status: "completed" }), undefined, plain, vi.fn(),
      undefined, undefined, undefined, false, () => "off",
    );
    return viewer.render(60).map(l => l.replace(/\x1b\[[0-9;]*m/g, "").trim());
  }

  it("renders each role with separators, labels and skip rules", () => {
    const lines = body([
      { role: "user", content: "hello there" },
      { role: "user", content: "   " },
      { role: "assistant", content: [{ type: "text", text: "thinking" }, { type: "toolCall", name: "read" }] },
      { role: "toolResult", content: [{ type: "text", text: "  " }] },
      { role: "toolResult", content: [{ type: "text", text: "file body" }] },
      { role: "bashExecution", command: "ls", output: "a\nb" },
      { role: "bashExecution", command: "true", output: "  " },
      { role: "mystery", content: "ignored" },
      { role: "assistant", content: [] },
    ]);
    const start = lines.findIndex(l => l.includes("[User]"));
    const end = lines.findLastIndex(l => l.includes("[Assistant]"));
    expect(lines.slice(start, end + 1)).toMatchInlineSnapshot(`
      [
        "│ [User]                                                   │",
        "│ hello there                                              │",
        "│ ───                                                      │",
        "│ [Assistant]                                              │",
        "│ thinking                                                 │",
        "│   [Tool: read]                                           │",
        "│ ───                                                      │",
        "│ [Result]                                                 │",
        "│ file body                                                │",
        "│ ───                                                      │",
        "│   $ ls                                                   │",
        "│ a                                                        │",
        "│ b                                                        │",
        "│ ───                                                      │",
        "│   $ true                                                 │",
        "│ ───                                                      │",
        "│ [Assistant]                                              │",
      ]
    `);
  });

  it("shows the waiting placeholder for an empty transcript", () => {
    expect(body([]).some(l => l.includes("(waiting for first message...)"))).toBe(true);
  });

  it("appends the streaming line for a running agent with activity", () => {
    const viewer = new ConversationViewer(
      mockTui(60, 60), mockSession([{ role: "user", content: "go" }]), mockRecord({ status: "running" }),
      { activeTools: new Map(), toolUses: 0, tokens: "", responseText: "", session: undefined } as any,
      plain, vi.fn(),
    );
    expect(viewer.render(60).some(l => l.includes("▍ "))).toBe(true);
  });
});
