import type { Theme } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { renderAgentResult } from "../../src/tool/agent-tool-render.js";
import { type AgentStatus, statusPresentation } from "../../src/ui/agent-format.js";

const theme = { fg: (c: string, s: string) => `<${c}:${s}>`, bold: (s: string) => s } as unknown as Theme;

const FINISHED: AgentStatus[] = ["completed", "steered", "error", "aborted", "stopped"];

function firstLine(status: AgentStatus): string {
  const details = { status, durationMs: 10, toolUses: 0, error: "boom" };
  const result = { content: [{ type: "text" as const, text: "out" }], details };
  const rendered = renderAgentResult(result, { expanded: false, isPartial: false }, theme, { isError: false }, false);
  return (rendered as unknown as { text: string }).text.split("\n")[0];
}

describe("agent tool result status icon", () => {
  it.each(FINISHED)("draws %s with the shared mapping", status => {
    const { icon, color } = statusPresentation(status);
    expect(firstLine(status)).toContain(`<${color}:${icon}>`);
  });
});
