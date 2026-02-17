import { describe, expect, test } from "bun:test";
import { __testing } from "./tmux-pane.tsx";

describe("TmuxPane sanitization", () => {
  test("strips ANSI color sequences", () => {
    const line = "\u001b[31mError\u001b[0m plain";
    expect(__testing.sanitizeTerminalLine(line)).toBe("Error plain");
  });

  test("strips OSC hyperlinks and control chars", () => {
    const line = "A\u001b]8;;https://example.com\u0007B\u001b]8;;\u0007C\u0008";
    expect(__testing.sanitizeTerminalLine(line)).toBe("ABC");
  });
});
