import { describe, expect, it } from "vitest";
import { getForegroundOutcomeNote, getStatusNote } from "../../src/tool/status-note.js";

describe("stopped status text names each stop cause", () => {
  const expected = {
    user: "STOPPED BY THE USER",
    agent: "STOPPED BY THE ORCHESTRATING AGENT",
    extension: "STOPPED BY ANOTHER EXTENSION",
    owner: "STOPPED BY ITS OWNING AGENT",
    shutdown: "STOPPED BY THE SESSION SHUTTING DOWN",
  } as const;

  for (const [cause, text] of Object.entries(expected)) {
    it(`${cause}`, () => {
      const note = getStatusNote("stopped", cause as keyof typeof expected);
      const outcome = getForegroundOutcomeNote("stopped", cause as keyof typeof expected);
      expect(note).toContain(text);
      expect(outcome).toContain(text);
      for (const other of Object.values(expected).filter(value => value !== text)) {
        expect(note).not.toContain(other);
        expect(outcome).not.toContain(other);
      }
    });
  }

  it("tells the model not to restart a run the user stopped", () => {
    expect(getStatusNote("stopped", "user")).toContain("do not restart it unless the user asks");
    expect(getForegroundOutcomeNote("stopped", "user")).toContain("do not restart it unless the user asks");
    expect(getStatusNote("stopped", "extension")).not.toContain("do not restart");
  });
});
