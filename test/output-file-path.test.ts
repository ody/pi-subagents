import { chmodSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, statSync } from "node:fs";
import { tmpdir as realTmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fakeTmp = vi.hoisted(() => ({ dir: "" }));

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return { ...actual, tmpdir: () => fakeTmp.dir || actual.tmpdir() };
});

import { createOutputFilePath } from "../src/platform/output-file.js";

const UID = process.getuid?.() ?? 0;
const AGENT = "agent-xyz";
const SESSION = "session-123";

describe("createOutputFilePath", () => {
  let root: string;

  beforeEach(() => {
    fakeTmp.dir = realpathSync(mkdtempSync(join(realTmpdir(), "pi-outpath-")));
    root = join(fakeTmp.dir, `pi-subagents-${UID}`);
  });

  afterEach(() => {
    rmSync(fakeTmp.dir, { recursive: true, force: true });
    fakeTmp.dir = "";
  });

  it("builds the documented layout: <root>/<encoded-cwd>/<session>/tasks/<agent>.output", () => {
    const path = createOutputFilePath("/home/user/project", AGENT, SESSION);
    expect(path).toBe(join(root, "home-user-project", SESSION, "tasks", `${AGENT}.output`));
  });

  it("creates the directory chain so the first write cannot fail", () => {
    const path = createOutputFilePath("/home/user/project", AGENT, SESSION);
    expect(existsSync(join(path, ".."))).toBe(true);
    expect(statSync(join(path, "..")).isDirectory()).toBe(true);
  });

  it("keeps distinct cwds in separate subdirectories under the shared root", () => {
    const a = createOutputFilePath("/home/user/project", AGENT, SESSION);
    const b = createOutputFilePath("/home/user/other", "agent-2", SESSION);
    expect(a).toContain("home-user-project");
    expect(b).toContain("home-user-other");
    expect(a).not.toBe(b);
  });

  it.skipIf(process.platform === "win32")("creates the root owner-only", () => {
    createOutputFilePath("/home/user/project", AGENT, SESSION);
    expect(statSync(root).mode & 0o777).toBe(0o700);
  });

  it.skipIf(process.platform === "win32")("re-tightens a pre-existing world-readable root", () => {
    mkdirSync(root, { recursive: true, mode: 0o755 });
    chmodSync(root, 0o755);
    expect(statSync(root).mode & 0o777).toBe(0o755);

    createOutputFilePath("/home/user/project", AGENT, SESSION);

    expect(statSync(root).mode & 0o777).toBe(0o700);
  });
});
