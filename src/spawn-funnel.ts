// Trust boundary for programmatic spawns: every spawn that did not come from
// the Agent tool — cross-extension RPC, `@handle` mentions, and the manager
// registry — resolves its type and sanitizes its options here.

import type { AgentManager } from "./agent-manager.js";
import { resolveSpawnType } from "./agent-types.js";
import { resolveEffectiveMaxTurns } from "./runner-defaults.js";
import type { AgentConfig, AgentRecord } from "./types.js";

export interface SpawnFunnelDeps {
  manager: Pick<AgentManager, "spawn" | "getRecord" | "resolveMention">;
  reloadCustomAgents: (strict?: boolean) => void;
}

export interface SpawnFunnel {
  spawnResolved: (piRef: any, ctxRef: any, type: string, prompt: string, options: any) => string;
  spawnTopLevel: (piRef: any, ctxRef: any, type: string, prompt: string, options: any) => string;
  resolveAgentRef: (ref: string) => AgentRecord | undefined;
}

export function createSpawnFunnel(deps: SpawnFunnelDeps): SpawnFunnel {
  const { manager, reloadCustomAgents } = deps;

  // Process-external callers may supply arbitrary options. Nested ownership and
  // config-root metadata are internal capabilities issued only by scoped tools.
  /**
   * Resolve the agent type and spawn. Trusts its options — every caller must
   * either be in-process or have gone through `spawnTopLevel` first.
   */
  const spawnResolved = (piRef: any, ctxRef: any, type: string, prompt: string, options: any) => {
    // An inline definition is the caller's whole agent: there is no type to
    // resolve, and the fallback below would hand it general-purpose instead.
    const inline: AgentConfig | undefined = options?.agentConfig;
    if (inline) {
      return manager.spawn(piRef, ctxRef, type, prompt, {
        ...options,
        maxTurns: resolveEffectiveMaxTurns(type, options.maxTurns, inline),
      });
    }
    // Cross-extension callers get the same dispatch contract as the LLM (#183).
    // The RPC layer already throws for an unresolvable model rather than falling
    // back silently; a bad agent type should not be quieter. Throws become error
    // envelopes at the RPC boundary. Reload first so an agent file added mid
    // session is spawnable here too, not only through the Agent tool.
    reloadCustomAgents();
    const dispatch = resolveSpawnType(type);
    if (!dispatch.ok) throw new Error(dispatch.message);
    // Every programmatic spawn lands here — cross-extension RPC, both `@handle`
    // mention paths, and the `Symbol.for("pi-subagents:manager")` registry — and
    // none came through the Agent tool, which is where the UI activity tracker is
    // otherwise created. Without one the widget and FleetView have no tool name
    // and no turn count, so the row reads `thinking…` for the agent's whole life
    // while the header's tool-use count climbs beside it (#181). Double-tracking
    // is not possible: the Agent tool calls `manager.spawn` directly. The tracker
    // callbacks are the funnel's own — a caller's are not honoured, since a
    // half-wired tracker renders worse than none.
    //
    // The turn limit is resolved rather than read off `options`, which a mention
    // spawn deliberately omits so the agent's own config can decide: a tracker
    // built with `undefined` renders `↻3` where the Agent tool renders `↻3≤20`.
    // Like the tool's own, it is a prediction — editing the agent file mid-run
    // leaves the displayed ceiling stale.
    // Repaints are left to the manager's `onStart` callback, which already starts
    // the widget/fleet timers for agents that enter this way.
    return manager.spawn(piRef, ctxRef, dispatch.type, prompt, {
      ...options,
      maxTurns: options?.maxTurns ?? resolveEffectiveMaxTurns(dispatch.type, options?.maxTurns),
    });
  };

  const spawnTopLevel = (piRef: any, ctxRef: any, type: string, prompt: string, options: any) => {
    const safeOptions = { ...(options ?? {}) };
    delete safeOptions.parentAgentId;
    delete safeOptions.depth;
    delete safeOptions.maxSubagentDepth;
    delete safeOptions.configCwd;
    // Also internal: it names a transcript directory, so a forged value would
    // be a path-traversal primitive.
    delete safeOptions.rootSessionId;
    // Worse than rootSessionId: this one names a file to OPEN and replay as a
    // conversation. Only the mention dispatcher may set it, and only from a
    // path this extension itself recorded — never from anything a caller sent.
    delete safeOptions.resumeSessionFile;
    // Bypasses handle allocation, so a forged value would duplicate a live
    // agent's name and make `@handle` ambiguous. Same rule: dispatcher only.
    delete safeOptions.reclaim;
    // Every spawn through here is DETACHED — the caller gets an id back and
    // awaits nothing. A forged `blocking` would charge it to the foreground
    // pool and could defer it behind a queue whose gate nobody is holding.
    delete safeOptions.blocking;
    return spawnResolved(piRef, ctxRef, type, prompt, safeOptions);
  };

  /**
   * Resolve a tool's `agent_id` as an id OR a handle, so the model addresses
   * agents by the same names the user types. Ids are tried first, keeping the
   * existing behaviour exact — a handle is only consulted when the string is
   * not an id at all. Only live records: a tombstone has nothing to steer and
   * no result to read. Callers still enforce the nested-ownership rejection.
   */
  const resolveAgentRef = (ref: string): AgentRecord | undefined => {
    const byId = manager.getRecord(ref);
    if (byId) return byId;
    const resolved = manager.resolveMention(ref);
    return resolved?.kind === "live" ? resolved.record : undefined;
  };

  return { spawnResolved, spawnTopLevel, resolveAgentRef };
}
