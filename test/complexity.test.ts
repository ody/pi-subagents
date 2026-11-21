import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(import.meta.dirname, "..");
const MAX_SCORE = 30;

interface Diagnostic {
  category: string;
  message: string;
  location: { path: string };
}

function readReport(): { offenders: string[]; parsed: boolean } {
  const result = spawnSync(
    join(ROOT, "node_modules/.bin/biome"),
    ["lint", "--max-diagnostics=none", "--reporter=json", "--only=complexity/noExcessiveCognitiveComplexity", "src"],
    { cwd: ROOT, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 },
  );
  const report = JSON.parse(result.stdout) as { diagnostics: Diagnostic[] };
  const offenders: string[] = [];
  for (const d of report.diagnostics) {
    if (!d.category.endsWith("noExcessiveCognitiveComplexity")) continue;
    const score = Number(/complexity of (\d+)/.exec(d.message)?.[1]);
    if (score > MAX_SCORE) offenders.push(`${d.location.path}: ${score}`);
  }
  return { offenders, parsed: Array.isArray(report.diagnostics) };
}

const { offenders, parsed } = readReport();

describe(`cognitive complexity ceiling of ${MAX_SCORE} (ADR 0004)`, () => {
  it("parses the Biome report", () => {
    expect(parsed).toBe(true);
  });

  it(`has no function scoring over ${MAX_SCORE}`, () => {
    expect(offenders, `refactor these, or add a biome-ignore with a reason`).toEqual([]);
  });
});
