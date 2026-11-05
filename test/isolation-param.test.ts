import { describe, expect, it } from "vitest";
import { isolationParam } from "../src/tool/invocation-config.js";

describe("isolationParam", () => {
  function schema(enabled: boolean) {
    const built = isolationParam(enabled);
    return built.isolation as { anyOf?: { const?: string }[] } | undefined;
  }

  it("offers a value meaning 'no isolation', not just 'worktree'", () => {
    const values = schema(true)?.anyOf?.map(v => v.const);
    expect(values).toContain("off");
    expect(values).toContain("worktree");
  });

  it("lists the inert value first", () => {
    expect(schema(true)?.anyOf?.[0]?.const).toBe("off");
  });

  it("warns that a worktree cannot see uncommitted work", () => {
    const described = JSON.stringify(schema(true));
    expect(described).toMatch(/uncommitted or staged/);
  });

  it("omits the parameter entirely when the project disabled worktrees", () => {
    expect(isolationParam(false)).toEqual({});
  });
});
