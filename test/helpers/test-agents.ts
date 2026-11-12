import type { AgentConfig } from "../../src/types.js";

export function testAgent(name: string, overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    name,
    description: `${name} test agent`,
    extensions: true,
    skills: true,
    systemPrompt: `You are ${name}.`,
    promptMode: "replace",
    source: "global",
    ...overrides,
  };
}

export function testAgents(...names: string[]): Map<string, AgentConfig> {
  return new Map(names.map(name => [name, testAgent(name)]));
}
