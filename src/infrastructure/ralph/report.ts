/**
 * report.md - the short, auditable record the runner writes when a run ends,
 * built only from its own records: log.jsonl, incumbent.json and metrics.json
 */

import { readEvalMetrics } from "./eval-metrics.ts";
import { readIncumbent } from "./promotion.ts";

/** Why a run ended, as the report states it */
export type ReportEndReason =
  | "run_complete"
  | "budget_exhausted"
  | "max_iterations"
  | "user_quit"
  | "contract_changed"
  | "holdout_access";

export const REPORTS_DIR = ".ml-ralph/reports";
export const NO_PROMOTION_LINE = "no candidate was promoted";
const NOT_SCORED = "not scored";
const MAX_CLAIM_CHARS = 300;
const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

type LogEvent = Record<string, unknown>;

/** The events of log.jsonl; a torn or non-object line is skipped */
export function parseLog(text: string): LogEvent[] {
  const events: LogEvent[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const e: unknown = JSON.parse(line);
      if (typeof e === "object" && e !== null && !Array.isArray(e)) {
        events.push(e as LogEvent);
      }
    } catch {
      // A torn line is not a record
    }
  }
  return events;
}

const oneLine = (value: unknown) => {
  const text = String(value ?? "")
    .replace(/\s+/g, " ")
    .replace(/[[\]]/g, "")
    .trim();
  return text.length > MAX_CLAIM_CHARS
    ? `${text.slice(0, MAX_CLAIM_CHARS - 3)}...`
    : text;
};
const isNumber = (v: unknown): v is number =>
  typeof v === "number" && Number.isFinite(v);

/**
 * One line per finding, each ending in `[eval:<eval_id>]` with an eval_id the
 * runner's own `eval` events know. Scores come from those events; an agent's
 * experiment event only adds its observations, and only when it cites a real eval.
 */
export function buildClaims(events: LogEvent[]): string[] {
  const claims: string[] = [];
  const known = new Set<string>();
  for (const e of events) {
    if (e.type !== "eval" || typeof e.eval_id !== "string") continue;
    known.add(e.eval_id);
    const text =
      e.status === "ok" && isNumber(e.mean)
        ? `Eval of ${oneLine(e.candidate)} scored mean ${e.mean}${isNumber(e.std) ? ` (std ${e.std})` : ""} on the search split`
        : `Eval of ${oneLine(e.candidate)} failed: ${oneLine(e.reason)}`;
    claims.push(`- ${text} [eval:${e.eval_id}]`);
  }
  for (const e of events) {
    if (e.type === "promotion" && typeof e.candidate_eval_id === "string") {
      if (known.has(e.candidate_eval_id)) {
        claims.push(
          `- Runner ${e.verdict}: ${oneLine(e.reason)} [eval:${e.candidate_eval_id}]`,
        );
      }
    } else if (
      e.type === "experiment" &&
      typeof e.eval_id === "string" &&
      known.has(e.eval_id)
    ) {
      claims.push(
        `- Agent reported for ${oneLine(e.hypothesis_id)}: ${oneLine(e.observations)} [eval:${e.eval_id}]`,
      );
    }
  }
  return claims;
}

/**
 * Lines of a report's Claims section that fail the audit: a claim with a
 * number must end in `[eval:<id>]` where <id> is an `eval` event in the log.
 */
export function auditClaims(report: string, logText: string): string[] {
  const ids = new Set(
    parseLog(logText).flatMap((e) =>
      e.type === "eval" && typeof e.eval_id === "string" ? [e.eval_id] : [],
    ),
  );
  const section = report.split(/^## Claims$/m)[1]?.split(/^## /m)[0] ?? "";
  return section
    .split("\n")
    .filter((l) => l.startsWith("- ") && /\d/.test(l))
    .filter((l) => {
      const id = l.match(/\[eval:([^\]]+)\]$/)?.[1];
      return !id || !ids.has(id);
    });
}

export interface ReportInput {
  projectPath: string;
  runId: string;
  endReason: ReportEndReason;
  now?: Date;
}

async function readProblem(projectPath: string): Promise<string> {
  try {
    const prd = (await Bun.file(
      `${projectPath}/.ml-ralph/prd.json`,
    ).json()) as { problem?: unknown };
    return typeof prd.problem === "string" && prd.problem.trim()
      ? prd.problem.trim()
      : "not recorded in prd.json";
  } catch {
    return "not recorded in prd.json";
  }
}

async function incumbentLines(
  projectPath: string,
  events: LogEvent[],
): Promise<string[]> {
  const read = await readIncumbent(projectPath);
  if (read.state === "none") return [`- Incumbent: ${NO_PROMOTION_LINE}`];
  if (read.state === "invalid") {
    return ["- Incumbent: incumbent.json is unreadable; no score or SHA"];
  }
  const { incumbent } = read;
  const metrics = await readEvalMetrics(projectPath, incumbent.eval_id);
  const search =
    metrics?.status === "ok" ? String(metrics.mean) : "not available";
  const done = events.findLast(
    (e) => e.type === "run_complete" && e.eval_id === incumbent.eval_id,
  );
  const holdout = isNumber(done?.holdout_score)
    ? String(done.holdout_score)
    : NOT_SCORED;
  return [
    `- Incumbent eval: ${incumbent.eval_id}`,
    `- Search score: ${search}`,
    `- Holdout score: ${holdout}`,
    `- SHA: ${incumbent.ref}`,
  ];
}

/** Render report.md from the project's records */
export async function renderReport(input: ReportInput): Promise<string> {
  const { projectPath } = input;
  const logFile = Bun.file(`${projectPath}/.ml-ralph/log.jsonl`);
  const events = parseLog((await logFile.exists()) ? await logFile.text() : "");
  const claims = buildClaims(events);
  return [
    "# Run report",
    "",
    `Run: ${input.runId}`,
    `Written: ${(input.now ?? new Date()).toISOString()}`,
    "",
    "## Problem",
    "",
    await readProblem(projectPath),
    "",
    "## Result",
    "",
    `- End reason: ${input.endReason}`,
    ...(await incumbentLines(projectPath, events)),
    "",
    "## Claims",
    "",
    ...(claims.length > 0
      ? claims
      : ["No claims: the log has no runner evals."]),
    "",
  ].join("\n");
}

/** Write .ml-ralph/reports/<run id>/report.md and return its path; throws on failure */
export async function writeReport(input: ReportInput): Promise<string> {
  if (!RUN_ID.test(input.runId)) {
    throw new Error(`run id ${JSON.stringify(input.runId)} is not a safe name`);
  }
  const path = `${input.projectPath}/${REPORTS_DIR}/${input.runId}/report.md`;
  await Bun.write(path, await renderReport(input));
  return path;
}
