import { readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const SRC = join(__dirname, "..", "src");
const TEST = __dirname;
const BANNED = ["core", "utils", "helpers", "misc", "part2"];
const TEST_SUFFIX = ".test.ts";

function filesUnder(dir: string, prefix = ""): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? filesUnder(join(dir, e.name), `${prefix}${e.name}/`) : [`${prefix}${e.name}`],
  );
}

function dirsUnder(dir: string, prefix = ""): string[] {
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .flatMap((e) => [`${prefix}${e.name}`, ...dirsUnder(join(dir, e.name), `${prefix}${e.name}/`)]);
}

const srcFiles = filesUnder(SRC);
const srcGroups = readdirSync(SRC, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
const testSupportDirs = readdirSync(TEST, { withFileTypes: true })
  .filter((e) => e.isDirectory() && !srcGroups.includes(e.name))
  .map((e) => e.name);

function hasBannedName(path: string): boolean {
  return path.split("/").some((part) => BANNED.includes(part));
}

function groupOfModule(moduleName: string): string | undefined {
  const file = srcFiles.find((f) => f.endsWith(`/${moduleName}.ts`) || f === `${moduleName}.ts`);
  if (!file) return undefined;
  return file.includes("/") ? file.split("/")[0] : "";
}

function testFilesInPlacementDirs(): { path: string; dir: string; module: string }[] {
  const placed = ["", ...srcGroups];
  return placed.flatMap((dir) =>
    readdirSync(join(TEST, dir), { withFileTypes: true })
      .filter((e) => e.isFile() && e.name.endsWith(TEST_SUFFIX))
      .map((e) => ({ path: dir ? `${dir}/${e.name}` : e.name, dir, module: e.name.slice(0, -TEST_SUFFIX.length) })),
  );
}

function misplacedTests(): string[] {
  return testFilesInPlacementDirs()
    .filter(({ dir, module }) => {
      const group = groupOfModule(module);
      return group !== undefined && group !== dir;
    })
    .map(({ path, module }) => `${path} should be in test/${groupOfModule(module) || ""}`);
}

describe("src/ directory structure (ADR 0006)", () => {
  it("has no banned directory names at any depth", () => {
    expect(dirsUnder(SRC).filter(hasBannedName)).toEqual([]);
  });

  it("has at least two files in every top-level group", () => {
    const small = srcGroups.filter((d) => srcFiles.filter((f) => f.startsWith(`${d}/`)).length < 2);
    expect(small).toEqual([]);
  });
});

describe("test/ directory structure (ADR 0006)", () => {
  it("has no banned directory names at any depth", () => {
    expect(dirsUnder(TEST).filter(hasBannedName)).toEqual([]);
  });

  it("has at least two files in every support directory", () => {
    const small = testSupportDirs.filter((d) => filesUnder(join(TEST, d)).length < 2);
    expect(small).toEqual([]);
  });

  it("holds each test named for a src/ module in the directory of that module's group", () => {
    expect(misplacedTests()).toEqual([]);
  });
});
