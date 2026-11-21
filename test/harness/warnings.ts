import { vi } from "vitest";
import { setWarningSink } from "../../src/warnings.js";

export function captureWarnings() {
  const sink = vi.fn<(message: string) => void>();
  setWarningSink(sink);
  return sink;
}
