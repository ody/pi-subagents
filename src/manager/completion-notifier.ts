import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { RuntimeSettings } from "../config/runtime-settings.js";
import type { AgentRecord, JoinMode, NotificationDetails } from "../types.js";
import type { AgentWidget } from "../ui/agent-widget.js";
import type { FleetList } from "../ui/fleet-list.js";
import type { AgentManager } from "./agent-manager.js";
import { GroupJoinManager } from "./group-join.js";
import { buildNotificationDetails, formatTaskNotification } from "./notification-format.js";

const NUDGE_HOLD_MS = 200;
export const QUEUE_WAIT_POLL_MS = Math.floor(NUDGE_HOLD_MS / 4);

export interface CompletionNotifierDeps {
  pi: Pick<ExtensionAPI, "sendMessage">;
  manager: Pick<AgentManager, "getActivity" | "getRecord">;
  widget: Pick<AgentWidget, "markFinished" | "update">;
  fleet: Pick<FleetList, "onAgentFinished">;
  settings: Readonly<Pick<RuntimeSettings, "showCost">>;
}

export class CompletionNotifier {
  private readonly pi: Pick<ExtensionAPI, "sendMessage">;
  private readonly manager: Pick<AgentManager, "getActivity" | "getRecord">;
  private readonly widget: Pick<AgentWidget, "markFinished" | "update">;
  private readonly fleet: Pick<FleetList, "onAgentFinished">;
  private readonly settings: Readonly<Pick<RuntimeSettings, "showCost">>;
  private readonly pendingNudges = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly groupJoin: GroupJoinManager;
  private currentBatchAgents: { id: string; joinMode: JoinMode }[] = [];
  private batchFinalizeTimer: ReturnType<typeof setTimeout> | undefined;
  private batchCounter = 0;

  constructor(deps: CompletionNotifierDeps) {
    this.pi = deps.pi;
    this.manager = deps.manager;
    this.widget = deps.widget;
    this.fleet = deps.fleet;
    this.settings = deps.settings;

    this.groupJoin = new GroupJoinManager(
      (records, partial) => {
        for (const r of records) { this.widget.markFinished(r.id); this.fleet.onAgentFinished(r.id); }

        const groupKey = `group:${records.map(r => r.id).join(",")}`;
        this.scheduleNudge(groupKey, () => {
          const unconsumed = records.filter(r => !r.resultConsumed);
          if (unconsumed.length === 0) { this.widget.update(); return; }

          const notifications = unconsumed.map(r => formatTaskNotification(r, 300, this.settings.showCost)).join('\n\n');
          const label = partial
            ? `${unconsumed.length} agent(s) finished (partial — others still running)`
            : `${unconsumed.length} agent(s) finished`;

          const [first, ...rest] = unconsumed;
          const details = buildNotificationDetails(first, 300, this.manager.getActivity(first.id));
          if (rest.length > 0) {
            details.others = rest.map(r => buildNotificationDetails(r, 300, this.manager.getActivity(r.id)));
          }

          this.pi.sendMessage<NotificationDetails>({
            customType: "subagent-notification",
            content: `Background agent group completed: ${label}\n\n${notifications}\n\nUse get_subagent_result for full output.`,
            display: true,
            details,
          }, { deliverAs: "followUp", triggerTurn: true });
        });
        this.widget.update();
      },
      30_000,
    );
  }

  onAgentComplete = (record: AgentRecord): void => {
    if (record.resultConsumed) {
      this.widget.markFinished(record.id);
      this.fleet.onAgentFinished(record.id);
      this.widget.update();
      return;
    }

    if (this.currentBatchAgents.some(a => a.id === record.id)) {
      this.widget.update();
      return;
    }

    const result = this.groupJoin.onAgentComplete(record);
    if (result === 'pass') {
      this.sendIndividualNudge(record);
    }
    this.widget.update();
  };

  addToBatch = (id: string, joinMode: JoinMode): void => {
    this.currentBatchAgents.push({ id, joinMode });
    if (this.batchFinalizeTimer) clearTimeout(this.batchFinalizeTimer);
    this.batchFinalizeTimer = setTimeout(() => this.finalizeBatch(), 100);
  };

  cancelNudge = (key: string): void => {
    const timer = this.pendingNudges.get(key);
    if (timer != null) {
      clearTimeout(timer);
      this.pendingNudges.delete(key);
    }
  };

  dispose = (): void => {
    for (const timer of this.pendingNudges.values()) clearTimeout(timer);
    this.pendingNudges.clear();
  };

  private scheduleNudge(key: string, send: () => void, delay = NUDGE_HOLD_MS) {
    this.cancelNudge(key);
    this.pendingNudges.set(key, setTimeout(() => {
      this.pendingNudges.delete(key);
      try { send(); } catch { }
    }, delay));
  }

  private emitIndividualNudge(record: AgentRecord) {
    if (record.resultConsumed) return;

    const notification = formatTaskNotification(record, 500, this.settings.showCost);
    const footer = record.outputFile ? `\nFull transcript available at: ${record.outputFile}` : '';

    this.pi.sendMessage<NotificationDetails>({
      customType: "subagent-notification",
      content: notification + footer,
      display: true,
      details: buildNotificationDetails(record, 500, this.manager.getActivity(record.id)),
    }, { deliverAs: "followUp", triggerTurn: true });
  }

  private sendIndividualNudge(record: AgentRecord) {
    this.widget.markFinished(record.id);
    this.fleet.onAgentFinished(record.id);
    this.scheduleNudge(record.id, () => this.emitIndividualNudge(record));
    this.widget.update();
  }

  private finalizeBatch() {
    this.batchFinalizeTimer = undefined;
    const batchAgents = [...this.currentBatchAgents];
    this.currentBatchAgents = [];

    const smartAgents = batchAgents.filter(a => a.joinMode === 'smart' || a.joinMode === 'group');
    if (smartAgents.length >= 2) {
      const groupId = `batch-${++this.batchCounter}`;
      const ids = smartAgents.map(a => a.id);
      this.groupJoin.registerGroup(groupId, ids);
      for (const id of ids) {
        const record = this.manager.getRecord(id);
        if (!record) continue;
        record.groupId = groupId;
        if (record.completedAt != null && !record.resultConsumed) {
          this.groupJoin.onAgentComplete(record);
        }
      }
    } else {
      for (const { id } of batchAgents) {
        const record = this.manager.getRecord(id);
        if (record?.completedAt != null && !record.resultConsumed) {
          this.sendIndividualNudge(record);
        }
      }
    }
  }
}
