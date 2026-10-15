// Enforces ADR 0004 (docs/decisions/0004-source-file-structure.md).
//
// - A src/ file over SIZE_HEADER_LINES lines needs a `Size: <reason>` header
//   comment line near the top, or a split.
// - A src/ file must stay under MAX_LINES lines and MAX_BYTES bytes.
//
// Files that broke these rules when the ADR was accepted sit in ALLOWLIST,
// pinned at their line count and byte size. They may shrink, never grow.
// When one shrinks, lower its pin; when it complies, delete its entry.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(import.meta.dirname, "..");
const SRC = join(ROOT, "src");

const SIZE_HEADER_LINES = 500;
const MAX_LINES = 800;
const MAX_BYTES = 40 * 1024;
const HEADER_SCAN_LINES = 30;

const ALLOWLIST: Record<string, { lines: number; bytes: number }> = {
  "src/index.ts": { lines: 1914, bytes: 98252 },
  "src/ui/agent-widget.ts": { lines: 685, bytes: 28447 },
  "src/ui/conversation-viewer.ts": { lines: 589, bytes: 24896 },
  "src/settings.ts": { lines: 561, bytes: 27151 },
};

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? walk(path) : [path];
  });
}

function countLines(text: string): number {
  if (text.length === 0) return 0;
  const newlines = text.split("\n").length - 1;
  return text.endsWith("\n") ? newlines : newlines + 1;
}

function hasSizeHeader(text: string): boolean {
  return text
    .split("\n", HEADER_SCAN_LINES)
    .some((line) => /^\s*(\/\/|\/\*+|\*)\s*Size:\s*\S/.test(line));
}

const files = walk(SRC).map((path) => {
  const text = readFileSync(path, "utf8");
  return {
    rel: relative(ROOT, path).split("\\").join("/"),
    lines: countLines(text),
    bytes: statSync(path).size,
    header: hasSizeHeader(text),
  };
});

describe("source file size (ADR 0004)", () => {
  it("finds source files", () => {
    expect(files.length).toBeGreaterThan(0);
  });

  for (const f of files) {
    const pin = ALLOWLIST[f.rel];
    if (pin) {
      it(`${f.rel} does not grow past its allowlist pin`, () => {
        expect(f.lines, `${f.rel} lines`).toBeLessThanOrEqual(pin.lines);
        expect(f.bytes, `${f.rel} bytes`).toBeLessThanOrEqual(pin.bytes);
      });
      continue;
    }
    it(`${f.rel} stays under ${MAX_LINES} lines and ${MAX_BYTES} bytes`, () => {
      expect(f.lines, `${f.rel} lines`).toBeLessThan(MAX_LINES);
      expect(f.bytes, `${f.rel} bytes`).toBeLessThan(MAX_BYTES);
    });
    if (f.lines > SIZE_HEADER_LINES) {
      it(`${f.rel} has a Size: header (over ${SIZE_HEADER_LINES} lines)`, () => {
        expect(f.header, `${f.rel} needs a "Size: <reason>" header comment line or a split`).toBe(true);
      });
    }
  }

  it("allowlist names only existing files", () => {
    const present = new Set(files.map((f) => f.rel));
    expect(Object.keys(ALLOWLIST).filter((rel) => !present.has(rel))).toEqual([]);
  });
});
