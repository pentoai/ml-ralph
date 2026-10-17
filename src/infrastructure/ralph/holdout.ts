/**
 * Sealed holdout - the runner scores each eval on data the agent never sees, once
 */

import { open, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import type { EvalContract } from "../../domain/validation/index.ts";
import {
  defaultPython,
  HOLDOUT_PATH_ENV,
  readLockedEval,
  runEvaluatorSeeds,
  writeMetrics,
} from "./eval-command.ts";
import {
  EVALS_DIR,
  type EvalMetricsOk,
  readEvalMetrics,
} from "./eval-metrics.ts";
import { appendLogLine } from "./log-command.ts";
import type { OverfittingEvent } from "./templates.ts";

const HOLDOUT_SPLIT = "holdout";
const CLAIM_FILE = "holdout.claim";
const SECRET_PLACEHOLDER = "<holdout>";

export interface HoldoutOptions {
  projectPath: string;
  /** Environment to find XDG_CONFIG_HOME in (default: process.env) */
  env?: Record<string, string | undefined>;
  /** Python executable (default: python, or python3 when there is no python) */
  python?: string;
}

export type HoldoutResult =
  | {
      ok: true;
      evalId: string;
      searchScore: number;
      holdoutScore: number;
      holdoutGap: number;
      threshold: number;
      /** The gap is above holdout_gap_threshold: the candidate must not complete */
      blocked: boolean;
      /** This eval was already scored; nothing ran and the recorded result is returned */
      alreadyScored: boolean;
    }
  | { ok: false; error: string; alreadyScored?: boolean };

/** The user-level config file: $XDG_CONFIG_HOME/ml-ralph/config.json, else ~/.config/ml-ralph/config.json */
export function holdoutConfigFile(
  env: Record<string, string | undefined> = process.env,
): string {
  const xdg = env.XDG_CONFIG_HOME;
  const base = xdg && isAbsolute(xdg) ? xdg : join(homedir(), ".config");
  return join(base, "ml-ralph", "config.json");
}

/**
 * Read the holdout path for a project from the user-level config:
 * `{"projects": {"<absolute project path>": {"holdout_path": "<absolute path>"}}}`.
 * Errors name the file and the key, never the path itself.
 */
export async function readHoldoutPath(
  projectPath: string,
  env: Record<string, string | undefined> = process.env,
): Promise<{ ok: true; path: string } | { ok: false; error: string }> {
  const file = holdoutConfigFile(env);
  const keys = [resolve(projectPath)];
  try {
    keys.push(await realpath(projectPath));
  } catch {
    // The project directory is gone; the lookup below fails with the entry error
  }
  const keyName = (key: string) => `projects[${JSON.stringify(key)}]`;

  let config: unknown;
  try {
    config = await Bun.file(file).json();
  } catch (error) {
    const missing = !(await Bun.file(file).exists());
    return {
      ok: false,
      error: missing
        ? `${file} does not exist; add ${keyName(keys[0] as string)}.holdout_path`
        : `${file} is not valid JSON (${error instanceof Error ? error.message : String(error)})`,
    };
  }

  const projects = (config as { projects?: unknown } | null)?.projects;
  const entries =
    typeof projects === "object" && projects !== null
      ? (projects as Record<string, unknown>)
      : {};
  const key = keys.find((k) => k in entries);
  const holdoutPath = (entries[key ?? ""] as { holdout_path?: unknown } | null)
    ?.holdout_path;
  if (key === undefined || typeof holdoutPath !== "string" || !holdoutPath) {
    return {
      ok: false,
      error: `${file} has no ${keyName(keys[0] as string)}.holdout_path`,
    };
  }

  const where = `${file}: ${keyName(key)}.holdout_path`;
  if (!isAbsolute(holdoutPath)) {
    return { ok: false, error: `${where} must be an absolute path` };
  }
  try {
    await stat(holdoutPath);
  } catch {
    return { ok: false, error: `${where} does not exist` };
  }
  return { ok: true, path: holdoutPath };
}

/** Search score minus holdout score when higher is better, the reverse when lower is: positive means it did worse on holdout */
export function holdoutGap(
  direction: EvalContract["direction"],
  searchScore: number,
  holdoutScore: number,
): number {
  return direction === "max"
    ? searchScore - holdoutScore
    : holdoutScore - searchScore;
}

/** Hide the holdout path in text that is about to be written inside the project */
function scrub(text: string, secrets: string[]): string {
  let out = text;
  for (const secret of [...new Set(secrets)].sort(
    (a, b) => b.length - a.length,
  )) {
    out = out.split(secret).join(SECRET_PLACEHOLDER);
  }
  return out;
}

function recordedResult(
  metrics: EvalMetricsOk,
  contract: EvalContract,
): HoldoutResult | null {
  if (metrics.holdout_status === undefined) return null;
  const { holdout_score: score, holdout_gap: gap } = metrics;
  if (metrics.holdout_status === "ok") {
    if (!Number.isFinite(score) || !Number.isFinite(gap)) {
      return {
        ok: false,
        alreadyScored: true,
        error: `Eval ${metrics.eval_id} has a malformed holdout record in metrics.json; it is not scored again.`,
      };
    }
    return {
      ok: true,
      evalId: metrics.eval_id,
      searchScore: metrics.mean,
      holdoutScore: score as number,
      holdoutGap: gap as number,
      threshold: contract.holdout_gap_threshold,
      blocked: (gap as number) > contract.holdout_gap_threshold,
      alreadyScored: true,
    };
  }
  return {
    ok: false,
    alreadyScored: true,
    error: `The holdout run for eval ${metrics.eval_id} already failed (${metrics.holdout_reason ?? "no reason recorded"}); it is not scored again.`,
  };
}

/**
 * Score an eval's candidate on the sealed holdout, at most once per eval_id.
 *
 * The holdout path comes from the user-level config and goes only into the
 * environment of the evaluate.py subprocess (as ML_RALPH_HOLDOUT_PATH). The
 * result is written to that eval's metrics.json as holdout_score and
 * holdout_gap. A gap above the contract's holdout_gap_threshold logs an
 * `overfitting` event and the result comes back `blocked`. A second call
 * returns the recorded result without running anything.
 */
export async function scoreHoldout(
  evalId: string,
  options: HoldoutOptions,
): Promise<HoldoutResult> {
  const projectDir = resolve(options.projectPath);
  const env = options.env ?? process.env;

  const locked = await readLockedEval(projectDir);
  if (!locked.ok) return { ok: false, error: locked.error };
  const { lock, evaluateBytes, contract } = locked;

  const metrics = await readEvalMetrics(projectDir, evalId);
  if (!metrics) {
    return {
      ok: false,
      error: `No valid metrics.json for eval ${JSON.stringify(evalId)} under ${EVALS_DIR}/.`,
    };
  }
  if (metrics.status !== "ok") {
    return {
      ok: false,
      error: `Eval ${evalId} failed and has no search score to compare with.`,
    };
  }

  const recorded = recordedResult(metrics, contract);
  if (recorded) return recorded;

  if (
    metrics.contract_hash !== lock.files["contract.json"] ||
    metrics.evaluate_hash !== lock.files["evaluate.py"]
  ) {
    return {
      ok: false,
      error: `Eval ${evalId} was scored under a different contract or evaluate.py than the current lock, so its score is not comparable with a holdout score.`,
    };
  }

  const holdout = await readHoldoutPath(projectDir, env);
  if (!holdout.ok) return { ok: false, error: holdout.error };

  // Claim the one run before starting it; a crash mid-run still counts
  const claimFile = join(projectDir, EVALS_DIR, evalId, CLAIM_FILE);
  try {
    const claim = await open(claimFile, "wx");
    await claim.writeFile(`${new Date().toISOString()}\n`);
    await claim.close();
  } catch {
    return {
      ok: false,
      alreadyScored: true,
      error: `A holdout run for eval ${evalId} was already started and has no recorded result; it is not run again.`,
    };
  }

  const candidatePath = resolve(projectDir, metrics.candidate);
  const run = await runEvaluatorSeeds({
    python: options.python ?? defaultPython(),
    evaluateBytes,
    projectDir,
    candidatePath,
    split: HOLDOUT_SPLIT,
    seeds: contract.seeds,
    timeoutSeconds: contract.eval_timeout_seconds,
    extraEnv: { [HOLDOUT_PATH_ENV]: holdout.path },
  });

  const scoredAt = new Date().toISOString();
  if (!run.ok) {
    const secrets = [
      holdout.path,
      await realpath(holdout.path).catch(() => ""),
    ];
    const reason = scrub(
      run.reason,
      secrets.filter((s) => s !== ""),
    );
    await writeMetrics(projectDir, {
      ...metrics,
      holdout_status: "failed",
      holdout_reason: reason,
      holdout_scored_at: scoredAt,
    });
    return {
      ok: false,
      error: `The holdout run for eval ${evalId} failed: ${reason}`,
    };
  }

  const holdoutScore =
    run.scores.reduce((sum, s) => sum + s.score, 0) / run.scores.length;
  const gap = holdoutGap(contract.direction, metrics.mean, holdoutScore);
  await writeMetrics(projectDir, {
    ...metrics,
    holdout_status: "ok",
    holdout_score: holdoutScore,
    holdout_gap: gap,
    holdout_scored_at: scoredAt,
  });

  const blocked = gap > contract.holdout_gap_threshold;
  if (blocked) {
    const event: Omit<OverfittingEvent, "ts"> = {
      type: "overfitting",
      eval_id: evalId,
      search_score: metrics.mean,
      holdout_score: holdoutScore,
      holdout_gap: gap,
      threshold: contract.holdout_gap_threshold,
    };
    await appendLogLine(projectDir, event);
  }
  return {
    ok: true,
    evalId,
    searchScore: metrics.mean,
    holdoutScore,
    holdoutGap: gap,
    threshold: contract.holdout_gap_threshold,
    blocked,
    alreadyScored: false,
  };
}
