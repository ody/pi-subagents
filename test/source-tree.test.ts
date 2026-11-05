import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(__dirname, "..");
const SRC = join(ROOT, "src");
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

  it("lists every src/ file in the README map and no missing path", () => {
    const readme = readFileSync(join(ROOT, "README.md"), "utf8");
    const block = readme.split("## Architecture")[1]?.split("```")[1] ?? "";
    const lines = block.split("\n").slice(1);
    const listed: string[] = [];
    let inSrc = false;
    let group = "";
    for (const line of lines) {
      if (/^src\/\s*$/.test(line)) { inSrc = true; continue; }
      if (!inSrc) continue;
      const m = /^( {2}| {4})(\S+)\s*(#.*)?$/.exec(line);
      if (!m) continue;
      const name = m[2];
      if (m[1].length === 2) {
        if (name.endsWith("/")) group = name;
        else { group = ""; listed.push(name); }
      } else if (group) {
        listed.push(group + name);
      }
    }
    expect(listed.sort()).toEqual([...files].sort());
  });
});
