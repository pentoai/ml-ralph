/** Every example event in the ralph-log-events skill passes validation, and none shows a stale status */

import { describe, expect, test } from "bun:test";
import { validateLogEvent } from "../../domain/validation/log-event.ts";

const skill = await Bun.file(
  new URL("../../../.claude/skills/ralph-log-events/SKILL.md", import.meta.url),
).text();

const examples = [...skill.matchAll(/```jsonl\n([\s\S]*?)```/g)]
  .flatMap((m) => (m[1] ?? "").split("\n"))
  .filter((l) => l.trim());

describe("ralph-log-events skill", () => {
  test("has example events", () => {
    expect(examples.length).toBeGreaterThan(10);
  });

  test("has no `status complete` example", () => {
    expect(skill).not.toMatch(/"status":"complete"/);
    expect(skill).not.toContain("evidence if complete");
  });

  test.each(examples)("example passes validation: %s", (line) => {
    const { ts: _ts, type, ...body } = JSON.parse(line);
    const result = validateLogEvent(type, body);
    expect(result.errors).toEqual([]);
    expect(result.valid).toBe(true);
  });
});
