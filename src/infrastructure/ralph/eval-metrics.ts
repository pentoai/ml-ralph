/**
 * Runner-written eval metrics - the only metric files anything downstream trusts
 */

import { readdir, realpath } from "node:fs/promises";
import { join } from "node:path";

/** Where `ml-ralph eval` writes one directory per eval, relative to the project */
export const EVALS_DIR = ".ml-ralph/evals";

const EVAL_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

export interface EvalSeedScore {
  seed: number;
  score: number;
}

interface EvalMetricsBase {
  eval_id: string;
  /** SHA-256 of contract.json from lock.json */
  contract_hash: string;
  /** SHA-256 of evaluate.py from lock.json */
  evaluate_hash: string;
  candidate: string;
  split: string;
  created_at: string;
}

export interface EvalMetricsOk extends EvalMetricsBase {
  status: "ok";
  scores: EvalSeedScore[];
  mean: number;
  /** Sample standard deviation (n - 1) of the per-seed scores; 0 for one seed */
  std: number;
}

export interface EvalMetricsFailed extends EvalMetricsBase {
  status: "failed";
  reason: string;
}

export type EvalMetrics = EvalMetricsOk | EvalMetricsFailed;

const isNumber = (v: unknown): v is number =>
  typeof v === "number" && Number.isFinite(v);

function isEvalMetrics(value: unknown, evalId: string): value is EvalMetrics {
  const m = value as Record<string, unknown> | null;
  if (typeof m !== "object" || m === null || m.eval_id !== evalId) return false;
  if (m.status === "failed") return typeof m.reason === "string";
  return (
    m.status === "ok" &&
    isNumber(m.mean) &&
    isNumber(m.std) &&
    Array.isArray(m.scores) &&
    m.scores.every(
      (s: unknown) =>
        isNumber((s as EvalSeedScore | null)?.seed) &&
        isNumber((s as EvalSeedScore | null)?.score),
    )
  );
}

/**
 * Read .ml-ralph/evals/<evalId>/metrics.json. Null when the id is not a plain
 * name, the file is missing or malformed, its eval_id disagrees with the
 * directory, or it resolves (via a symlink) to somewhere outside the evals
 * directory. Metric files anywhere else are never read.
 */
export async function readEvalMetrics(
  projectPath: string,
  evalId: string,
): Promise<EvalMetrics | null> {
  if (!EVAL_ID.test(evalId)) return null;
  try {
    const evalsRoot = await realpath(join(projectPath, EVALS_DIR));
    const file = await realpath(join(evalsRoot, evalId, "metrics.json"));
    if (!file.startsWith(`${evalsRoot}/`)) return null;
    const parsed: unknown = await Bun.file(file).json();
    return isEvalMetrics(parsed, evalId) ? parsed : null;
  } catch {
    return null;
  }
}

/** Ids of the evals under .ml-ralph/evals/ that finished with status ok */
export async function readVerifiedEvalIds(
  projectPath: string,
): Promise<Set<string>> {
  const ids = new Set<string>();
  let names: string[];
  try {
    names = await readdir(join(projectPath, EVALS_DIR));
  } catch {
    return ids;
  }
  for (const name of names) {
    if ((await readEvalMetrics(projectPath, name))?.status === "ok") {
      ids.add(name);
    }
  }
  return ids;
}

/** True when the experiment's eval_id is one of the runner's finished evals */
export function isExperimentVerified(
  experiment: { eval_id?: unknown },
  verifiedEvalIds: ReadonlySet<string>,
): boolean {
  return (
    typeof experiment.eval_id === "string" &&
    verifiedEvalIds.has(experiment.eval_id)
  );
}
