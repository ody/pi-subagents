import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export function globalSettingsPath(): string {
  return join(getAgentDir(), "subagents.json");
}

export function projectSettingsPath(cwd: string): string {
  return join(cwd, ".pi", "subagents.json");
}
