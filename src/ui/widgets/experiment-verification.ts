/**
 * Which experiment numbers the TUI may present as verified.
 *
 * Only the mean in the runner's metrics.json counts. Numbers the agent put in
 * its experiment event are always "reported", whatever eval_id they cite.
 */

import type {
  EvalScoring,
  EvalSummary,
  VerifiedEvals,
} from "../../infrastructure/ralph/index.ts";

interface ExperimentLike {
  name?: string;
  hypothesis_id?: string;
  eval_id?: unknown;
  metrics?: Record<string, unknown>;
}

export interface ExperimentTrust {
  /** The runner eval the experiment cites, when it exists and finished ok */
  eval: EvalSummary | null;
  /** What the agent reported for the contract's primary metric, if anything */
  reported: number | null;
  /** The agent's primary-metric number disagrees with the eval mean */
  mismatch: boolean;
}

/** Reported numbers are copied from rounded output, so allow a little slack */
const mismatchTolerance = (mean: number) => 1e-3 * Math.max(1, Math.abs(mean));

export function evalFor(
  experiment: ExperimentLike,
  evals: VerifiedEvals,
): EvalSummary | null {
  return typeof experiment.eval_id === "string"
    ? (evals.get(experiment.eval_id) ?? null)
    : null;
}

function reportedPrimary(
  experiment: ExperimentLike,
  scoring: EvalScoring | null,
): number | null {
  if (!scoring) return null;
  const wanted = scoring.primaryMetric.toLowerCase();
  for (const [key, value] of Object.entries(experiment.metrics ?? {})) {
    if (
      key.toLowerCase() === wanted &&
      typeof value === "number" &&
      Number.isFinite(value)
    ) {
      return value;
    }
  }
  return null;
}

export function assessExperiment(
  experiment: ExperimentLike,
  evals: VerifiedEvals,
  scoring: EvalScoring | null,
): ExperimentTrust {
  const found = evalFor(experiment, evals);
  const reported = reportedPrimary(experiment, scoring);
  return {
    eval: found,
    reported,
    mismatch:
      found !== null &&
      reported !== null &&
      Math.abs(reported - found.mean) > mismatchTolerance(found.mean),
  };
}

export const isBetter = (
  candidate: number,
  incumbent: number,
  direction: EvalScoring["direction"],
): boolean =>
  direction === "min" ? candidate < incumbent : candidate > incumbent;

export interface ExperimentsSummary {
  total: number;
  /** Experiments whose eval_id is missing, made up, or not a finished eval */
  unverified: number;
  /** Best eval mean among verified experiments; agent-reported numbers never count */
  best: { name: string; mean: number } | null;
}

export function summarizeExperiments(
  experiments: ExperimentLike[],
  evals: VerifiedEvals,
  scoring: EvalScoring | null,
): ExperimentsSummary {
  const direction = scoring?.direction ?? "max";
  let unverified = 0;
  let best: ExperimentsSummary["best"] = null;
  for (const experiment of experiments) {
    const found = evalFor(experiment, evals);
    if (!found) {
      unverified++;
      continue;
    }
    if (!best || isBetter(found.mean, best.mean, direction)) {
      best = {
        name: experiment.name || experiment.hypothesis_id || "?",
        mean: found.mean,
      };
    }
  }
  return { total: experiments.length, unverified, best };
}
