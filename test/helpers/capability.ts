import { getAgentConfig } from "../../src/agents/agent-types.js";
import {
  type CapabilityDeclaration,
  checkCapabilityPolicy,
  type GrantedCapability,
} from "../../src/config/capability-policy.js";
import type { LoadedPolicy } from "../../src/config/capability-policy-config.js";
import { AgentManager } from "../../src/manager/agent-manager.js";

const OPEN_POLICY: LoadedPolicy = { global: {}, project: {}, ephemeralNesting: true, problems: [] };

export function grant(
  config: Partial<CapabilityDeclaration> = {},
  options: { isolated?: boolean; policy?: LoadedPolicy } = {},
): GrantedCapability {
  const verdict = checkCapabilityPolicy({
    config: { extensions: true, skills: true, ...config },
    callerSupplied: new Set(),
    ephemeral: false,
    cwd: process.cwd(),
    isolated: options.isolated,
    policy: options.policy ?? OPEN_POLICY,
  });
  if (verdict.kind !== "ok") throw new Error(verdict.message);
  return verdict;
}

export function registeredCapability(type: string, isolated?: boolean): GrantedCapability {
  return grant(getAgentConfig(type) ?? {}, { isolated });
}

export class GrantingAgentManager extends AgentManager {
  override spawn(...args: Parameters<AgentManager["spawn"]>): ReturnType<AgentManager["spawn"]> {
    const [pi, ctx, type, prompt, options] = args;
    return super.spawn(pi, ctx, type, prompt, { capability: grant(), ...options });
  }

  override spawnAndWait(...args: Parameters<AgentManager["spawnAndWait"]>): ReturnType<AgentManager["spawnAndWait"]> {
    const [pi, ctx, type, prompt, options, onSpawned] = args;
    return super.spawnAndWait(pi, ctx, type, prompt, { capability: grant(), ...options }, onSpawned);
  }
}
