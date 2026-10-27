/**
 * Tests for the run stop notice
 */

import { describe, expect, test } from "bun:test";
import { runStopNotice } from "./run-notice.ts";

describe("runStopNotice", () => {
  test.each([
    "max_iterations",
    "contract_changed",
    "holdout_access",
    "budget_exhausted",
  ] as const)("names the reason %s", (reason) => {
    expect(runStopNotice(reason)).toContain(`reason ${reason}`);
  });

  test("the holdout notice never carries a path", () => {
    expect(runStopNotice("holdout_access")).not.toContain("/");
  });
});
