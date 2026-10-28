/**
 * Runner-written eval metrics - the only metric files anything downstream trusts
 */

import { readdir, realpath } from "node:fs/promises";
import { join } from "node:path";
import {
  type EvalDirection,
  validateEvalContract,
} from "../../domain/validation/index.ts";

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
  /** HEAD commit the candidate was scored at; null outside a git repository */
  sha: string | null;
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

/** What the TUI shows for a finished eval; read from the runner's metrics.json only */
export interface EvalSummary {
  mean: number;
  std: number;
  seeds: number;
  /** Commit the eval scored; null when none was recorded */
  sha: string | null;
}

/** eval_id -> summary, for the evals that finished with status ok */
export type VerifiedEvals = ReadonlyMap<string, EvalSummary>;

/**
 * Remembers evals already read, so a poll only opens directories it has not
 * seen. metrics.json is written once, by rename, so a finished eval (ok or
 * failed) never needs a second read; a directory with no readable
 * metrics.json yet is retried on the next poll.
 */
export interface EvalCache {
  /** Project the entries belong to; a different project starts over */
  projectPath?: string;
  ok: Map<string, EvalSummary>;
  failed: Set<string>;
}

export const createEvalCache = (): EvalCache => ({
  ok: new Map(),
  failed: new Set(),
});

/** The evals under .ml-ralph/evals/ that finished with status ok */
export async function readVerifiedEvals(
  projectPath: string,
  cache: EvalCache = createEvalCache(),
): Promise<VerifiedEvals> {
  if (cache.projectPath !== projectPath) {
    cache.projectPath = projectPath;
    cache.ok.clear();
    cache.failed.clear();
  }
  let names: string[];
  try {
    names = await readdir(join(projectPath, EVALS_DIR));
  } catch {
    cache.ok.clear();
    cache.failed.clear();
    return new Map();
  }
  const present = new Set(names);
  for (const id of [...cache.ok.keys()])
    if (!present.has(id)) cache.ok.delete(id);
  for (const id of [...cache.failed])
    if (!present.has(id)) cache.failed.delete(id);

  for (const name of names) {
    if (cache.ok.has(name) || cache.failed.has(name)) continue;
    const metrics = await readEvalMetrics(projectPath, name);
    if (metrics?.status === "ok") {
      cache.ok.set(name, {
        mean: metrics.mean,
        std: metrics.std,
        seeds: metrics.scores.length,
        sha: metrics.sha ?? null,
      });
    } else if (metrics?.status === "failed") {
      cache.failed.add(name);
    }
  }
  return new Map(cache.ok);
}

/** The contract fields the TUI needs to read an eval mean */
export interface EvalScoring {
  primaryMetric: string;
  direction: EvalDirection;
}

/** primary_metric and direction from .ml-ralph/eval/contract.json, null if unusable */
export async function readEvalScoring(
  projectPath: string,
): Promise<EvalScoring | null> {
  try {
    const result = validateEvalContract(
      await Bun.file(join(projectPath, ".ml-ralph/eval/contract.json")).json(),
    );
    return result.valid
      ? {
          primaryMetric: result.contract.primary_metric,
          direction: result.contract.direction,
        }
      : null;
  } catch {
    return null;
  }
}
