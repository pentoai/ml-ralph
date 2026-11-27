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

const read = (rel: string) => Bun.file(new URL(rel, import.meta.url)).text();
const sources = {
  templates: await read("./templates.ts"),
  "ml-ralph skill": await read("../../../.claude/skills/ml-ralph/SKILL.md"),
  "ralph-file-schemas skill": await read(
    "../../../.claude/skills/ralph-file-schemas/SKILL.md",
  ),
  "ralph-log-events skill": await read(
    "../../../.claude/skills/ralph-log-events/SKILL.md",
  ),
};

describe("stale run-ending guidance", () => {
  for (const [name, text] of Object.entries(sources)) {
    test(`${name} does not teach <project_complete> or status complete`, () => {
      expect(text).not.toContain("project_complete");
      expect(text).not.toMatch(/status"?\s*:\s*\\?"complete/);
      expect(text).not.toMatch(/status complete/i);
    });
  }

  test("RALPH_MD says the runner may refuse a candidate and decides completion", () => {
    expect(RALPH_MD).toMatch(/request: the runner may refuse it/);
    expect(RALPH_MD).toMatch(/runner alone decides promotion/);
  });
});
