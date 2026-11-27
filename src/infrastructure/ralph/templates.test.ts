/**
 * Tests for the agent prompt templates
 */

import { describe, expect, test } from "bun:test";
import { RALPH_MD } from "./templates.ts";

describe("RALPH_MD", () => {
  test("has no agent-team section: parallel work is the runner's workers, not the agent's teams", () => {
    expect(RALPH_MD).not.toMatch(/agent teams?/i);
    expect(RALPH_MD).not.toContain("Parallel Experiments");
    for (const tool of [
      "TeamCreate",
      "TaskCreate",
      "SendMessage",
      "teammate",
    ]) {
      expect(RALPH_MD).not.toContain(tool);
    }
    for (const type of [
      "parallel_start",
      "parallel_result",
      "parallel_synthesis",
    ]) {
      expect(RALPH_MD).not.toContain(type);
    }
  });

  test("still documents the sections around the removed one", () => {
    expect(RALPH_MD).toContain("The Kanban forces you to");
    expect(RALPH_MD).toContain("## Data Verification (MANDATORY");
  });
});
