/**
 * Log Event Formatter - converts RalphEvents into Activity items
 * for display in the ActivityFeed.
 */

import type { RalphEvent } from "../../infrastructure/ralph/templates.ts";
import type { Activity } from "./activity-aggregator.ts";

export interface LogEventStyle {
  icon: string;
  color: string;
  /** Events with dim=true render in textMuted instead of their color */
  dim?: boolean;
}

export const EVENT_STYLES: Record<string, LogEventStyle> = {
  phase: { icon: "=", color: "accentPurple" },
  hypothesis: { icon: "*", color: "accentYellow" },
  experiment: { icon: "+", color: "accentGreen" },
  learning: { icon: ">", color: "accentCyan" },
  research: { icon: "R", color: "accentBlue" },
  decision: { icon: "?", color: "accentYellow" },
  thinking: { icon: ".", color: "textMuted", dim: true },
  strategic_retreat: { icon: "!", color: "accentRed" },
  prd_updated: { icon: "P", color: "textMuted", dim: true },
  kanban_updated: { icon: "K", color: "textMuted", dim: true },
  status: { icon: "S", color: "accentGreen" },
  mental_model: { icon: "M", color: "accentCyan" },
  path_analysis: { icon: "/", color: "accentPurple" },
  data_verified: { icon: "V", color: "accentGreen" },
  result_verification: { icon: "T", color: "accentYellow" },
  success_verified: { icon: "$", color: "accentGreen" },
  parallel_start: { icon: ">", color: "accentPurple" },
  parallel_result: { icon: "<", color: "accentGreen" },
  parallel_synthesis: { icon: "&", color: "accentCyan" },
};

const ANSI_SEQUENCE =
  /\u001B(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007]*(?:\u0007|\u001B\\)|[@-Z\\-_])/g;
const CONTROL_CHARS = /[\u0000-\u0008\u000B-\u001A\u001C-\u001F\u007F]/g;

const UNICODE_TO_ASCII: Array<[RegExp, string]> = [
  [/\u00A0/g, " "],
  [/[“”]/g, '"'],
  [/[‘’]/g, "'"],
  [/[—–]/g, "-"],
  [/→/g, "->"],
  [/[↻↺]/g, "~"],
  [/[↰↱]/g, ">"],
  [/[✓✔]/g, "+"],
  [/[✗✕✖]/g, "x"],
  [/≥/g, ">="],
  [/≤/g, "<="],
  [/…/g, "..."],
  [/•/g, "*"],
];

function normalizeUnicodeForTerminal(text: string): string {
  let out = text;
  for (const [pattern, replacement] of UNICODE_TO_ASCII) {
    out = out.replace(pattern, replacement);
  }
  // Keep only printable ASCII to avoid width/color glitches in terminal renderers.
  return out.replace(/[^\x20-\x7E]/g, " ");
}

export function sanitizeLogText(text: string): string {
  return normalizeUnicodeForTerminal(
    text
      .replace(ANSI_SEQUENCE, "")
      .replace(CONTROL_CHARS, "")
      .replace(/\r/g, " ")
      .replace(/\n/g, " ")
      .replace(/\t/g, " "),
  )
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Pick the primary metric from a metrics dict.
 * Prefers cv_score > auc > f1 > first key.
 */
function primaryMetric(metrics: Record<string, unknown>): string {
  const entries = Object.entries(metrics);
  if (entries.length === 0) return "no metrics";

  const preferred = [
    "cv_score",
    "cv_score_validated",
    "auc_roc",
    "auc",
    "f1",
    "accuracy",
  ];
  for (const key of preferred) {
    const val = metrics[key];
    if (typeof val === "number") return `${key} ${val.toFixed(4)}`;
  }

  for (const [k, v] of entries) {
    if (typeof v === "number") return `${k} ${v.toFixed(4)}`;
  }

  return entries[0] ? `${entries[0][0]}=${entries[0][1]}` : "no metrics";
}

/**
 * Format a RalphEvent into a compact single-line string (ASCII-safe).
 */
function formatContent(event: RalphEvent): string {
  try {
    const e = event as unknown as Record<string, unknown>;
    switch (event.type) {
      case "phase":
        return `${e.phase ?? "?"} ${e.summary ?? ""}`;

      case "hypothesis":
        return `${e.id ?? "?"}: ${e.hypothesis ?? ""}`;

      case "experiment": {
        const metrics = (e.metrics ?? {}) as Record<string, unknown>;
        const name = String(e.name || "experiment");
        return `${name} ${primaryMetric(metrics)}`;
      }

      case "learning":
        return String(e.insight ?? "");

      case "research": {
        const source = e.source ? `${e.source}: ` : "";
        if (Array.isArray(e.key_insights) && e.key_insights.length > 0) {
          return `${source}${(e.key_insights as string[]).join("; ")}`;
        }
        return `${source}${e.insight ?? ""}`;
      }

      case "decision": {
        const action = String(e.action ?? "?");
        const tag =
          action === "keep"
            ? "keep"
            : action === "reject"
              ? "reject"
              : action === "iterate"
                ? "iterate"
                : action === "pivot"
                  ? "pivot"
                  : action;
        return `${e.hypothesis_id ?? "?"}: ${tag} - ${e.reason ?? ""}`;
      }

      case "thinking":
        return `${e.subject ?? ""}${e.conclusion ? ` -> ${e.conclusion}` : ""}`;

      case "data_verified": {
        const dataset = String(e.dataset ?? "");
        const issues = Array.isArray(e.issues) ? (e.issues as string[]) : [];
        const action = e.action ? String(e.action) : "";
        if (issues.length > 0) {
          return `${dataset}: ${issues.join("; ")}${action ? ` - ${action}` : ""}`;
        }
        return `${dataset}: all checks passed`;
      }

      case "result_verification":
        return `${e.result ?? "?"}: ${e.conclusion ?? ""}`;

      case "success_verified": {
        const criteria = Array.isArray(e.criteria_met)
          ? (e.criteria_met as string[]).join(", ")
          : "";
        return `${e.conclusion ?? "Success verified"}${criteria ? ` (${criteria})` : ""}`;
      }

      case "strategic_retreat":
        return `${e.trigger ?? ""}${e.action ? ` -> ${e.action}` : ""}`;

      case "prd_updated":
        return `${e.field ?? ""} updated`;

      case "kanban_updated":
        return String(e.changes ?? "");

      case "status": {
        const s = String(e.status ?? "?");
        return s === "complete" ? "COMPLETE" : s;
      }

      case "mental_model":
        return `${e.domain ?? ""}: ${e.belief ?? ""}`;

      case "path_analysis": {
        const paths = Array.isArray(e.paths)
          ? (e.paths as Array<Record<string, string>>)
              .map((p) => `${p.id}: ${p.description}`)
              .join(" | ")
          : "";
        return `chose ${e.chosen ?? "?"}: ${e.rationale ?? ""}${paths ? ` | Paths: ${paths}` : ""}`;
      }

      case "parallel_start": {
        const hypotheses = Array.isArray(e.hypotheses)
          ? (e.hypotheses as string[]).join(", ")
          : "?";
        return `Parallel experiments: ${hypotheses}`;
      }

      case "parallel_result": {
        const metrics = (e.metrics ?? {}) as Record<string, unknown>;
        const agent = String(e.agent ?? "?");
        return `[${agent}] ${e.hypothesis_id ?? "?"}: ${primaryMetric(metrics)}`;
      }

      case "parallel_synthesis":
        return `Winner: ${e.winner ?? "?"} - ${e.reason ?? ""}`;

      default:
        return String(e.type ?? "event");
    }
  } catch {
    return "event";
  }
}

/**
 * Convert a RalphEvent to an Activity for the feed.
 */
export function formatLogActivity(event: RalphEvent, index: number): Activity {
  const style = EVENT_STYLES[event.type] || { icon: ".", color: "textMuted" };
  const content = sanitizeLogText(formatContent(event));
  const parsed = event.ts ? new Date(event.ts).getTime() : NaN;
  const timestamp = Number.isNaN(parsed) ? Date.now() : parsed;

  return {
    id: `log-${index}`,
    type: "log_event",
    status: "success",
    content,
    logEventType: event.type,
    logEventColor: style.color,
    logEventIcon: style.icon,
    logEventDim: style.dim ?? false,
    startedAt: timestamp,
    completedAt: timestamp,
  };
}
