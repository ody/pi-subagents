import { readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const SRC = join(__dirname, "..", "src");
const BANNED = ["core", "utils", "helpers", "misc", "part2"];

function srcFiles(dir: string, prefix = ""): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? srcFiles(join(dir, e.name), `${prefix}${e.name}/`) : [`${prefix}${e.name}`],
  );
}

const files = srcFiles(SRC);
const dirs = readdirSync(SRC, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);

describe("src/ directory structure (ADR 0006)", () => {
  it("has no banned directory names", () => {
    expect(dirs.filter((d) => BANNED.includes(d))).toEqual([]);
  });

  it("has at least two files in every subdirectory", () => {
    const small = dirs.filter((d) => files.filter((f) => f.startsWith(`${d}/`)).length < 2);
    expect(small).toEqual([]);
  });
});
