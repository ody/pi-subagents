import { describe, expect, it, vi } from "vitest";
import subagentsExtension from "../src/index.js";

function agentTool() {
  const tools = new Map<string, any>();
  const pi = {
    registerMessageRenderer: vi.fn(),
    registerTool: vi.fn((tool: any) => tools.set(tool.name, tool)),
    registerCommand: vi.fn(),
    registerEntryRenderer: vi.fn(),
    registerFlag: vi.fn(),
    getFlag: vi.fn(),
    on: vi.fn(),
    events: { emit: vi.fn(), on: vi.fn(() => vi.fn()) },
    appendEntry: vi.fn(),
    sendMessage: vi.fn(),
  } as any;
  subagentsExtension(pi);
  return tools.get("agent");
}

const theme = {
  fg: (_color: string, text: string) => text,
  bold: (text: string) => text,
} as any;

function render(tool: any, result: any): string {
  return tool.renderResult(
    { content: result.content, details: result.details },
    { expanded: false, isPartial: false },
    theme,
    { isError: result.isError },
  ).render(120).join("\n");
}

describe("agent tool invocation error rendering", () => {
  it("shows a Pi tool error instead of structured terminal status", () => {
    const output = render(agentTool(), {
      content: [{ type: "text", text: 'Cannot run with isolation: "worktree" — Git probe failed.' }],
      isError: true,
      details: { status: "aborted" },
    });

    expect(output).toContain('Cannot run with isolation: "worktree" — Git probe failed.');
    expect(output).not.toContain("Aborted (max turns exceeded)");
  });

  it.each([
    ["missing details", undefined],
    ["empty details", {}],
    ["unknown status", { status: "unknown" }],
    ["a status with no rendering of its own", { status: "queued" }],
  ])("shows the real result text for %s", (_name, details) => {
    const output = render(agentTool(), {
      content: [{ type: "text", text: "Unstructured Agent result." }],
      isError: false,
      details,
    });

    expect(output).toContain("Unstructured Agent result.");
    expect(output).not.toContain("Aborted (max turns exceeded)");
  });
});

function renderWith(result: any, opts: { expanded?: boolean; isPartial?: boolean } = {}): string {
  return agentTool()
    .renderResult(
      { content: result.content, details: result.details },
      { expanded: opts.expanded ?? false, isPartial: opts.isPartial ?? false },
      theme,
      { isError: false },
    )
    .render(200)
    .join("\n");
}

const base = { toolUses: 1, durationMs: 1000, tokens: "5k tokens", modelName: "haiku", tags: ["t1"], turnCount: 2 };
const body = (text: string) => [{ type: "text", text }];

describe("agent tool status rendering", () => {
  it("caps expanded completed output at 50 lines", () => {
    const text = Array.from({ length: 60 }, (_, i) => `line${i}`).join("\n");
    const output = renderWith({ content: body(text), details: { ...base, status: "completed" } }, { expanded: true });
    expect(output).toContain("  line49");
    expect(output).not.toContain("line50");
    expect(output).toContain("... (use get_subagent_result with verbose for full output)");
    expect(output).toContain("✓ haiku · t1");
    expect(output).toContain("1 tool use ·");
    expect(output).toContain("5k tokens");
  });

  it("shows no truncation note at exactly 50 lines", () => {
    const text = Array.from({ length: 50 }, (_, i) => `line${i}`).join("\n");
    const output = renderWith({ content: body(text), details: { ...base, status: "completed" } }, { expanded: true });
    expect(output).toContain("line49");
    expect(output).not.toContain("get_subagent_result");
  });

  it("renders only the header when expanded with empty text", () => {
    const output = renderWith({ content: body(""), details: { ...base, status: "completed" } }, { expanded: true });
    expect(output).toContain("✓");
    expect(output).not.toContain("⎿");
  });

  it("collapsed completed shows Done", () => {
    const output = renderWith({ content: body("x"), details: { ...base, status: "completed" } });
    expect(output).toContain("⎿  Done");
  });

  it("steered shows Wrapped up", () => {
    const output = renderWith({ content: body("x"), details: { ...base, status: "steered" } });
    expect(output).toContain("⎿  Wrapped up (turn limit)");
  });

  it("stopped shows Stopped", () => {
    const output = renderWith({ content: body("x"), details: { ...base, status: "stopped" } });
    expect(output).toContain("■ haiku");
    expect(output).toContain("⎿  Stopped");
  });

  it("error shows the message, or unknown", () => {
    const withMsg = renderWith({ content: body("x"), details: { ...base, status: "error", error: "boom" } });
    expect(withMsg).toContain("✗ haiku");
    expect(withMsg).toContain("⎿  Error: boom");
    expect(renderWith({ content: body("x"), details: { ...base, status: "error" } })).toContain("Error: unknown");
  });

  it("aborted shows max turns exceeded", () => {
    const output = renderWith({ content: body("x"), details: { ...base, status: "aborted" } });
    expect(output).toContain("⎿  Aborted (max turns exceeded)");
  });

  it("background shows the agent id", () => {
    const output = renderWith({ content: body("x"), details: { status: "background", agentId: "abc123" } });
    expect(output).toContain("Running in background (ID: abc123)");
  });

  it("running shows the activity", () => {
    const output = renderWith(
      { content: body("x"), details: { ...base, status: "running", activity: "reading" } },
      { isPartial: true },
    );
    expect(output).toContain("⎿  reading");
  });
});
