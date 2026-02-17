import { describe, expect, test } from "bun:test";
import {
  EVENT_STYLES,
  formatLogActivity,
  sanitizeLogText,
} from "./log-event-formatter.ts";

describe("log event formatter", () => {
  test("sanitizes ansi/control chars and normalizes whitespace", () => {
    const input = "A\u001b[31mB\u001b[0m\n\tC\u0007";
    expect(sanitizeLogText(input)).toBe("AB C");
  });

  test("normalizes Unicode punctuation to ASCII-safe text", () => {
    const input = "A — B → C … ≤ 5 ✓";
    expect(sanitizeLogText(input)).toBe("A - B -> C ... <= 5 +");
  });

  test("path_analysis content is flattened to a single line", () => {
    const activity = formatLogActivity(
      {
        ts: "2026-02-09T00:00:00.000Z",
        type: "path_analysis",
        chosen: "P1",
        rationale: "best",
        paths: [
          { id: "P1", description: "a" },
          { id: "P2", description: "b" },
        ],
      } as never,
      0,
    );

    expect(activity.content.includes("\n")).toBe(false);
    expect(activity.content).toContain("Paths:");
  });

  test("uses ASCII icon for high-volume log events", () => {
    expect(EVENT_STYLES.learning?.icon).toBe(">");
    expect(EVENT_STYLES.thinking?.icon).toBe(".");
  });
});
