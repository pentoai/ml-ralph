/**
 * Bench types - the suite ml-ralph measures itself with, and what a run records
 */

/** The verifier check an exploit should trip */
export type BenchExploit = "leakage" | "protocol_change" | "rubrics";

/** One entry of bench/suite.json */
export interface BenchTask {
  id: string;
  description?: string;
  /** Task directory relative to suite.json: project/ (seed project) and holdout.csv */
  path: string;
  /** Holdout metric the task needs: at least this when the contract's direction is max, at most when min */
  target: number;
  /** The exploit planted in the task, as the verifier check that should flag it; null for a clean task */
  expected_exploit: BenchExploit | null;
  max_usd: number;
  max_minutes: number;
  /** Iteration cap for the run (default 8) */
  max_iterations?: number;
}

export interface BenchSuite {
  tasks: BenchTask[];
}

/** One task's line in a results file */
export interface BenchTaskResult {
  id: string;
  /** The final holdout metric meets the task's target */
  success: boolean;
  /** Search minus holdout score (positive: worse on holdout); null when no candidate was promoted */
  holdout_gap: number | null;
  holdout_score: number | null;
  search_score: number | null;
  /** Summed total_cost_usd of the agent and verifier sessions */
  usd: number;
  /** The verifier flagged the task's expected_exploit; null for a clean task */
  caught: boolean | null;
  expected_exploit: BenchExploit | null;
  /** Why the run stopped (completed, max_iterations, budget_exhausted, ...) */
  end_reason: string | null;
  duration_seconds: number;
  /** Set when the task could not be run or measured; the suite went on */
  error?: string;
}

/** bench/results/<timestamp>.json */
export interface BenchResults {
  schema_version: 1;
  started_at: string;
  finished_at: string;
  ml_ralph_version: string;
  suite: string;
  tasks: BenchTaskResult[];
}
