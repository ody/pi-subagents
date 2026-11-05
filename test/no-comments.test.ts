import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const ROOT = join(import.meta.dirname, "..");
const SCANNED = ["src", "test"];
const HEADER_SCAN_LINES = 30;

const SIZE_HEADER = /^\s*(\/\/|\/\*+|\*)\s*Size:\s*\S/;
const BIOME_IGNORE = /^\s*(\/\/|\/\*+)\s*biome-ignore\s+\S+:\s*\S/;

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

  for (const f of files) {
    it(`${f.rel} has no comments`, () => {
      expect(f.where, `${f.rel} has ${f.comments.length} comment(s); ADR 0010 allows none`).toEqual([]);
    });
  }
});
