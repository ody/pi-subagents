import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { disableInContent, enableInContent } from "../src/agents/agent-file-toggle.js";
import { loadCustomAgents } from "../src/agents/custom-agents.js";

const BOM = "﻿";
const AGENT = `${BOM}---
description: 代码审查员
tools: none
model: anthropic/claude-haiku-4-5
---

你是一位资深的代码审查员。请仔细检查代码。`;

describe("BOM-prefixed agent files", () => {
  let tmpDir: string;
  let originalHome: string | undefined;
  let originalAgentDir: string | undefined;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "pi-bom-"));
    originalHome = process.env.HOME;
    originalAgentDir = process.env.PI_CODING_AGENT_DIR;
    process.env.HOME = tmpDir;
    delete process.env.PI_CODING_AGENT_DIR;
  });

  afterEach(() => {
    if (originalHome == null) delete process.env.HOME;
    else process.env.HOME = originalHome;
    if (originalAgentDir == null) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function writeAgent(name: string, content: string): string {
    const dir = join(tmpDir, ".agents", "agents");
    mkdirSync(dir, { recursive: true });
    const path = join(dir, `${name}.md`);
    writeFileSync(path, content, "utf-8");
    return path;
  }

  it("loads every field, rather than dropping them behind the BOM", () => {
    writeAgent("审查员", AGENT);

    const agent = loadCustomAgents(tmpDir).get("审查员");

    expect(agent?.description).toBe("代码审查员");
    expect(agent?.model).toBe("anthropic/claude-haiku-4-5");
    expect(agent?.systemPrompt).toBe("你是一位资深的代码审查员。请仔细检查代码。");
    expect(agent?.systemPrompt).not.toContain("---");
  });

  it("honours `tools: none` instead of granting the default toolset", () => {
    writeAgent("审查员", AGENT);

    const agent = loadCustomAgents(tmpDir).get("审查员");

    expect(agent?.builtinToolNames).toEqual([]);
  });

  it("handles BOM + CRLF together, which is what a Windows editor writes", () => {
    const crlf = `${BOM}---\r\ndescription: 代码审查员\r\ntools: none\r\n---\r\n\r\n你是审查员。\r\n`;
    const path = writeAgent("审查员", crlf);

    expect(loadCustomAgents(tmpDir).get("审查员")?.description).toBe("代码审查员");

    const { content, outcome } = disableInContent(readFileSync(path, "utf-8"));
    expect(outcome).toBe("disabled");
    expect(content.startsWith(BOM)).toBe(true);
    expect(/[^\r]\n/.test(content)).toBe(false);
    expect(enableInContent(content).content).toBe(crlf);
  });

  it("still refuses a BOM-prefixed file that has no frontmatter at all", () => {
    const { content, outcome } = disableInContent(`${BOM}没有前置数据。\n`);

    expect(outcome).toBe("no-frontmatter");
    expect(content).toBe(`${BOM}没有前置数据。\n`);
  });

  it("disables and re-enables on disk, leaving the file byte-identical", () => {
    const path = writeAgent("审查员", AGENT);

    writeFileSync(path, disableInContent(readFileSync(path, "utf-8")).content, "utf-8");
    expect(loadCustomAgents(tmpDir).get("审查员")?.enabled).toBe(false);
    expect(readFileSync(path, "utf-8").startsWith(BOM)).toBe(true);

    writeFileSync(path, enableInContent(readFileSync(path, "utf-8")).content, "utf-8");
    expect(loadCustomAgents(tmpDir).get("审查员")?.enabled).not.toBe(false);
    expect(readFileSync(path, "utf-8")).toBe(AGENT);
  });
});
