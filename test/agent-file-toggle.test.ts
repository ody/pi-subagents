import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseFrontmatter } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  buildNewAgentFile,
  disableInContent,
  enableInContent,
  findAgentFile,
  isDisabledContent,
  isEmptyStub,
  locateAgentFile,
} from "../src/agents/agent-file-toggle.js";
import { parseAgentFrontmatter } from "../src/agents/custom-agents.js";

function loaderSeesDisabled(content: string): boolean {
  return parseFrontmatter<Record<string, unknown>>(content).frontmatter.enabled === false;
}

const HAND_AUTHORED_DISABLED = "---\ndescription: Scout the repo\nenabled: false\n---\n\nYou are a scout.\n";
const EXTENSION_WRITTEN_DISABLED = "---\nenabled: false\ndescription: Scout the repo\n---\n\nYou are a scout.\n";
const ENABLED = "---\ndescription: Scout the repo\n---\n\nYou are a scout.\n";

describe("enableInContent", () => {
  it("strips enabled: false when it is the first frontmatter line", () => {
    const { content, changed } = enableInContent(EXTENSION_WRITTEN_DISABLED);
    expect(changed).toBe(true);
    expect(loaderSeesDisabled(content)).toBe(false);
  });

  it("strips enabled: false when another key precedes it", () => {
    const { content, changed } = enableInContent(HAND_AUTHORED_DISABLED);
    expect(changed).toBe(true);
    expect(loaderSeesDisabled(content)).toBe(false);
  });

  it("strips enabled: false when it is the last frontmatter line", () => {
    const src = "---\ndescription: Scout\ndisplay_name: Scout\nenabled: false\n---\n\nBody.\n";
    const { content, changed } = enableInContent(src);
    expect(changed).toBe(true);
    expect(loaderSeesDisabled(content)).toBe(false);
  });

  it("reports changed: false when there is nothing to strip", () => {
    const { content, changed } = enableInContent(ENABLED);
    expect(changed).toBe(false);
    expect(content).toBe(ENABLED);
  });

  it("leaves the body and other frontmatter keys untouched", () => {
    const src = "---\ndescription: Scout\nenabled: false\n# a comment\nmodel: haiku\n---\n\nLine 1.\n\nLine 2.\n";
    const { content } = enableInContent(src);
    expect(content).toContain("# a comment");
    expect(content).toContain("model: haiku");
    expect(content).toContain("Line 1.\n\nLine 2.\n");
    expect(loaderSeesDisabled(content)).toBe(false);
  });

  it("handles CRLF line endings", () => {
    const src = "---\r\ndescription: Scout\r\nenabled: false\r\n---\r\n\r\nBody.\r\n";
    const { content, changed } = enableInContent(src);
    expect(changed).toBe(true);
    expect(loaderSeesDisabled(content)).toBe(false);
  });
});

describe("disableInContent", () => {
  it("inserts enabled: false into a normal frontmatter block", () => {
    const { content, outcome } = disableInContent(ENABLED);
    expect(outcome).toBe("disabled");
    expect(loaderSeesDisabled(content)).toBe(true);
  });

  it("is idempotent when the key is already first", () => {
    expect(disableInContent(EXTENSION_WRITTEN_DISABLED).outcome).toBe("already-disabled");
  });

  it("is idempotent when the key is already present mid-block", () => {
    expect(disableInContent(HAND_AUTHORED_DISABLED).outcome).toBe("already-disabled");
  });

  it("never writes a file the loader cannot parse", () => {
    for (const src of [
      "---\ndescription: x\nenabled: false  \n---\nbody\n",
      "---\ndescription: x\nenabled: false\t\n---\nbody\n",
      HAND_AUTHORED_DISABLED,
      EXTENSION_WRITTEN_DISABLED,
      ENABLED,
    ]) {
      const { content } = disableInContent(src);
      expect(() => parseFrontmatter(content), JSON.stringify(src)).not.toThrow();
      expect(loaderSeesDisabled(content), JSON.stringify(src)).toBe(true);
    }
  });

  it("reports no-frontmatter rather than claiming success on a fence-less file", () => {
    const src = "Just a body, no frontmatter at all.\n";
    const { content, outcome } = disableInContent(src);
    expect(outcome).toBe("no-frontmatter");
    expect(content).toBe(src);
  });

  it("disables a CRLF file instead of misreporting it as frontmatter-less", () => {
    const src = "---\r\ndescription: Scout\r\n---\r\n\r\nBody.\r\n";
    const { content, outcome } = disableInContent(src);
    expect(outcome).toBe("disabled");
    expect(loaderSeesDisabled(content)).toBe(true);
  });

  it("toggles a BOM-prefixed file, and leaves the BOM where it found it", () => {
    const src = "﻿---\ndescription: 侦察\n---\n\n本文。\n";

    const { content, outcome } = disableInContent(src);

    expect(outcome).toBe("disabled");
    expect(isDisabledContent(content)).toBe(true);
    expect(content.startsWith("﻿")).toBe(true);
    expect(enableInContent(content).content).toBe(src);
  });
});

describe("parseAgentFrontmatter", () => {
  it("reads a BOM-prefixed file's fields instead of dropping them", () => {
    const src = "﻿---\ndescription: 侦察\ntools: none\n---\n\n本文。\n";

    const { frontmatter, body } = parseAgentFrontmatter<Record<string, unknown>>(src);

    expect(frontmatter).toEqual({ description: "侦察", tools: "none" });
    expect(body).toBe("本文。");
  });

  it("leaves a file without a BOM exactly as the parser reads it", () => {
    const src = "---\ndescription: Scout\n---\n\nBody.\n";

    expect(parseAgentFrontmatter<Record<string, unknown>>(src))
      .toEqual(parseFrontmatter<Record<string, unknown>>(src));
  });
});

describe("isDisabledContent", () => {
  it("sees the key at the first frontmatter line", () => {
    expect(isDisabledContent(EXTENSION_WRITTEN_DISABLED)).toBe(true);
  });

  it("sees the key mid-block", () => {
    expect(isDisabledContent(HAND_AUTHORED_DISABLED)).toBe(true);
  });

  it("sees the key in a CRLF file", () => {
    expect(isDisabledContent("---\r\ndescription: Scout\r\nenabled: false\r\n---\r\n\r\nBody.\r\n")).toBe(true);
  });

  it("is false for an enabled file", () => {
    expect(isDisabledContent(ENABLED)).toBe(false);
  });

  it.each([
    ["lowercase bare false", "---\ndescription: x\nenabled: false\n---\nbody\n", true],
    ["False", "---\ndescription: x\nenabled: False\n---\nbody\n", true],
    ["FALSE", "---\ndescription: x\nenabled: FALSE\n---\nbody\n", true],
    ["trailing comment", "---\ndescription: x\nenabled: false # off for now\n---\nbody\n", true],
    ["quoted key", '---\ndescription: x\n"enabled": false\n---\nbody\n', true],
    ["trailing whitespace", "---\ndescription: x\nenabled: false  \n---\nbody\n", true],
    ["'----' closes the block early", "---\ndescription: x\n----\nenabled: false\n---\nbody\n", false],
    ["'--- x' closes the block early", "---\ndescription: x\n--- x\nenabled: false\n---\nbody\n", false],
    ["quoted string, not a boolean", '---\ndescription: x\nenabled: "false"\n---\nbody\n', false],
    ["YAML 1.1 'no' is a string here", "---\ndescription: x\nenabled: no\n---\nbody\n", false],
    ["key only in the body", "---\ndescription: x\n---\nenabled: false\n", false],
  ])("agrees with the loader: %s", (_label, content, expected) => {
    expect(loaderSeesDisabled(content)).toBe(expected);
    expect(isDisabledContent(content)).toBe(expected);
  });
});

describe("read and write paths agree", () => {
  const shapes: Array<[string, string]> = [
    ["key first", EXTENSION_WRITTEN_DISABLED],
    ["key after description", HAND_AUTHORED_DISABLED],
    ["key last", "---\ndescription: Scout\ndisplay_name: S\nenabled: false\n---\n\nBody.\n"],
    ["CRLF", "---\r\ndescription: Scout\r\nenabled: false\r\n---\r\n\r\nBody.\r\n"],
  ];

  for (const [label, content] of shapes) {
    it(`a file the loader reads as disabled can be enabled — ${label}`, () => {
      expect(loaderSeesDisabled(content)).toBe(true);
      expect(enableInContent(content).changed).toBe(true);
    });
  }

  it("disable → enable round-trips to the original hand-authored file", () => {
    const disabled = disableInContent(ENABLED);
    expect(disabled.outcome).toBe("disabled");
    expect(enableInContent(disabled.content).content).toBe(ENABLED);
  });
});

describe("isEmptyStub", () => {
  it("recognises the stub behind a BOM", () => {
    expect(isEmptyStub("\uFEFF---\n---")).toBe(true);
  });

  it("recognizes the stub /agents writes to disable a built-in default", () => {
    expect(isEmptyStub("---\n---\n")).toBe(true);
    expect(isEmptyStub(enableInContent("---\nenabled: false\n---\n").content)).toBe(true);
  });

  it("is false for a file with real frontmatter", () => {
    expect(isEmptyStub(ENABLED)).toBe(false);
  });
});

describe("findAgentFile", () => {
  let tmpDir: string;
  let agentDir: string;
  let prevAgentDir: string | undefined;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "pi-toggle-"));
    agentDir = mkdtempSync(join(tmpdir(), "pi-toggle-agentdir-"));
    prevAgentDir = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = agentDir;
  });

  afterEach(() => {
    if (prevAgentDir == null) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = prevAgentDir;
    rmSync(tmpDir, { recursive: true, force: true });
    rmSync(agentDir, { recursive: true, force: true });
  });

  function write(dir: string, name: string) {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${name}.md`), ENABLED);
  }

  it("prefers .pi/agents over .agents/agents and the personal dir", () => {
    write(join(tmpDir, ".pi", "agents"), "scout");
    write(join(tmpDir, ".agents", "agents"), "scout");
    write(join(agentDir, "agents"), "scout");
    expect(findAgentFile("scout", tmpDir)).toEqual({
      path: join(tmpDir, ".pi", "agents", "scout.md"),
      location: "project",
    });
  });

  it("falls back to the workspace .agents/agents dir", () => {
    write(join(tmpDir, ".agents", "agents"), "scout");
    write(join(agentDir, "agents"), "scout");
    expect(findAgentFile("scout", tmpDir)).toEqual({
      path: join(tmpDir, ".agents", "agents", "scout.md"),
      location: "workspace",
    });
  });

  it("falls back to the personal agent dir", () => {
    write(join(agentDir, "agents"), "scout");
    expect(findAgentFile("scout", tmpDir)).toEqual({
      path: join(agentDir, "agents", "scout.md"),
      location: "personal",
    });
  });

  it("returns undefined when the agent has no file anywhere", () => {
    expect(findAgentFile("nope", tmpDir)).toBeUndefined();
  });

  describe("locateAgentFile", () => {
    it("uses the file the loader read, whatever it is called", () => {
      write(join(tmpDir, ".pi", "agents"), "reviewer");
      const sourcePath = join(tmpDir, ".pi", "agents", "reviewer.md");

      expect(locateAgentFile("code-reviewer", sourcePath, tmpDir)).toEqual({
        path: sourcePath,
        location: "project",
      });
    });

    it("classifies a workspace and a personal source path", () => {
      write(join(tmpDir, ".agents", "agents"), "reviewer");
      write(join(agentDir, "agents"), "auditor");

      expect(locateAgentFile("code-reviewer", join(tmpDir, ".agents", "agents", "reviewer.md"), tmpDir))
        .toMatchObject({ location: "workspace" });
      expect(locateAgentFile("code-auditor", join(agentDir, "agents", "auditor.md"), tmpDir))
        .toMatchObject({ location: "personal" });
    });

    it("falls back to the <type>.md probe for a built-in with no source file", () => {
      write(join(tmpDir, ".pi", "agents"), "scout");

      expect(locateAgentFile("scout", undefined, tmpDir)).toEqual({
        path: join(tmpDir, ".pi", "agents", "scout.md"),
        location: "project",
      });
    });

    it("falls back when the recorded path has since been deleted", () => {
      write(join(tmpDir, ".pi", "agents"), "scout");

      expect(locateAgentFile("scout", join(tmpDir, ".pi", "agents", "gone.md"), tmpDir)).toEqual({
        path: join(tmpDir, ".pi", "agents", "scout.md"),
        location: "project",
      });
    });

    it("finds nothing when neither the source path nor the probe resolves", () => {
      expect(locateAgentFile("nope", join(tmpDir, ".pi", "agents", "gone.md"), tmpDir)).toBeUndefined();
    });
  });
});

describe("buildNewAgentFile", () => {
  const base = { tools: "read, grep", systemPrompt: "Do the thing.", description: "Scout" };

  const parse = (content: string) => parseFrontmatter<Record<string, unknown>>(content).frontmatter;

  it("round-trips an ordinary description", () => {
    expect(parse(buildNewAgentFile(base)).description).toBe("Scout");
  });

  it("survives a description containing a colon", () => {
    const content = buildNewAgentFile({ ...base, description: "Scout: find things" });
    expect(() => parse(content)).not.toThrow();
    expect(parse(content).description).toBe("Scout: find things");
  });

  it("keeps a description containing a # instead of truncating it", () => {
    const content = buildNewAgentFile({ ...base, description: "audit #security" });
    expect(parse(content).description).toBe("audit #security");
  });

  it("leaves a `provider/model:thinking` suffix intact", () => {
    const content = buildNewAgentFile({ ...base, model: "anthropic/claude-sonnet-4-6:high" });
    expect(parse(content).model).toBe("anthropic/claude-sonnet-4-6:high");
  });

  it("survives a custom model containing a colon-space or a #", () => {
    for (const model of ["anthropic/foo: bar", "anthropic/x #c"]) {
      const content = buildNewAgentFile({ ...base, model });
      expect(() => parse(content), model).not.toThrow();
      expect(parse(content).model, model).toBe(model);
    }
  });

  it("emits the fields the wizard collects, and omits the ones left on inherit", () => {
    const full = parse(buildNewAgentFile({ ...base, model: "anthropic/x", thinking: "high" }));
    expect(full).toMatchObject({ tools: "read, grep", model: "anthropic/x", thinking: "high", prompt_mode: "replace" });

    const minimal = parse(buildNewAgentFile(base));
    expect(minimal.model).toBeUndefined();
    expect(minimal.thinking).toBeUndefined();
  });

  it("keeps the system prompt as the body", () => {
    const content = buildNewAgentFile({ ...base, systemPrompt: "Line 1.\n\nLine 2." });
    expect(parseFrontmatter<Record<string, unknown>>(content).body).toBe("Line 1.\n\nLine 2.");
  });
});
