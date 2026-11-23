import { afterEach } from "vitest";
import { resetWarnings } from "../../src/warnings.js";

afterEach(() => {
  resetWarnings();
});
