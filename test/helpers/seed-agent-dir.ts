import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll } from "vitest";

const agentDir = mkdtempSync(join(tmpdir(), "pi-seed-agentdir-"));
mkdirSync(join(agentDir, "agents"), { recursive: true });
writeFileSync(
  join(agentDir, "agents", "general-purpose.md"),
  "---\ndescription: General purpose\n---\n\nYou are general-purpose.",
);
process.env.PI_CODING_AGENT_DIR = agentDir;

afterAll(() => {
  rmSync(agentDir, { recursive: true, force: true });
});
