import { describe, expect, test } from "bun:test";
import { __testing } from "./jobs-panel.tsx";

const lines = Array.from({ length: 50 }, (_, i) => `line ${i + 1}`);

describe("jobs panel log scroll", () => {
  test("a 45-row terminal leaves 11 log rows with two jobs", () => {
    expect(__testing.computeLogRows(15, 2, false)).toBe(11);
  });

  test("offset 0 follows the newest lines", () => {
    const w = __testing.windowLog(lines, 11, 0);
    expect(w.shown[0]).toBe("line 40");
    expect(w.shown.at(-1)).toBe("line 50");
  });

  test("scrolling reaches all 50 lines and clamps at both ends", () => {
    expect(__testing.clampLogScroll(999, 50, 11)).toBe(39);
    expect(__testing.clampLogScroll(-3, 50, 11)).toBe(0);
    const top = __testing.windowLog(lines, 11, 999);
    expect(top.shown[0]).toBe("line 1");
    expect(top.shown).toHaveLength(11);
  });

  test("short logs do not scroll", () => {
    expect(__testing.clampLogScroll(5, 3, 11)).toBe(0);
  });
});
