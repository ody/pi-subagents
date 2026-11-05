import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const ROOT = join(import.meta.dirname, "..");
const SCANNED = ["src", "test"];
const HEADER_SCAN_LINES = 30;

const SIZE_HEADER = /^\s*(\/\/|\/\*+|\*)\s*Size:\s*\S/;
const BIOME_IGNORE = /^\s*(\/\/|\/\*+)\s*biome-ignore\s+\S+:\s*\S/;

const ALLOWLIST: Record<string, number> = {
  "src/manager/agent-manager.ts": 83,
  "src/session/agent-runner.ts": 127,
  "test/abort-forced-settle.test.ts": 22,
  "test/agent-file-toggle.test.ts": 64,
  "test/agent-manager.test.ts": 199,
  "test/agent-mention-provider.test.ts": 76,
  "test/agent-mention-wiring.test.ts": 121,
  "test/agent-runner-e2e.test.ts": 19,
  "test/agent-runner.test.ts": 199,
  "test/agent-widget.test.ts": 60,
  "test/background-resume-wiring.test.ts": 27,
  "test/conversation-viewer.test.ts": 84,
  "test/cost-display.test.ts": 13,
  "test/cross-extension-rpc.test.ts": 32,
  "test/fallback-subagent-wiring.test.ts": 19,
  "test/fleet-list.test.ts": 105,
  "test/foreground-concurrency-wiring.test.ts": 15,
  "test/foreground-concurrency.test.ts": 82,
  "test/nested-delegation-e2e.test.ts": 34,
  "test/output-file-compaction-e2e.test.ts": 22,
  "test/output-file.test.ts": 27,
  "test/perf/no-fs-on-render.perf.test.ts": 3,
  "test/perf/render-invariants.perf.test.ts": 19,
  "test/perf/spawn-invariants.perf.test.ts": 5,
  "test/perf/spawn.bench.ts": 7,
  "test/settings.test.ts": 48,
  "test/status-note-wiring.test.ts": 47,
  "test/steer-subagent-wiring.test.ts": 11,
  "test/usage.test.ts": 27,
};

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? walk(path) : [path];
  });
}

function commentRanges(file: string, text: string): ts.CommentRange[] {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, false, ts.ScriptKind.TS);
  const found = new Map<number, ts.CommentRange>();
  const collect = (ranges: ts.CommentRange[] | undefined) => {
    for (const range of ranges ?? []) found.set(range.pos, range);
  };
  const visit = (node: ts.Node) => {
    collect(ts.getLeadingCommentRanges(text, node.getFullStart()));
    collect(ts.getTrailingCommentRanges(text, node.getEnd()));
    ts.forEachChild(node, visit);
  };
  visit(source);
  return [...found.values()].sort((a, b) => a.pos - b.pos);
}

function lineOf(text: string, pos: number): number {
  return text.slice(0, pos).split("\n").length;
}

function isExempt(text: string, range: ts.CommentRange): boolean {
  const body = text.slice(range.pos, range.end);
  if (range.pos === 0 && body.startsWith("#!")) return true;
  if (lineOf(text, range.pos) <= HEADER_SCAN_LINES && SIZE_HEADER.test(body)) return true;
  return BIOME_IGNORE.test(body);
}

const files = SCANNED.flatMap((dir) => walk(join(ROOT, dir)))
  .filter((path) => path.endsWith(".ts"))
  .map((path) => {
    const text = readFileSync(path, "utf8");
    const rel = relative(ROOT, path).split("\\").join("/");
    const comments = commentRanges(rel, text).filter((range) => !isExempt(text, range));
    return {
      rel,
      text,
      comments,
      where: comments.map((range) => {
        const body = text.slice(range.pos, range.end).trim().replace(/\s+/g, " ");
        return `${rel}:${lineOf(text, range.pos)}: ${body.length > 60 ? `${body.slice(0, 60)}...` : body}`;
      }),
    };
  })
  .sort((a, b) => (a.rel < b.rel ? -1 : 1));

describe("no code comments (ADR 0010)", () => {
  it("finds TypeScript files", () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it("allowlist is sorted by path", () => {
    const paths = Object.keys(ALLOWLIST);
    expect(paths).toEqual([...paths].sort());
  });

  it("allowlist names only existing files", () => {
    const present = new Set(files.map((f) => f.rel));
    expect(Object.keys(ALLOWLIST).filter((rel) => !present.has(rel))).toEqual([]);
  });

  for (const f of files) {
    const pin = ALLOWLIST[f.rel];
    if (pin === undefined) {
      it(`${f.rel} has no comments`, () => {
        expect(f.where, `${f.rel} has ${f.comments.length} comment(s); ADR 0010 allows none`).toEqual([]);
      });
      continue;
    }
    it(`${f.rel} stays at or below its allowlist pin of ${pin}`, () => {
      expect(f.comments.length, `${f.rel} has ${f.comments.length} comment(s), pin is ${pin}`).toBeLessThanOrEqual(pin);
    });
    it(`${f.rel} drops out of the allowlist at 0 comments`, () => {
      expect(
        f.comments.length,
        `${f.rel} reached 0 comments; remove its allowlist entry "${f.rel}": ${pin}`,
      ).toBeGreaterThan(0);
    });
  }
});
