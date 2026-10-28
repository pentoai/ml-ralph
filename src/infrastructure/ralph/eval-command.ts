/**
 * `ml-ralph eval <path>` - the runner scores a candidate with the locked evaluate.py
 */

import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import {
  type EvalContract,
  validateEvalContract,
} from "../../domain/validation/index.ts";
import { claimExperiment, experimentCapFor, readBudgetCaps } from "./budget.ts";
import {
  describeEvalChanges,
  type EvalLock,
  findEvalChanges,
  readEvalLock,
  sha256,
} from "./eval-lock.ts";
import {
  EVALS_DIR,
  type EvalMetrics,
  type EvalSeedScore,
} from "./eval-metrics.ts";
import { appendValidatedEvent, findProjectDir } from "./log-command.ts";
import type { EvalEvent } from "./templates.ts";

/** Per-seed timeout when the contract does not set eval_timeout_seconds */
export const DEFAULT_EVAL_TIMEOUT_SECONDS = 3600;
const EVAL_DIR = ".ml-ralph/eval";
/** Tells evaluate.py where its original directory is, since it runs from a copy */
export const EVAL_DIR_ENV = "ML_RALPH_EVAL_DIR";
/** Where the evaluator finds the sealed holdout; set for holdout runs only */
export const HOLDOUT_PATH_ENV = "ML_RALPH_HOLDOUT_PATH";
const MAX_STDERR_CHARS = 300;

export interface EvalCommandResult {
  /** Process exit code: 0 only when every seed produced a score */
  code: number;
  stdout: string;
  stderr: string;
  /** The metrics.json written, when the evaluation ran */
  metrics?: EvalMetrics;
}

export interface EvalCommandOptions {
  /** Directory to start looking for .ml-ralph/ from (default: cwd) */
  cwd?: string;
  /** Python executable (default: python, or python3 when there is no python) */
  python?: string;
}

const USAGE = `Usage: ml-ralph eval <path>

Runs the locked .ml-ralph/eval/evaluate.py once per contract seed on the
search split and writes .ml-ralph/evals/<eval_id>/metrics.json.`;

const fail = (stderr: string, code = 1): EvalCommandResult => ({
  code,
  stdout: "",
  stderr: `${stderr}\n`,
});

type SeedRun = { ok: true; score: number } | { ok: false; reason: string };

/** Signal the child's whole process group (it must be spawned `detached`) so what it started dies too */
export function killTree(
  proc: { pid: number; kill: (signal: "SIGTERM" | "SIGKILL") => void },
  signal: "SIGTERM" | "SIGKILL" = "SIGKILL",
) {
  try {
    process.kill(-proc.pid, signal);
  } catch {
    proc.kill(signal);
  }
}

/** Parse the last non-empty stdout line as a JSON object with a numeric score */
function parseScore(stdout: string): number | null {
  const lastLine = stdout
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .pop();
  if (!lastLine) return null;
  try {
    const score = (JSON.parse(lastLine) as { score?: unknown } | null)?.score;
    return typeof score === "number" && Number.isFinite(score) ? score : null;
  } catch {
    return null;
  }
}

/** Replace every occurrence of each secret with `<holdout>` */
function redactSecrets(text: string, secrets: string[]): string {
  let out = text;
  for (const secret of [...new Set(secrets)]
    .filter(Boolean)
    .sort((a, b) => b.length - a.length)) {
    out = out.split(secret).join("<holdout>");
  }
  return out;
}

async function runSeed(
  argv: string[],
  cwd: string,
  env: Record<string, string | undefined>,
  seed: number,
  timeoutSeconds: number,
  redact: string[],
): Promise<SeedRun> {
  let proc: ReturnType<typeof Bun.spawn>;
  try {
    proc = Bun.spawn(argv, {
      cwd,
      env,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      detached: true,
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return { ok: false, reason: `seed ${seed}: could not start (${reason})` };
  }

  const read = (stream: unknown) =>
    new Response(stream as ReadableStream).text().catch(() => "");
  const stdout = read(proc.stdout);
  const stderr = read(proc.stderr);

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<"timeout">((res) => {
    timer = setTimeout(() => res("timeout"), timeoutSeconds * 1000);
  });
  const outcome = await Promise.race([proc.exited, timeout]);
  clearTimeout(timer);

  if (outcome === "timeout") {
    killTree(proc);
    await proc.exited;
    return {
      ok: false,
      reason: `seed ${seed}: timed out after ${timeoutSeconds}s and was killed`,
    };
  }

  if (outcome !== 0) {
    // Redact before cutting, so a cut inside a secret cannot leave half of it behind
    const tail = redactSecrets((await stderr).trim(), redact).slice(
      -MAX_STDERR_CHARS,
    );
    const how =
      proc.signalCode !== null
        ? `was killed by ${proc.signalCode}`
        : `exited with code ${outcome}`;
    return {
      ok: false,
      reason: `seed ${seed}: evaluate.py ${how}${tail ? `: ${tail}` : ""}`,
    };
  }

  const score = parseScore(await stdout);
  if (score === null) {
    return {
      ok: false,
      reason: `seed ${seed}: last stdout line is not a JSON object with a numeric "score"`,
    };
  }
  return { ok: true, score };
}

function summarize(scores: number[]): { mean: number; std: number } {
  const mean = scores.reduce((a, b) => a + b, 0) / scores.length;
  const std =
    scores.length > 1
      ? Math.sqrt(
          scores.reduce((a, b) => a + (b - mean) ** 2, 0) / (scores.length - 1),
        )
      : 0;
  return { mean, std };
}

/** The locked evaluator, read once and checked against lock.json */
export type LockedEval =
  | {
      ok: true;
      lock: EvalLock;
      evaluateBytes: Uint8Array;
      contract: EvalContract;
    }
  | { ok: false; error: string };

/**
 * Read lock.json, then evaluate.py and contract.json once each, and check those
 * bytes against the lock hashes, so nothing can be swapped in between the check
 * and the run. The contract is parsed from the checked bytes.
 */
export async function readLockedEval(projectDir: string): Promise<LockedEval> {
  const lock = await readEvalLock(projectDir);
  if (!lock) {
    return {
      ok: false,
      error:
        "No valid eval lock (.ml-ralph/eval/lock.json): the runner creates it when the PRD is approved.",
    };
  }
  const changes = await findEvalChanges(projectDir, lock.files);
  if (changes.length > 0) {
    return {
      ok: false,
      error: `Locked eval files changed since the lock (${describeEvalChanges(changes)}).`,
    };
  }

  const readLocked = async (name: "evaluate.py" | "contract.json") => {
    try {
      const bytes = new Uint8Array(
        await Bun.file(join(projectDir, EVAL_DIR, name)).arrayBuffer(),
      );
      return sha256(bytes) === lock.files[name] ? bytes : null;
    } catch {
      return null;
    }
  };
  const [evaluateBytes, contractBytes] = await Promise.all([
    readLocked("evaluate.py"),
    readLocked("contract.json"),
  ]);
  if (!evaluateBytes || !contractBytes) {
    return {
      ok: false,
      error: "Locked eval files changed while the eval was starting.",
    };
  }

  let contract: ReturnType<typeof validateEvalContract>;
  try {
    contract = validateEvalContract(
      JSON.parse(new TextDecoder().decode(contractBytes)),
    );
  } catch {
    return { ok: false, error: "contract.json could not be read." };
  }
  if (!contract.valid) {
    return { ok: false, error: "contract.json is invalid." };
  }
  return { ok: true, lock, evaluateBytes, contract: contract.contract };
}

export const defaultPython = () => (Bun.which("python") ? "python" : "python3");

export interface EvaluatorRunOptions {
  python: string;
  /** The lock-verified bytes of evaluate.py */
  evaluateBytes: Uint8Array;
  projectDir: string;
  candidatePath: string;
  split: string;
  seeds: number[];
  timeoutSeconds: number;
  /** Added to the evaluator's environment, and to nothing else */
  extraEnv?: Record<string, string>;
  /** Strings that must not appear in a failure reason (replaced with `<holdout>`) */
  redact?: string[];
}

/**
 * Run the verified evaluate.py bytes from a private copy, once per seed, and
 * stop at the first seed that fails. The environment never carries the holdout
 * path unless the caller passes it in extraEnv.
 */
export async function runEvaluatorSeeds(
  options: EvaluatorRunOptions,
): Promise<
  { ok: true; scores: EvalSeedScore[] } | { ok: false; reason: string }
> {
  const privateDir = await mkdtemp(join(tmpdir(), "ml-ralph-eval-"));
  try {
    const script = join(privateDir, "evaluate.py");
    await writeFile(script, options.evaluateBytes, { mode: 0o400 });
    const { [HOLDOUT_PATH_ENV]: _inherited, ...inherited } = process.env;
    const env = {
      ...inherited,
      [EVAL_DIR_ENV]: join(options.projectDir, EVAL_DIR),
      ...options.extraEnv,
    };
    const scores: EvalSeedScore[] = [];
    const redact = options.redact ?? [];
    for (const seed of options.seeds) {
      const run = await runSeed(
        [
          options.python,
          script,
          "--candidate",
          options.candidatePath,
          "--split",
          options.split,
          "--seed",
          String(seed),
        ],
        options.projectDir,
        env,
        seed,
        options.timeoutSeconds,
        redact,
      );
      if (!run.ok)
        return { ok: false, reason: redactSecrets(run.reason, redact) };
      scores.push({ seed, score: run.score });
    }
    return { ok: true, scores };
  } finally {
    await rm(privateDir, { recursive: true, force: true });
  }
}

const newEvalId = () =>
  `eval-${Date.now().toString(36)}-${randomBytes(3).toString("hex")}`;

/** Write metrics.json by rename, so a reader never sees a half-written file */
export async function writeMetrics(
  projectDir: string,
  metrics: EvalMetrics,
): Promise<void> {
  const dir = join(projectDir, EVALS_DIR, metrics.eval_id);
  await mkdir(dir, { recursive: true });
  const tmp = join(dir, "metrics.json.tmp");
  await Bun.write(tmp, `${JSON.stringify(metrics, null, 2)}\n`);
  await rename(tmp, join(dir, "metrics.json"));
}

/**
 * Run `ml-ralph eval <path>`. Refuses, running nothing, unless lock.json exists
 * and the locked files still match their hashes. Otherwise it runs evaluate.py
 * once per contract seed and writes metrics.json: with scores when every seed
 * produced one, with status "failed" and a reason when one timed out, exited
 * non-zero or printed no usable score.
 */
export async function runEvalCommand(
  args: string[],
  options: EvalCommandOptions = {},
): Promise<EvalCommandResult> {
  const [candidateArg, ...extra] = args;
  if (!candidateArg || extra.length > 0) return fail(USAGE, 2);

  const cwd = resolve(options.cwd ?? process.cwd());
  const projectDir = await findProjectDir(cwd);
  if (!projectDir) {
    return fail(
      "No .ml-ralph/ directory here or in any parent; run from your project directory. Nothing was run.",
    );
  }

  const locked = await readLockedEval(projectDir);
  if (!locked.ok) return fail(`${locked.error} Nothing was run.`);
  const { lock, evaluateBytes, contract } = locked;

  // Under the runner, the iteration's eval calls are capped by config.json
  const budget = await readBudgetCaps(projectDir);
  const limit = experimentCapFor(
    process.env,
    budget.ok ? budget.caps.max_experiments_per_iteration : undefined,
  );
  if (!limit.ok) return fail(`${limit.error}. Nothing was run.`);
  if (limit.cap !== undefined) {
    if (!(await claimExperiment(projectDir, limit.iterationId, limit.cap))) {
      return fail(
        `experiment cap reached for this iteration (${limit.cap}). Nothing was run.`,
      );
    }
  }

  const { seeds, search_split: split } = contract;
  const timeoutSeconds =
    contract.eval_timeout_seconds ?? DEFAULT_EVAL_TIMEOUT_SECONDS;

  const candidatePath = isAbsolute(candidateArg)
    ? candidateArg
    : resolve(cwd, candidateArg);
  const rel = relative(projectDir, candidatePath);
  const candidate =
    rel.startsWith("..") || isAbsolute(rel) ? candidatePath : rel;

  const python = options.python ?? defaultPython();
  const base = {
    eval_id: newEvalId(),
    contract_hash: lock.files["contract.json"],
    evaluate_hash: lock.files["evaluate.py"],
    candidate,
    split,
    created_at: new Date().toISOString(),
  };

  const run = await runEvaluatorSeeds({
    python,
    evaluateBytes,
    projectDir,
    candidatePath,
    split,
    seeds,
    timeoutSeconds,
  });
  let metrics: EvalMetrics | undefined;
  if (!run.ok) metrics = { ...base, status: "failed", reason: run.reason };
  const scores = run.ok ? run.scores : [];
  metrics ??= {
    ...base,
    status: "ok",
    scores,
    ...summarize(scores.map((s) => s.score)),
  };

  await writeMetrics(projectDir, metrics);
  const event: Omit<EvalEvent, "ts"> = {
    type: "eval",
    eval_id: metrics.eval_id,
    status: metrics.status,
    candidate,
    ...(metrics.status === "ok"
      ? { mean: metrics.mean, std: metrics.std }
      : { reason: metrics.reason }),
  };
  await appendValidatedEvent(projectDir, event);

  const where = `${EVALS_DIR}/${metrics.eval_id}/metrics.json`;
  if (metrics.status === "failed") {
    return {
      code: 1,
      stdout: "",
      stderr: `Eval ${metrics.eval_id} failed: ${metrics.reason}\nRecorded in ${where}; it has no score.\n`,
      metrics,
    };
  }
  const perSeed = metrics.scores.map((s) => `${s.seed}=${s.score}`).join(", ");
  return {
    code: 0,
    stdout: `eval_id: ${metrics.eval_id}\nseeds: ${perSeed}\nmean: ${metrics.mean}\nstd: ${metrics.std}\nmetrics: ${where}\nLog the experiment with "eval_id":"${metrics.eval_id}" and these numbers.\n`,
    stderr: "",
    metrics,
  };
}
