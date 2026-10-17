// Enforces the complexity ceiling in ADR 0004 (docs/decisions/0004-source-file-structure.md).
//
// Biome reports every function over 15 at `info` severity. A function scoring
// over MAX_SCORE fails here. Existing offenders sit in PINS as a per-file list
// of scores, largest first. A list may shrink or lose entries, never grow, and
// no score may rise. When a file has no score over MAX_SCORE, delete its entry.
// Scores are matched to pins by rank, so line numbers can move freely.

import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(import.meta.dirname, "..");
const MAX_SCORE = 30;

const PINS: Record<string, number[]> = {
  "src/agent-control-tools.ts": [36, 31],
  "src/agent-runner.ts": [111, 38],
  "src/agent-tool-render.ts": [43],
  "src/agent-tool.ts": [84],
  "src/mention-input.ts": [66],
  "src/nested-tools.ts": [35],
  "src/session-text.ts": [35],
  "src/settings.ts": [40],
  "src/ui/agent-widget.ts": [68, 33],
  "src/ui/agents-menu.ts": [40],
  "src/ui/conversation-viewer.ts": [74, 33],
  "src/ui/fleet-list.ts": [33],
  "src/ui/notification-renderer.ts": [49],
  "src/ui/settings-menu.ts": [103, 37],
};

interface Diagnostic {
  category: string;
  message: string;
  location: { path: string };
}

function overLimitScores(): Map<string, number[]> {
  const result = spawnSync(
    join(ROOT, "node_modules/.bin/biome"),
    ["lint", "--max-diagnostics=none", "--reporter=json", "--only=complexity/noExcessiveCognitiveComplexity", "src"],
    { cwd: ROOT, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 },
  );
  const report = JSON.parse(result.stdout) as { diagnostics: Diagnostic[] };
  const scores = new Map<string, number[]>();
  for (const d of report.diagnostics) {
    if (!d.category.endsWith("noExcessiveCognitiveComplexity")) continue;
    const score = Number(/complexity of (\d+)/.exec(d.message)?.[1]);
    if (!(score > MAX_SCORE)) continue;
    const list = scores.get(d.location.path) ?? [];
    list.push(score);
    scores.set(d.location.path, list);
  }
  for (const list of scores.values()) list.sort((a, b) => b - a);
  return scores;
}

const actual = overLimitScores();

describe(`cognitive complexity ceiling of ${MAX_SCORE} (ADR 0004)`, () => {
  it("parses the Biome report", () => {
    expect(actual.size).toBeGreaterThan(0);
  });

  for (const [file, scores] of actual) {
    const pin = PINS[file] ?? [];
    it(`${file} has no function over ${MAX_SCORE} beyond its pin`, () => {
      expect(scores.length, `${file} functions over ${MAX_SCORE}: ${scores.join(", ")}`).toBeLessThanOrEqual(pin.length);
      scores.forEach((score, i) => {
        expect(score, `${file} function ranked ${i + 1}`).toBeLessThanOrEqual(pin[i]);
      });
    });
  }

  it("pins have no stale entries", () => {
    const stale = Object.entries(PINS)
      .filter(([file, pin]) => {
        const now = actual.get(file) ?? [];
        return now.length < pin.length || now.some((s, i) => s < pin[i]);
      })
      .map(([file]) => file);
    expect(stale, "lower or delete these pins to match the current scores").toEqual([]);
  });
});
