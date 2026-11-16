import { describe, expect, it } from "vitest";
import { backgroundRunFooter } from "../../src/tool/agent-tool-background.js";
import type { AgentRecord } from "../../src/types.js";

const closing =
  "\nYou will be notified when this agent completes.\n" +
  "Use get_subagent_result to retrieve full results, or steer_subagent to send it messages.";

function record(overrides: Partial<AgentRecord>): AgentRecord {
  return {
    id: "a1",
    type: "general-purpose",
    description: "test",
    status: "running",
    toolUses: 0,
    startedAt: 1,
    lifetimeUsage: { input: 0, output: 0, cacheWrite: 0, cost: 0 },
    compactionCount: 0,
    ...overrides,
  };
}

describe("backgroundRunFooter", () => {
  it("holds only the closing lines for a running run without an output file", () => {
    expect(backgroundRunFooter(record({}), 4)).toBe(closing);
  });

  it("holds only the closing lines when the record is missing", () => {
    expect(backgroundRunFooter(undefined, 4)).toBe(closing);
  });

  it("names the output file", () => {
    expect(backgroundRunFooter(record({ outputFile: "/tmp/a1.jsonl" }), 4))
      .toBe(`Output file: /tmp/a1.jsonl\n${closing}`);
  });

  it("gives the queue position with the concurrency limit", () => {
    expect(backgroundRunFooter(record({ status: "queued", outputFile: "/tmp/a1.jsonl" }), 4))
      .toBe(`Output file: /tmp/a1.jsonl\nPosition: queued (max 4 concurrent)\n${closing}`);
  });
});
