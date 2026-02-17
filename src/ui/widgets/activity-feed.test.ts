import { describe, expect, test } from "bun:test";
import { __testing } from "./activity-feed.tsx";

describe("activity feed", () => {
  test("uses terminal-height budget when maxVisible is not provided", () => {
    expect(__testing.computeVisibleLineBudget(60)).toBe(46);
  });

  test("honors explicit maxVisible override", () => {
    expect(__testing.computeVisibleLineBudget(60, 25)).toBe(25);
  });

  test("computes redraw width from the monitor left-panel geometry", () => {
    expect(__testing.computeTextWidth(120)).toBe(44);
    expect(__testing.computeTextWidth(200)).toBe(76);
  });

  test("pads lines to clear stale glyphs on redraw", () => {
    expect(__testing.padForStableRedraw("abc", 6)).toBe("abc   ");
  });

  test("wraps long log lines into full-text chunks without dropping content", () => {
    const input =
      "The one-class paradigm has a fundamental ceiling for cross-dataset HTTP anomaly detection.";
    const lines = __testing.wrapTextForDisplay(input, 24);

    expect(lines.length).toBeGreaterThan(1);
    expect(lines.join(" ").replace(/\s+/g, " ").trim()).toContain(
      "fundamental ceiling for cross-dataset HTTP anomaly detection.",
    );
    expect(lines.some((line) => line.includes("..."))).toBe(false);
  });
});
