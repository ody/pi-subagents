import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadCapabilityPolicy, policyEventPayload } from "../src/config/capability-policy-config.js";
import { registerAgents } from "../src/agents/agent-types.js";
import { unknownPolicyEntries } from "../src/config/policy-unknown-entries.js";
import { runAgent } from "../src/session/agent-runner.js";
import type { AgentConfig } from "../src/types.js";
import { registeredCapability } from "./helpers/capability.js";
import { registerFauxProvider } from "./helpers/pi-ai.js";
import { applyAndEmitLoaded, type SettingsAppliers, saveAndEmitChanged } from "../src/config/settings.js";
import { registerRpcHandlers } from "../src/triggers/cross-extension-rpc.js";

describe("capability policy configuration", () => {
  let globalDir: string;
  let projectDir: string;
  let originalAgentDirEnv: string | undefined;

  const globalFile = () => join(globalDir, "subagents.json");
  const projectFile = () => join(projectDir, ".pi", "subagents.json");
  const writeGlobal = (obj: unknown) => writeFileSync(globalFile(), typeof obj === "string" ? obj : JSON.stringify(obj));
  const writeProject = (obj: unknown) => {
    mkdirSync(join(projectDir, ".pi"), { recursive: true });
    writeFileSync(projectFile(), typeof obj === "string" ? obj : JSON.stringify(obj));
  };

  beforeEach(() => {
    globalDir = mkdtempSync(join(tmpdir(), "pi-policy-global-"));
    projectDir = mkdtempSync(join(tmpdir(), "pi-policy-project-"));
    originalAgentDirEnv = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = globalDir;
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (originalAgentDirEnv == null) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = originalAgentDirEnv;
    rmSync(globalDir, { recursive: true, force: true });
    rmSync(projectDir, { recursive: true, force: true });
  });

  it("allows everything when no file carries a policy", () => {
    const loaded = loadCapabilityPolicy(projectDir);
    expect(loaded).toEqual({ global: {}, project: {}, ephemeralNesting: true, problems: [] });
  });

  it("keeps global and project policy separate", () => {
    writeGlobal({ policy: { tools: { allow: ["read", "ext:web"] }, skills: { deny: ["x"] } } });
    writeProject({ policy: { tools: { deny: ["bash"] } } });
    const loaded = loadCapabilityPolicy(projectDir);
    expect(loaded.global).toEqual({ tools: { allow: ["read", "ext:web"] }, skills: { deny: ["x"] } });
    expect(loaded.project).toEqual({ tools: { deny: ["bash"] } });
    expect(loaded.problems).toEqual([]);
  });

  it("turns ephemeral nesting off when either file says false", () => {
    writeGlobal({ policy: { ephemeralNesting: true } });
    writeProject({ policy: { ephemeralNesting: false } });
    expect(loadCapabilityPolicy(projectDir).ephemeralNesting).toBe(false);
    writeGlobal({ policy: { ephemeralNesting: false } });
    writeProject({});
    expect(loadCapabilityPolicy(projectDir).ephemeralNesting).toBe(false);
  });

  it("reads the policy at every call", () => {
    expect(loadCapabilityPolicy(projectDir).global).toEqual({});
    writeGlobal({ policy: { tools: { deny: ["bash"] } } });
    expect(loadCapabilityPolicy(projectDir).global).toEqual({ tools: { deny: ["bash"] } });
  });

  it.each([
    ["a non-object policy", { policy: [] }, "policy must be an object"],
    ["a non-array list", { policy: { tools: { allow: "read" } } }, "policy.tools.allow must be an array"],
    ["a non-string entry", { policy: { skills: { deny: [1] } } }, "policy.skills.deny has an entry"],
    ["* in a deny list", { policy: { tools: { deny: ["*"] } } }, 'contains "*"'],
    ["an unknown key", { policy: { tool: {} } }, "policy.tool is not a known key"],
    ["a non-boolean ephemeralNesting", { policy: { ephemeralNesting: "no" } }, "ephemeralNesting must be a boolean"],
  ])("reports %s as malformed and names the file", (_name, body, fragment) => {
    writeProject(body);
    const loaded = loadCapabilityPolicy(projectDir);
    expect(loaded.problems).toHaveLength(1);
    expect(loaded.problems[0]).toContain(projectFile());
    expect(loaded.problems[0]).toContain(fragment);
  });

  it("allows * in an allow list", () => {
    writeGlobal({ policy: { tools: { allow: ["*"] } } });
    expect(loadCapabilityPolicy(projectDir).problems).toEqual([]);
  });

  it("reports an unparseable file as malformed", () => {
    writeGlobal("{ nope");
    const loaded = loadCapabilityPolicy(projectDir);
    expect(loaded.problems[0]).toContain(globalFile());
    expect(loaded.problems[0]).toContain("cannot be parsed");
  });

  const appliers = () => new Proxy({}, { get: () => () => {} }) as SettingsAppliers;
  const changeMax = (layer: "global" | "project", n: number) =>
    saveAndEmitChanged({ layer, key: "maxConcurrent", value: n }, "ok", vi.fn(), appliers(), projectDir);

  it("saving one key leaves the policy of that layer unchanged", () => {
    const policy = { tools: { deny: ["bash"] }, ephemeralNesting: false };
    writeProject({ maxConcurrent: 3, policy });
    expect(changeMax("project", 7).level).toBe("info");
    expect(JSON.parse(readFileSync(projectFile(), "utf-8"))).toEqual({ maxConcurrent: 7, policy });
  });

  it("saving a global key leaves the global policy unchanged", () => {
    const policy = { skills: { deny: ["x"] } };
    writeGlobal({ policy });
    expect(changeMax("global", 7).level).toBe("info");
    expect(JSON.parse(readFileSync(globalFile(), "utf-8"))).toEqual({ maxConcurrent: 7, policy });
  });

  it("changing ephemeralNesting writes only that key and fires settings_changed with the policy", () => {
    const policy = { tools: { deny: ["bash"] }, skills: { allow: ["review"] } };
    writeProject({ maxConcurrent: 3, policy, extra: true });
    const emit = vi.fn();
    const toast = saveAndEmitChanged(
      { layer: "project", key: "ephemeralNesting", value: false },
      "ok",
      emit,
      appliers(),
      projectDir,
    );
    expect(toast.level).toBe("info");
    expect(JSON.parse(readFileSync(projectFile(), "utf-8"))).toEqual({
      maxConcurrent: 3,
      policy: { ...policy, ephemeralNesting: false },
      extra: true,
    });
    expect(emit).toHaveBeenCalledWith(
      "subagents:settings_changed",
      expect.objectContaining({
        layer: "project",
        persisted: true,
        policy: { global: {}, project: policy, ephemeralNesting: false },
      }),
    );
  });

  it("changing ephemeralNesting refuses a policy that is not an object", () => {
    writeGlobal({ policy: [] });
    const toast = saveAndEmitChanged(
      { layer: "global", key: "ephemeralNesting", value: false },
      "ok",
      vi.fn(),
      appliers(),
      projectDir,
    );
    expect(toast.level).toBe("warning");
    expect(JSON.parse(readFileSync(globalFile(), "utf-8"))).toEqual({ policy: [] });
  });

  it("saving settings adds no policy key when the file has none", () => {
    expect(changeMax("project", 7).level).toBe("info");
    expect(JSON.parse(readFileSync(projectFile(), "utf-8"))).toEqual({ maxConcurrent: 7 });
  });

  it.each(["project", "global"] as const)("saving settings refuses when the %s file does not parse", (layer) => {
    if (layer === "project") writeProject("{ broken");
    else writeGlobal("{ broken");
    const file = layer === "project" ? projectFile() : globalFile();
    expect(changeMax(layer, 7).level).toBe("warning");
    expect(readFileSync(file, "utf-8")).toBe("{ broken");
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining(file));
  });

  it("carries the policy in settings_loaded and settings_changed", () => {
    writeGlobal({ policy: { skills: { deny: ["x"] } } });
    writeProject({ policy: { ephemeralNesting: false } });
    const emit = vi.fn();
    const appliers = new Proxy({}, { get: () => () => {} }) as SettingsAppliers;
    applyAndEmitLoaded(appliers, emit, projectDir);
    saveAndEmitChanged({ layer: "project", key: "maxConcurrent", value: 2 }, "ok", emit, appliers, projectDir);
    const expected = { global: { skills: { deny: ["x"] } }, project: {}, ephemeralNesting: false };
    expect(emit).toHaveBeenCalledWith("subagents:settings_loaded", expect.objectContaining({ policy: expected }));
    expect(emit).toHaveBeenCalledWith("subagents:settings_changed", expect.objectContaining({ policy: expected }));
  });

  it("names the file and entry for a well-formed entry that names nothing known", () => {
    writeGlobal({ policy: { tools: { deny: ["bash", "nosuchtool"] }, skills: { allow: ["*", "ghost-skill"] } } });
    writeProject({ policy: { extensions: { deny: ["ghost-ext"] }, tools: { allow: ["ext:ghost-ext/x", "read"] } } });
    const loaded = loadCapabilityPolicy(projectDir);
    expect(loaded.problems).toEqual([]);
    const known = { extensions: new Set(["real-ext"]), extensionTools: new Set(["real_tool"]), skills: new Set(["real-skill"]) };
    expect(unknownPolicyEntries(loaded, projectDir, () => known)).toEqual([
      `${globalFile()}: policy.tools.deny entry "nosuchtool" names no known tool`,
      `${globalFile()}: policy.skills.allow entry "ghost-skill" names no known skill`,
      `${projectFile()}: policy.tools.allow entry "ext:ghost-ext/x" names no known tool`,
      `${projectFile()}: policy.extensions.deny entry "ghost-ext" names no known extension`,
    ]);
  });

  it("does not judge extension entries when no extension was discovered", () => {
    writeGlobal({ policy: { tools: { deny: ["nosuchtool", "ext:a"] }, extensions: { deny: ["a"] } } });
    const loaded = loadCapabilityPolicy(projectDir);
    expect(unknownPolicyEntries(loaded, projectDir, () => ({ skills: new Set() }))).toEqual([]);
  });

  it("warns and still runs the spawn when an entry names nothing known", async () => {
    writeGlobal({ policy: { tools: { deny: ["nosuchtool"] }, extensions: { deny: ["ghost-ext"] }, skills: { deny: ["ghost-skill"] } } });
    const faux = registerFauxProvider({ provider: "faux", models: [{ id: "faux-1", contextWindow: 200_000 }] });
    try {
      registerAgents(
        new Map([
          [
            "warn-probe",
            {
              name: "warn-probe",
              description: "warn-probe",
              builtinToolNames: ["read"],
              extensions: true,
              skills: false,
              systemPrompt: "You are a probe.",
              promptMode: "replace",
              inheritContext: false,
              runInBackground: false,
              isolated: false,
            } as AgentConfig,
          ],
        ]),
      );
      const model = faux.getModel();
      const modelRegistry: any = {
        find: () => model,
        getAll: () => [model],
        getAvailable: () => [model],
        hasConfiguredAuth: () => true,
        isUsingOAuth: () => false,
        getApiKeyAndHeaders: async () => ({ apiKey: "faux", headers: {} }),
        registerProvider: () => {},
        unregisterProvider: () => {},
      };
      const ctx: any = { cwd: projectDir, getSystemPrompt: () => "PARENT", model, modelRegistry };
      const activity: string[] = [];
      let created = false;
      await runAgent(ctx, "warn-probe", "go", {
        pi: { exec: async () => ({ code: 1, stdout: "", stderr: "" }) } as any,
        capability: registeredCapability("warn-probe"),
        model,
        onToolActivity: a => activity.push(a.toolName ?? ""),
        onSessionCreated: () => {
          created = true;
        },
      }).catch(() => {});
      expect(created).toBe(true);
      const warnings = activity.filter(name => name.startsWith("policy-warning:"));
      expect(warnings).toContain(`policy-warning:${globalFile()}: policy.tools.deny entry "nosuchtool" names no known tool`);
      expect(warnings).toContain(`policy-warning:${globalFile()}: policy.extensions.deny entry "ghost-ext" names no known extension`);
      expect(warnings).toContain(`policy-warning:${globalFile()}: policy.skills.deny entry "ghost-skill" names no known skill`);
    } finally {
      faux.unregister();
    }
  });

  it("carries the policy in the ping reply", async () => {
    writeGlobal({ policy: { tools: { allow: ["read"] } } });
    const handlers = new Map<string, (raw: unknown) => unknown>();
    const replies: Array<{ channel: string; data: any }> = [];
    const events = {
      on: (channel: string, fn: (raw: unknown) => unknown) => {
        handlers.set(channel, fn);
        return () => {};
      },
      emit: (channel: string, data: unknown) => replies.push({ channel, data }),
    };
    registerRpcHandlers({
      events,
      pi: {},
      getCtx: () => ({ cwd: projectDir }),
      manager: {},
    } as unknown as Parameters<typeof registerRpcHandlers>[0]);
    await handlers.get("subagents:rpc:ping")?.({ requestId: "r1" });
    const reply = replies.find(r => r.channel === "subagents:rpc:ping:reply:r1");
    expect(reply?.data.data.version).toBe(2);
    expect(reply?.data.data.policy).toEqual(policyEventPayload(projectDir));
    expect(reply?.data.data.policy.global).toEqual({ tools: { allow: ["read"] } });
  });
});
