import { describe, expect, test } from "bun:test";
import { colors } from "../theme/colors.ts";
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

  test("agent-reported scores are marked with ? and never picked out as best", () => {
    const state = __testing.extractCognitiveState([
      { ts: "t", type: "hypothesis", id: "H-1", hypothesis: "h" },
      {
        ts: "t",
        type: "experiment",
        name: "forged",
        hypothesis_id: "H-1",
        eval_id: "eval-made-up",
        metrics: { auc: 0.999 },
      },
      {
        ts: "t",
        type: "experiment",
        name: "plain",
        hypothesis_id: "H-1",
        metrics: { auc: 0.6 },
      },
    ] as never);
    const lines = __testing.buildHypothesisLines({
      hypotheses: state.hypotheses,
    });
    const experiments = lines.filter((l) => l.id.startsWith("e-"));
    expect(experiments.map((l) => l.text.trim())).toEqual([
      "| forged auc 0.999?",
      "\\ plain auc 0.600?",
    ]);
    for (const line of experiments) {
      expect(line.text).not.toContain("*");
      expect(line.color).not.toBe(colors.accentGreen);
    }
  });
});
