import { describe, expect, it } from "vitest";
import type { NotificationDetails } from "../src/types.js";
import { formatCost, formatTokens } from "../src/ui/agent-format.js";
import { registerNotificationRenderer } from "../src/ui/notification-renderer.js";

const theme = {
  fg: (c: string, s: string) => `<${c}:${s}>`,
  bold: (s: string) => `*${s}*`,
};

function det(over: Partial<NotificationDetails> = {}): NotificationDetails {
  return {
    id: "a1", description: "audit", status: "completed", toolUses: 0, turnCount: 0,
    totalTokens: 0, durationMs: 0, resultPreview: "done", ...over,
  };
}

function setup(settings = { showCost: true }) {
  let renderer: any;
  const pi = { registerMessageRenderer: (_t: string, fn: unknown) => { renderer = fn; } };
  registerNotificationRenderer(pi as any, { settings });
  return {
    settings,
    render: (details: NotificationDetails | undefined, expanded = false): string | undefined => {
      const out = renderer({ details }, { expanded }, theme);
      return out?.render(200)?.join("\n").replace(/ +$/gm, "");
    },
  };
}

describe("notification renderer", () => {
  it("returns undefined without details", () => {
    expect(setup().render(undefined)).toBeUndefined();
  });

  it.each([
    ["completed", "success", "✓", "completed"],
    ["steered", "success", "✓", "completed (steered)"],
    ["error", "error", "✗", "error"],
    ["stopped", "error", "✗", "stopped"],
    ["aborted", "error", "✗", "aborted"],
  ])("status %s", (status, color, icon, text) => {
    expect(setup().render(det({ status }))).toBe(
      `<${color}:${icon}> *audit* <dim:${text}>\n  <dim:⎿  done>`,
    );
  });

  it("renders every stat, dot-separated", () => {
    const out = setup().render(det({
      turnCount: 3, maxTurns: 5, toolUses: 1, totalTokens: 1500, totalCost: 0.05, durationMs: 2000,
    }));
    const stats = ["↻3≤5", "1 tool use", formatTokens(1500), formatCost(0.05), "2.0s"];
    expect(out!.split("\n")[1]).toBe(`  ${stats.map((p) => `<dim:${p}>`).join(" <dim:·> ")}`);
  });

  it("pluralises tool uses", () => {
    expect(setup().render(det({ toolUses: 2 }))).toContain("<dim:2 tool uses>");
  });

  it("honours showCost, read on every render", () => {
    const s = setup({ showCost: true });
    const d = det({ totalCost: 0.05 });
    expect(s.render(d)).toContain("$0.05");
    s.settings.showCost = false;
    expect(s.render(d)).not.toContain("$");
  });

  it("collapsed shows an 80-char first-line preview", () => {
    const out = setup().render(det({ resultPreview: `${"x".repeat(100)}\nsecond` }));
    expect(out).toBe(`<success:✓> *audit* <dim:completed>\n  <dim:⎿  ${"x".repeat(80)}>`);
  });

  it("expanded shows at most 30 lines", () => {
    const lines = Array.from({ length: 40 }, (_, i) => `l${i}`);
    const rows = setup().render(det({ resultPreview: lines.join("\n") }), true)!.split("\n");
    expect(rows).toHaveLength(1 + 30);
    expect(rows[1]).toBe("<dim:  l0>");
    expect(rows[30]).toBe("<dim:  l29>");
  });

  it("shows the output file", () => {
    expect(setup().render(det({ outputFile: "/tmp/o.jsonl" }))).toMatch(
      /\n {2}<muted:transcript: \/tmp\/o\.jsonl>$/,
    );
  });

  it("batch: renders every agent and a cost summary first", () => {
    const out = setup().render(det({
      totalCost: 0.5, totalTokens: 1000,
      others: [det({ id: "a2", description: "b", totalCost: 0.25, totalTokens: 1000 })],
    }))!;
    expect(out.split("\n")[0]).toBe(
      `<dim:2 agents · ${formatTokens(2000)} · ${formatCost(0.75)}>`,
    );
    expect(out).toContain("*audit*");
    expect(out).toContain("*b*");
  });

  it("batch: no summary without cost or with showCost off", () => {
    const d = det({ others: [det({ description: "b" })] });
    expect(setup().render(d)).not.toContain("agents ·");
    expect(setup({ showCost: false }).render({ ...d, totalCost: 1 })).not.toContain("agents ·");
  });
});
