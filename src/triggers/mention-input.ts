import { existsSync } from "node:fs";
import { type ExtensionAPI, type ExtensionContext, SessionManager } from "@earendil-works/pi-coding-agent";
import { getAgentConfig, getAvailableTypes, resolveSpawnType } from "../agents/agent-types.js";
import { getDefaultMaxTurns, normalizeMaxTurns } from "../config/runner-defaults.js";
import type { RuntimeSettings } from "../config/runtime-settings.js";
import type { AgentManager } from "../manager/agent-manager.js";
import type { StartBackgroundResume } from "../manager/background-resume.js";
import { getOutputTranscriptDefault } from "../platform/output-file.js";
import { verifyWorktreeResume } from "../platform/worktree.js";
import type { AgentRecord, AgentTombstone } from "../types.js";
import { describeMention, handleBase, isReservedHandle, parseMention, resolveHandleToType } from "./mention.js";
import { type MentionCloneOptions, runMentionClone } from "./mention-clone.js";
import type { SpawnFunnel } from "./spawn-funnel.js";

export interface MentionInputDeps {
  manager: Pick<AgentManager, "resolveMention" | "steer" | "awaitStartup">;
  settings: Readonly<Pick<RuntimeSettings, "agentMentionMode">>;
  isAgentMentionsEnabled: () => boolean;
  spawnResolved: SpawnFunnel["spawnResolved"];
  spawnTopLevel: SpawnFunnel["spawnTopLevel"];
  startBackgroundResume: StartBackgroundResume;
  reloadCustomAgents: () => void;
  agentTool: MentionCloneOptions["agentTool"];
}

type Mention = NonNullable<ReturnType<typeof parseMention>>;
type Handled = { action: "handled" };

const handled: Handled = { action: "handled" };

async function dispatchLiveMention(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  deps: MentionInputDeps,
  record: AgentRecord,
  mention: Mention,
): Promise<Handled | undefined> {
  const target = `@${record.alias ?? record.handle ?? mention.handle}`;

  if (record.status === "running" || record.status === "queued") {
    deps.manager.steer(record.id, mention.message);
    pi.events.emit("agent:steered", { id: record.id, message: mention.message });
    ctx.ui.notify(`Sent to ${target}`, "info");
    return handled;
  }

  if (record.session) {
    const config = record.agentConfig ?? getAgentConfig(record.type);
    const resumedRecord = await deps.startBackgroundResume(ctx, record, mention.message, {
      outputTranscript: config?.outputTranscript ?? getOutputTranscriptDefault(),
      maxTurns: normalizeMaxTurns(config?.maxTurns ?? getDefaultMaxTurns()),
    });
    ctx.ui.notify(
      resumedRecord ? `Resuming ${target}` : `Could not resume ${target} — it is still running.`,
      resumedRecord ? "info" : "warning",
    );
    return handled;
  }
  return undefined;
}

async function resumeTombstone(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  deps: MentionInputDeps,
  entry: AgentTombstone,
  mention: Mention,
): Promise<Handled> {
  const target = `@${entry.alias ?? entry.handle}`;

  if (!existsSync(entry.sessionFile)) {
    ctx.ui.notify(`Could not resume ${target} — its session file is missing: ${entry.sessionFile}`, "warning");
    return handled;
  }

  const worktreeFailure = await reopenRefusal(pi, entry);
  if (worktreeFailure) {
    ctx.ui.notify(`Could not resume ${target} — ${worktreeFailure}`, "warning");
    return handled;
  }

  let type = entry.type;
  if (!entry.agentConfig) {
    deps.reloadCustomAgents();
    const dispatch = resolveSpawnType(entry.type);
    if (!dispatch.ok) {
      ctx.ui.notify(`Could not resume ${target} — the ${entry.type} agent is no longer available.`, "warning");
      return handled;
    }
    type = dispatch.type;
  }

  try {
    const header = SessionManager.open(entry.sessionFile).getHeader();
    if (!header?.id) throw new Error("Session header has no id");
    if (entry.isolation === "none" && (!header.cwd || !existsSync(header.cwd))) {
      throw new Error("Session working directory is missing");
    }
    const id = deps.spawnResolved(pi, ctx, type, mention.message, {
      description: entry.description,
      reclaim: { handle: entry.handle, alias: entry.alias, result: entry.result },
      resumeSessionFile: entry.sessionFile,
      sessionId: header.id,
      isBackground: true,
      ...(entry.worktree ? { cwd: entry.worktree.cwd, resumeWorktree: entry.worktree } : { cwd: header.cwd }),
      ...(entry.agentConfig && { agentConfig: entry.agentConfig, ephemeral: { handleSeed: entry.handle } }),
    });
    await deps.manager.awaitStartup(id);
    ctx.ui.notify(`Resuming ${target}`, "info");
  } catch (err) {
    ctx.ui.notify(
      `Could not resume ${target}: ${err instanceof Error ? err.message : String(err)}`,
      "warning",
    );
  }
  return handled;
}

async function reopenRefusal(pi: ExtensionAPI, entry: AgentTombstone): Promise<string | undefined> {
  if (entry.cleanupPending) return "its worktree cleanup may not have finished";
  if (entry.isolation !== "worktree" && entry.worktree) return "its isolation state is inconsistent";
  if (entry.isolation === "none") return undefined;
  if (entry.isolation !== "worktree") return "its isolation state is unknown";
  if (!entry.worktree) return "its saved worktree state is invalid";
  return verifyWorktreeResume(pi, entry.worktree);
}

function startViaClone(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  deps: MentionInputDeps,
  type: string,
  mention: Mention,
): void {
  const label = `@${handleBase(type)}`;
  ctx.ui.notify(`Prompting ${label}…`, "info");
  void runMentionClone({ ctx, type, message: mention.message, agentTool: deps.agentTool })
    .then(async (result) => {
      if (result.spawned) return;
      if (result.refusal) {
        ctx.ui.notify(`Could not start ${label}: ${result.refusal}`, "warning");
        return;
      }
      try {
        const id = deps.spawnTopLevel(pi, ctx, type, mention.message, {
          description: describeMention(mention.message),
          isBackground: true,
        });
        await deps.manager.awaitStartup(id);
        ctx.ui.notify(`Started ${label} directly — ${result.error}`, "warning");
      } catch (err) {
        ctx.ui.notify(
          `Could not start ${label}: ${err instanceof Error ? err.message : String(err)}`,
          "error",
        );
      }
    });
}

async function startMentionedType(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  deps: MentionInputDeps,
  type: string,
  mention: Mention,
): Promise<Handled> {
  if (deps.settings.agentMentionMode === "model") {
    startViaClone(pi, ctx, deps, type, mention);
    return handled;
  }

  try {
    const id = deps.spawnTopLevel(pi, ctx, type, mention.message, {
      description: describeMention(mention.message),
      isBackground: true,
    });
    await deps.manager.awaitStartup(id);
    ctx.ui.notify(`Started @${handleBase(type)}`, "info");
  } catch (err) {
    ctx.ui.notify(`Could not start @${handleBase(type)}: ${err instanceof Error ? err.message : String(err)}`, "error");
  }
  return handled;
}

export function registerMentionInput(pi: ExtensionAPI, deps: MentionInputDeps): void {
  const { settings, isAgentMentionsEnabled } = deps;

  pi.on("input", async (event, ctx) => {
    if (event.source === "extension" || !isAgentMentionsEnabled()) return { action: "continue" };
    const canDispatchDirectly = ctx.mode === "tui";
    if (!canDispatchDirectly && settings.agentMentionMode !== "model") return { action: "continue" };

    const mention = parseMention(event.text);
    if (!mention) return { action: "continue" };

    if (isReservedHandle(mention.handle)) {
      return { action: "transform", text: mention.message, ...(event.images && { images: event.images }) };
    }

    return dispatchMention(pi, ctx, deps, mention, canDispatchDirectly);
  });
}

async function dispatchMention(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  deps: MentionInputDeps,
  mention: Mention,
  canDispatchDirectly: boolean,
) {
  const resolved = deps.manager.resolveMention(mention.handle);

  if (resolved && !canDispatchDirectly) return { action: "continue" as const };

  if (resolved?.kind === "live") {
    const result = await dispatchLiveMention(pi, ctx, deps, resolved.record, mention);
    if (result) return result;
  }

  if (resolved?.kind === "tombstone") return resumeTombstone(pi, ctx, deps, resolved.entry, mention);

  const type = resolveHandleToType(mention.handle, getAvailableTypes());
  if (!type) return { action: "continue" as const };

  return startMentionedType(pi, ctx, deps, type, mention);
}
