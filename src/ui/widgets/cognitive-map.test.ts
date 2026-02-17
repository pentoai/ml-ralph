import { describe, expect, test } from "bun:test";
import { __testing } from "./cognitive-map.tsx";
import { sanitizeLogText } from "./log-event-formatter.ts";

describe("cognitive map rendering", () => {
  test("uses ascii status icons for stable rendering", () => {
    expect(__testing.statusIcons.active).toBe("o");
    expect(__testing.statusIcons.kept).toBe("+");
    expect(__testing.statusIcons.rejected).toBe("x");
  });

  test("phase line avoids non-ascii glyphs", () => {
    const line = __testing.formatPhaseLine("EXECUTE", 1, 0);
    expect(/^[\x20-\x7E]+$/.test(line)).toBe(true);
  });

  test("sanitizes hypothesis text for terminal-stable rendering", () => {
    const line = sanitizeLogText(
      "H-003b—twostage \u001b[31m↻ iterate\u001b[0m",
    );
    expect(line).toBe("H-003b-twostage ~ iterate");
    expect(/^[\x20-\x7E]+$/.test(line)).toBe(true);
  });
});
