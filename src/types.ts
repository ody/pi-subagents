import type { ThinkingLevel } from "@earendil-works/pi-ai";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type { LifetimeUsage, SessionLike } from "./usage.js";

export type { ThinkingLevel };

export type SubagentType = string;

export const DEFAULT_AGENT_NAMES = ["general-purpose", "Explore", "Plan"] as const;

export type IsolationMode = "worktree" | "off";

export interface AgentConfig {
  name: string;
  displayName?: string;
  color?: string;
  description: string;
  builtinToolNames?: string[];
  extSelectors?: string[];
  disallowedTools?: string[];
  extensions: true | string[] | false;
  excludeExtensions?: string[];
  skills: true | string[] | false;
  model?: string;
  thinking?: ThinkingLevel;
  maxTurns?: number;
  persistSession?: boolean;
  outputTranscript?: boolean;
  sessionDir?: string;
  allowedSubagents?: "all" | string[];
  systemPrompt: string;
  promptMode: "replace" | "append";
  inheritContext?: boolean;
  runInBackground?: boolean;
  isolated?: boolean;
  isolation?: IsolationMode;
  isDefault?: boolean;
  enabled?: boolean;
  source?: "default" | "project" | "global" | "skill";
  sourcePath?: string;
}

export type JoinMode = 'async' | 'group' | 'smart';

export type WidgetMode = 'all' | 'background' | 'off';

export type ViewerMarkdownMode = 'off' | 'assistant' | 'all';

export interface AgentActivity {
  activeTools: Map<string, string>;
  toolUses: number;
  responseText: string;
  session?: SessionLike;
  turnCount: number;
  maxTurns?: number;
}

export type AgentMentionMode = 'model' | 'direct' | 'off';

export interface AgentTombstone {
  handle: string;
  alias?: string;
  id: string;
  type: SubagentType;
  description: string;
  sessionFile: string;
  completedAt: number;
}

export type MentionResolution =
  | { kind: "live"; record: AgentRecord }
  | { kind: "tombstone"; entry: AgentTombstone };

export interface AgentRecord {
  id: string;
  type: SubagentType;
  handle?: string;
  alias?: string;
  description: string;
  status: "queued" | "running" | "completed" | "steered" | "aborted" | "stopped" | "error";
  result?: string;
  error?: string;
  stoppedBy?: "user" | "agent";
  settled?: boolean;
  pool?: "background" | "foreground";
  toolUses: number;
  startedAt: number;
  completedAt?: number;
  session?: AgentSession;
  abortController?: AbortController;
  promise?: Promise<string>;
  blocking?: boolean;
  startGate?: Promise<void>;
  groupId?: string;
  joinMode?: JoinMode;
  resultConsumed?: boolean;
  pendingSteers?: string[];
  worktree?: { path: string; branch: string; baseSha: string; workPath: string };
  worktreeResult?: { hasChanges: boolean; branch?: string };
  toolCallId?: string;
  outputFile?: string;
  sessionFile?: string;
  outputCleanup?: () => void;
  lifetimeUsage: LifetimeUsage;
  compactionCount: number;
  isBackground?: boolean;
  invocation?: AgentInvocation;
  depth?: number;
  parentAgentId?: string;
  maxSubagentDepth?: number;
  rootSessionId?: string;
}

export type EffectiveThinkingLevel = ThinkingLevel | "off";

export interface AgentInvocation {
  modelName?: string;
  modelId?: string;
  thinking?: EffectiveThinkingLevel;
  requestedThinking?: EffectiveThinkingLevel;
  pinnedModel?: string;
  pinnedThinking?: EffectiveThinkingLevel;
  pinnedMaxTurns?: number;
  pinnedRunInBackground?: boolean;
  maxTurns?: number;
  isolated?: boolean;
  inheritContext?: boolean;
  runInBackground?: boolean;
  isolation?: IsolationMode;
}

export interface NotificationDetails {
  id: string;
  description: string;
  status: string;
  toolUses: number;
  turnCount: number;
  maxTurns?: number;
  totalTokens: number;
  totalCost?: number;
  durationMs: number;
  outputFile?: string;
  error?: string;
  resultPreview: string;
  others?: NotificationDetails[];
}

export interface EnvInfo {
  isGitRepo: boolean;
  branch: string;
  platform: string;
}

export interface ScheduledSubagent {
  version?: 2;
  id: string;
  name: string;
  description: string;
  schedule: string;
  scheduleType: "cron" | "once" | "interval";
  intervalMs?: number;

  subagent_type: SubagentType;
  prompt: string;
  model?: string;
  thinking?: ThinkingLevel;
  max_turns?: number;
  run_in_background?: boolean;
  isolated?: boolean;
  isolation?: IsolationMode;

  enabled: boolean;
  createdAt: string;
  lastRun?: string;
  lastStatus?: "success" | "error" | "running";
  nextRun?: string;
  runCount: number;
}

export interface ScheduleStoreData {
  version: 2;
  jobs: ScheduledSubagent[];
}
