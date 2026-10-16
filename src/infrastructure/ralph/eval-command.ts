/**
 * `ml-ralph eval <path>` - the runner scores a candidate with the locked evaluate.py
 */

import { randomBytes } from "node:crypto";
import { mkdir, rename } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { validateEvalContract } from "../../domain/validation/index.ts";
import {
  describeEvalChanges,
  findEvalChanges,
  readEvalLock,
} from "./eval-lock.ts";
import {
  EVALS_DIR,
  type EvalMetrics,
  type EvalSeedScore,
} from "./eval-metrics.ts";
import { appendLogLine, findProjectDir } from "./log-command.ts";
import type { EvalEvent } from "./templates.ts";

/** Per-seed timeout when the contract does not set eval_timeout_seconds */
export const DEFAULT_EVAL_TIMEOUT_SECONDS = 3600;
const EVALUATE_PATH = ".ml-ralph/eval/evaluate.py";
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

/** SIGKILL the child's whole process group so a training run it started dies too */
function killTree(proc: { pid: number; kill: (signal: "SIGKILL") => void }) {
  try {
    process.kill(-proc.pid, "SIGKILL");
  } catch {
    proc.kill("SIGKILL");
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

async function runSeed(
  argv: string[],
  cwd: string,
  seed: number,
  timeoutSeconds: number,
): Promise<SeedRun> {
  let proc: ReturnType<typeof Bun.spawn>;
  try {
    proc = Bun.spawn(argv, {
      cwd,
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
    const tail = (await stderr).trim().slice(-MAX_STDERR_CHARS);
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

const newEvalId = () =>
  `eval-${Date.now().toString(36)}-${randomBytes(3).toString("hex")}`;

/** Write metrics.json by rename, so a reader never sees a half-written file */
async function writeMetrics(
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

  const lock = await readEvalLock(projectDir);
  if (!lock) {
    return fail(
      "No valid eval lock (.ml-ralph/eval/lock.json): the runner creates it when the PRD is approved. Nothing was run.",
    );
  }
  const changes = await findEvalChanges(projectDir, lock.files);
  if (changes.length > 0) {
    return fail(
      `Locked eval files changed since the lock (${describeEvalChanges(changes)}). Nothing was run.`,
    );
  }

  let contract: ReturnType<typeof validateEvalContract>;
  try {
    contract = validateEvalContract(
      await Bun.file(`${projectDir}/.ml-ralph/eval/contract.json`).json(),
    );
  } catch {
    return fail("contract.json could not be read. Nothing was run.");
  }
  if (!contract.valid) {
    return fail("contract.json is invalid. Nothing was run.");
  }
  const { seeds, search_split: split } = contract.contract;
  const timeoutSeconds =
    contract.contract.eval_timeout_seconds ?? DEFAULT_EVAL_TIMEOUT_SECONDS;

  const candidatePath = isAbsolute(candidateArg)
    ? candidateArg
    : resolve(cwd, candidateArg);
  const rel = relative(projectDir, candidatePath);
  const candidate =
    rel.startsWith("..") || isAbsolute(rel) ? candidatePath : rel;

  const python = options.python ?? (Bun.which("python") ? "python" : "python3");
  const base = {
    eval_id: newEvalId(),
    contract_hash: lock.files["contract.json"],
    evaluate_hash: lock.files["evaluate.py"],
    candidate,
    split,
    created_at: new Date().toISOString(),
  };

  const scores: EvalSeedScore[] = [];
  let metrics: EvalMetrics | undefined;
  for (const seed of seeds) {
    const run = await runSeed(
      [
        python,
        EVALUATE_PATH,
        "--candidate",
        candidatePath,
        "--split",
        split,
        "--seed",
        String(seed),
      ],
      projectDir,
      seed,
      timeoutSeconds,
    );
    if (!run.ok) {
      metrics = { ...base, status: "failed", reason: run.reason };
      break;
    }
    scores.push({ seed, score: run.score });
  }
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
  await appendLogLine(projectDir, event);

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
