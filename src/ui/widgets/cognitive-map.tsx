/**
 * Cognitive Map — visualizes Ralph's thinking process
 *
 * Shows:
 *   1. Phase cycle (horizontal) — UND ─ STR ─ EXE ─ REF
 *   2. Hypothesis tree with experiments and decisions
 *   3. Latest insight
 *
 * Text is sanitized to printable ASCII for stable terminal rendering.
 */

import { useMemo } from "react";
import type { RalphEvent } from "../../infrastructure/ralph/templates.ts";
import { Box, Text } from "../ink.tsx";
import { colors } from "../theme/colors.ts";
import { sanitizeLogText } from "./log-event-formatter.ts";

// ── Types ──────────────────────────────────────────────────────────

interface ExperimentData {
  name: string;
  score: number | null;
  metricKey: string | null;
}

interface HypothesisState {
  id: string;
  text: string;
  status: "active" | "kept" | "rejected" | "iterating" | "pivoted";
  experiments: ExperimentData[];
}

interface CognitiveState {
  currentPhase: string | null;
  cycleCount: number;
  retreatCount: number;
  hypotheses: HypothesisState[];
  bestScore: number;
  latestInsight: string | null;
}

// ── Data extraction ────────────────────────────────────────────────

const PHASES = ["UNDERSTAND", "STRATEGIZE", "EXECUTE", "REFLECT"] as const;
const PHASE_ABBR: Record<string, string> = {
  UNDERSTAND: "UND",
  STRATEGIZE: "STR",
  EXECUTE: "EXE",
  REFLECT: "REF",
};

function extractScoreWithKey(
  metrics: Record<string, unknown>,
): { score: number; key: string } | null {
  const preferred = [
    "cv_score",
    "cv_score_validated",
    "auc_roc",
    "auc",
    "f1",
    "accuracy",
    "baseline_score",
    "score",
  ];
  for (const key of preferred) {
    const val = metrics[key];
    if (typeof val === "number" && isFinite(val)) return { score: val, key };
  }
  for (const [key, val] of Object.entries(metrics)) {
    if (typeof val === "number" && isFinite(val)) return { score: val, key };
  }
  return null;
}

function shortMetricKey(key: string): string {
  const map: Record<string, string> = {
    cv_score: "cv",
    cv_score_validated: "cv",
    auc_roc: "auc",
    baseline_score: "base",
    accuracy: "acc",
  };
  return map[key] ?? key.slice(0, 4);
}

const KEPT_ACTIONS = new Set([
  "keep",
  "conclude",
  "complete",
  "validate_and_submit",
]);
const REJECTED_ACTIONS = new Set(["reject", "block", "abandon"]);
const ITERATE_ACTIONS = new Set(["iterate", "retry", "inconclusive"]);
const PIVOT_ACTIONS = new Set(["pivot", "defer", "strategic_retreat"]);

function classifyAction(action: string): HypothesisState["status"] {
  const a = action.toLowerCase();
  if (KEPT_ACTIONS.has(a)) return "kept";
  if (REJECTED_ACTIONS.has(a)) return "rejected";
  if (ITERATE_ACTIONS.has(a)) return "iterating";
  if (PIVOT_ACTIONS.has(a)) return "pivoted";
  return "active";
}

function extractCognitiveState(logEvents: RalphEvent[]): CognitiveState {
  const hypotheses = new Map<string, HypothesisState>();
  let currentPhase: string | null = null;
  let cycleCount = 0;
  let retreatCount = 0;
  let bestScore = 0;
  let latestInsight: string | null = null;
  let lastPhaseIndex = -1;

  for (const event of logEvents) {
    const e = event as unknown as Record<string, unknown>;

    switch (event.type) {
      case "phase": {
        const phase = String(e.phase ?? "");
        const phaseIndex = PHASES.indexOf(phase as (typeof PHASES)[number]);
        if (phaseIndex >= 0) {
          if (phase === "UNDERSTAND" && lastPhaseIndex >= 0) {
            cycleCount++;
          }
          currentPhase = phase;
          lastPhaseIndex = phaseIndex;
        }
        break;
      }
      case "strategic_retreat":
        retreatCount++;
        break;
      case "hypothesis": {
        const id = String(e.id ?? "?");
        hypotheses.set(id, {
          id,
          text: String(e.hypothesis ?? ""),
          status: "active",
          experiments: [],
        });
        break;
      }
      case "experiment": {
        const hId = String(e.hypothesis_id ?? "");
        let h = hypotheses.get(hId);
        if (!h && hId) {
          h = { id: hId, text: "", status: "active", experiments: [] };
          hypotheses.set(hId, h);
        }
        const metrics = (e.metrics ?? {}) as Record<string, unknown>;
        const result = extractScoreWithKey(metrics);
        if (h) {
          const name = String(e.name ?? "?");
          const existing = h.experiments.find((x) => x.name === name);
          if (!existing) {
            h.experiments.push({
              name,
              score: result?.score ?? null,
              metricKey: result ? shortMetricKey(result.key) : null,
            });
          } else if (
            result &&
            (existing.score === null || result.score > existing.score)
          ) {
            existing.score = result.score;
            existing.metricKey = shortMetricKey(result.key);
          }
        }
        if (result && result.score > bestScore) bestScore = result.score;
        break;
      }
      case "decision": {
        const h = hypotheses.get(String(e.hypothesis_id ?? ""));
        if (h) {
          const action = String(e.action ?? "");
          const newStatus = classifyAction(action);
          if (newStatus !== "active") h.status = newStatus;
        }
        break;
      }
      case "learning":
        latestInsight = String(e.insight ?? "");
        break;
    }
  }

  if (currentPhase && cycleCount === 0) cycleCount = 1;

  return {
    currentPhase,
    cycleCount,
    retreatCount,
    hypotheses: Array.from(hypotheses.values()),
    bestScore,
    latestInsight,
  };
}

// ── Phase Indicator ─────────────────────────────────────────────────

const PHASE_COLORS: Record<string, string> = {
  UNDERSTAND: colors.accentBlue,
  STRATEGIZE: colors.accentPurple,
  EXECUTE: colors.accentGreen,
  REFLECT: colors.accentYellow,
};

function formatPhaseLine(
  currentPhase: string | null,
  cycleCount: number,
  retreatCount: number,
): string {
  const parts = PHASES.map((phase) => {
    const abbr = PHASE_ABBR[phase] || phase.slice(0, 3);
    return `${phase === currentPhase ? "*" : "o"} ${abbr}`;
  });
  const suffix = retreatCount > 0 ? `  c${cycleCount} r${retreatCount}` : `  c${cycleCount}`;
  return `${parts.join(" - ")}${suffix}`;
}

// ── Hypothesis Tree ─────────────────────────────────────────────────

const STATUS_ICONS: Record<string, { icon: string; color: string }> = {
  active: { icon: "o", color: colors.accentBlue },
  kept: { icon: "+", color: colors.accentGreen },
  rejected: { icon: "x", color: colors.accentRed },
  iterating: { icon: "~", color: colors.accentYellow },
  pivoted: { icon: ">", color: colors.accentPurple },
};

interface RenderLine {
  bold?: boolean;
  color: string;
  id: string;
  text: string;
}

function buildHypothesisLines({
  hypotheses,
  bestScore,
}: {
  hypotheses: HypothesisState[];
  bestScore: number;
}): RenderLine[] {
  if (hypotheses.length === 0) return [];

  const MAX_DISPLAY = 5;
  const hidden = Math.max(0, hypotheses.length - MAX_DISPLAY);
  const recent = hypotheses.slice(-MAX_DISPLAY);
  const lines: RenderLine[] = [];

  if (hidden > 0) {
    lines.push({
      id: "h-hidden",
      text: `... ${hidden} earlier hypothesis${hidden > 1 ? "es" : ""}`,
      color: colors.textMuted,
    });
  }

  for (let idx = 0; idx < recent.length; idx++) {
    const h = recent[idx]!;
    const si = STATUS_ICONS[h.status] ?? STATUS_ICONS.active;
    const isLast = idx === recent.length - 1;
    const connector = isLast ? "\\" : "|";

    // Show just ID — full hypothesis text is in the activity feed
    lines.push({
      id: `h-${h.id}`,
      text: `${connector} ${si.icon} ${h.id}`,
      color: si.color,
      bold: true,
    });

    for (let ei = 0; ei < h.experiments.length; ei++) {
      const exp = h.experiments[ei]!;
      const isBest =
        exp.score !== null && exp.score === bestScore && bestScore > 0;
      const innerPrefix = isLast ? "  " : "| ";
      const expConn = ei === h.experiments.length - 1 ? "\\" : "|";
      lines.push({
        id: `e-${h.id}-${ei}`,
        text:
          `${innerPrefix}${expConn} ${sanitizeLogText(exp.name)}` +
          (exp.metricKey ? ` ${exp.metricKey}` : "") +
          (exp.score !== null ? ` ${exp.score.toFixed(3)}` : "") +
          (isBest ? " *" : ""),
        color: isBest ? colors.accentGreen : colors.textMuted,
      });
    }
  }

  return lines;
}

// ── Main Component ─────────────────────────────────────────────────

interface CognitiveMapProps {
  logEvents: RalphEvent[];
}

export function CognitiveMap({ logEvents }: CognitiveMapProps) {
  const state = useMemo(() => extractCognitiveState(logEvents), [logEvents]);
  if (!state.currentPhase && state.hypotheses.length === 0) return null;

  const lines: RenderLine[] = [];

  if (state.currentPhase) {
    lines.push({
      id: "phase",
      text: sanitizeLogText(
        formatPhaseLine(
          state.currentPhase,
          state.cycleCount,
          state.retreatCount,
        ),
      ),
      color: PHASE_COLORS[state.currentPhase] || colors.textMuted,
      bold: true,
    });
  }

  lines.push(
    ...buildHypothesisLines({
      hypotheses: state.hypotheses,
      bestScore: state.bestScore,
    }),
  );

  if (state.latestInsight) {
    lines.push({
      id: "insight",
      text: `* ${sanitizeLogText(state.latestInsight)}`,
      color: colors.accentCyan,
      bold: true,
    });
  }

  // Render as a single <Text> with nested colored spans + newlines.
  // Multiple <Text> elements in a column Box overlap in opentui;
  // a single text block with \n avoids the layout bug entirely.
  // Cap height: border (2) + padding (0) + content lines.
  // Allow up to 12 content lines before clipping.
  const MAX_CONTENT_LINES = 12;

  return (
    <Box
      borderStyle="round"
      borderColor={colors.textMuted}
      paddingX={1}
      marginBottom={1}
      maxHeight={MAX_CONTENT_LINES + 2}
      overflow="hidden"
    >
      <Text>
        {lines.map((line, i) => (
          <Text key={line.id} color={line.color} bold={line.bold}>
            {(i > 0 ? "\n" : "") + line.text}
          </Text>
        ))}
      </Text>
    </Box>
  );
}

export const __testing = {
  formatPhaseLine,
  statusIcons: {
    active: STATUS_ICONS.active?.icon,
    kept: STATUS_ICONS.kept?.icon,
    rejected: STATUS_ICONS.rejected?.icon,
  },
};
