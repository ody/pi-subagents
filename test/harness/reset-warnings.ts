import { afterEach } from "vitest";
import { setWarningSink } from "../../src/warnings.js";

afterEach(() => {
  setWarningSink(undefined);
});
