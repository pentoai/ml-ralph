/**
 * Bench runner - runs each suite task through the real RalphRunner in a temporary
 * project and records success, holdout gap, cost and verifier catches
 */

import { cp, mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import pkg from "../../../package.json" with { type: "json" };
import type {
  BenchResults,
  BenchTask,
  BenchTaskResult,
} from "../../domain/types/index.ts";
import {
  type EvalContract,
  validateBenchSuite,
  validateEvalContract,
} from "../../domain/validation/index.ts";
import { runGit } from "../ralph/git.ts";
import {
  initRalph,
  type RalphRunner,
  type RunCompleteReason,
  type RunnerConfig,
  readIncumbent,
  createRunner as realCreateRunner,
  scoreHoldout,
} from "../ralph/index.ts";
import { type AuthStatusRunner, checkClaudeAuth } from "./auth.ts";

/** Extra time past a task's max_minutes before bench stops a run the runner's own cap did not end */
const GRACE_MS = 2 * 60_000;
const DEFAULT_MAX_ITERATIONS = 8;

export interface BenchOptions {
  /** bench/suite.json; task paths are relative to its directory */
  suitePath: string;
  /** Where the results file goes (default: results/ next to suite.json) */
  resultsDir?: string;
  /** Run only these task ids */
  only?: string[];
  onProgress?: (line: string) => void;
  /** Replaces `claude auth status` (tests) */
  authStatus?: AuthStatusRunner;
  /** Replaces the real runner (tests) */
  createRunner?: (config: RunnerConfig) => Pick<RalphRunner, "start" | "stop">;
  /** Python executable for the holdout run (default: python, or python3) */
  python?: string;
  /** Added to the wall-clock cap before bench itself stops a run (default 2 minutes) */
  graceMs?: number;
}

export type BenchOutcome =
  | { ok: true; results: BenchResults; file: string }
  | { ok: false; error: string };

type LogEvent = Record<string, unknown>;

async function readEvents(projectPath: string): Promise<LogEvent[]> {
  let text = "";
  try {
    text = await Bun.file(`${projectPath}/.ml-ralph/log.jsonl`).text();
  } catch {
    return [];
  }
  const events: LogEvent[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      events.push(JSON.parse(line) as LogEvent);
    } catch {
      // A torn line is not evidence
    }
  }
  return events;
}

const meetsTarget = (
  direction: EvalContract["direction"],
  target: number,
  score: number,
) => (direction === "max" ? score >= target : score <= target);

/** What the log says: summed cost and whether the verifier failed the check the task plants an exploit for */
export function readLogFacts(events: LogEvent[], task: BenchTask) {
  let usd = 0;
  let caught: boolean | null = task.expected_exploit === null ? null : false;
  for (const e of events) {
    if (e.type === "budget_status" && typeof e.usd_spent === "number") {
      usd = e.usd_spent;
    }
    if (e.type === "verifier_verdict" && task.expected_exploit !== null) {
      const checks = (e.checks ?? {}) as Record<string, unknown>;
      if (checks[task.expected_exploit] === "fail") caught = true;
    }
  }
  return { usd, caught };
}

async function seedProject(
  suiteDir: string,
  task: BenchTask,
  workDir: string,
  xdgDir: string,
): Promise<{ projectPath: string; direction: EvalContract["direction"] }> {
  const taskDir = resolve(suiteDir, task.path);
  const projectPath = join(workDir, "project");
  await cp(join(taskDir, "project"), projectPath, { recursive: true });
  const holdoutDir = join(workDir, "holdout");
  await mkdir(holdoutDir);
  const holdoutPath = join(holdoutDir, "holdout.csv");
  if (!(await Bun.file(join(taskDir, "holdout.csv")).exists())) {
    throw new Error(
      "holdout.csv is missing: the package does not ship holdout data, so run bench from a repository checkout",
    );
  }
  await cp(join(taskDir, "holdout.csv"), holdoutPath);

  const init = await initRalph({ projectPath, name: task.id });
  if (!init.success) throw new Error(`init failed: ${init.error}`);

  // The caps the runner enforces for this task
  const configFile = `${projectPath}/.ml-ralph/config.json`;
  const config = (await Bun.file(configFile).json()) as Record<string, unknown>;
  config.max_usd = task.max_usd;
  config.max_wall_clock_minutes = task.max_minutes;
  await Bun.write(configFile, `${JSON.stringify(config, null, 2)}\n`);

  const contract = validateEvalContract(
    await Bun.file(`${projectPath}/.ml-ralph/eval/contract.json`).json(),
  );
  if (!contract.valid) throw new Error("the task's contract.json is invalid");

  // The sealed holdout is configured in a throwaway user-level config, never ~/.config/ml-ralph
  const key = await realpath(projectPath);
  const configPath = join(xdgDir, "ml-ralph", "config.json");
  const existing = (await Bun.file(configPath).exists())
    ? ((await Bun.file(configPath).json()) as {
        projects?: Record<string, unknown>;
      })
    : {};
  await Bun.write(
    configPath,
    `${JSON.stringify({ ...existing, projects: { ...existing.projects, [key]: { holdout_path: holdoutPath } } }, null, 2)}\n`,
  );

  for (const args of [
    ["init", "-q"],
    ["config", "user.name", "ml-ralph bench"],
    ["config", "user.email", "bench@ml-ralph.invalid"],
    ["config", "commit.gpgsign", "false"],
    ["add", "-A"],
    ["commit", "-q", "-m", "bench seed"],
  ]) {
    const git = await runGit(projectPath, args);
    if (git.code !== 0) {
      throw new Error(`git ${args[0]} failed: ${git.err.trim()}`);
    }
  }
  return { projectPath, direction: contract.contract.direction };
}

/**
 * Run one task: seed a temporary project, run the agent loop under the task's
 * caps, then score the final incumbent on the sealed holdout. Never throws: a
 * task that cannot run comes back with `error`.
 */
export async function runTask(
  task: BenchTask,
  suiteDir: string,
  xdgDir: string,
  options: Pick<BenchOptions, "createRunner" | "python" | "graceMs">,
): Promise<BenchTaskResult> {
  const startedAt = Date.now();
  const result: BenchTaskResult = {
    id: task.id,
    success: false,
    holdout_gap: null,
    holdout_score: null,
    search_score: null,
    usd: 0,
    caught: task.expected_exploit === null ? null : false,
    expected_exploit: task.expected_exploit,
    end_reason: null,
    duration_seconds: 0,
  };
  const errors: string[] = [];
  let workDir: string | null = null;
  try {
    workDir = await mkdtemp(join(tmpdir(), `ml-ralph-bench-${task.id}-`));
    const { projectPath, direction } = await seedProject(
      suiteDir,
      task,
      workDir,
      xdgDir,
    );

    let endReason: RunCompleteReason | null = null;
    const runner = (options.createRunner ?? realCreateRunner)({
      projectPath,
      maxIterations: task.max_iterations ?? DEFAULT_MAX_ITERATIONS,
      onComplete: (reason) => {
        endReason = reason;
      },
      onError: (error) => {
        errors.push(error.message);
      },
    });
    let timedOut = false;
    const timer = setTimeout(
      () => {
        timedOut = true;
        void runner.stop();
      },
      task.max_minutes * 60_000 + (options.graceMs ?? GRACE_MS),
    );
    try {
      await runner.start();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!errors.includes(message)) errors.push(message);
    } finally {
      clearTimeout(timer);
    }
    if (timedOut) {
      errors.push(
        `wall-clock cap exceeded: the run was still going ${task.max_minutes} minutes (+ grace) in and was stopped`,
      );
    }
    result.end_reason = endReason;

    const facts = readLogFacts(await readEvents(projectPath), task);
    result.usd = facts.usd;
    result.caught = facts.caught;

    const incumbent = await readIncumbent(projectPath);
    if (incumbent.state === "ok") {
      const holdout = await scoreHoldout(incumbent.incumbent.eval_id, {
        projectPath,
        ...(options.python ? { python: options.python } : {}),
      });
      if (holdout.ok) {
        result.holdout_score = holdout.holdoutScore;
        result.holdout_gap = holdout.holdoutGap;
        result.search_score = holdout.searchScore;
        result.success = meetsTarget(
          direction,
          task.target,
          holdout.holdoutScore,
        );
      } else {
        errors.push(`holdout scoring failed: ${holdout.error}`);
      }
    } else if (incumbent.state === "invalid") {
      errors.push("incumbent.json is unreadable");
    }
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
  } finally {
    if (workDir) await rm(workDir, { recursive: true, force: true });
  }
  result.duration_seconds = Math.round((Date.now() - startedAt) / 100) / 10;
  if (errors.length > 0) result.error = errors.join("; ");
  return result;
}

/**
 * Run the suite and write results/<timestamp>.json. Refuses, running nothing,
 * without claude auth or with an invalid suite. The sealed holdouts are
 * configured through XDG_CONFIG_HOME pointing at a temporary directory for the
 * duration of the run, so nothing is written under ~/.config/ml-ralph.
 */
export async function runBench(options: BenchOptions): Promise<BenchOutcome> {
  const auth = await checkClaudeAuth(options.authStatus);
  if (!auth.ok) return auth;

  const suitePath = resolve(options.suitePath);
  let raw: unknown;
  try {
    raw = await Bun.file(suitePath).json();
  } catch {
    return { ok: false, error: `${suitePath} is missing or not valid JSON` };
  }
  const suite = validateBenchSuite(raw);
  if (!suite.valid) {
    const detail = suite.errors
      .map((e) => `${e.field} ${e.message}`)
      .join("; ");
    return { ok: false, error: `${suitePath} is invalid: ${detail}` };
  }
  const tasks = options.only?.length
    ? suite.suite.tasks.filter((t) => options.only?.includes(t.id))
    : suite.suite.tasks;
  const unknown = (options.only ?? []).filter(
    (id) => !suite.suite.tasks.some((t) => t.id === id),
  );
  if (unknown.length > 0) {
    return {
      ok: false,
      error: `no such task in the suite: ${unknown.join(", ")}`,
    };
  }

  const suiteDir = resolve(suitePath, "..");
  const resultsDir = resolve(options.resultsDir ?? join(suiteDir, "results"));
  const startedAt = new Date();
  const xdgDir = await mkdtemp(join(tmpdir(), "ml-ralph-bench-config-"));
  const priorXdg = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = xdgDir;
  const taskResults: BenchTaskResult[] = [];
  try {
    for (const task of tasks) {
      options.onProgress?.(`[${task.id}] running`);
      const r = await runTask(task, suiteDir, xdgDir, options);
      taskResults.push(r);
      options.onProgress?.(
        `[${task.id}] ${r.error ? `error: ${r.error}` : r.success ? "success" : "not successful"} (holdout ${r.holdout_score ?? "-"}, $${r.usd.toFixed(2)})`,
      );
    }
  } finally {
    if (priorXdg === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = priorXdg;
    await rm(xdgDir, { recursive: true, force: true });
  }

  const results: BenchResults = {
    schema_version: 1,
    started_at: startedAt.toISOString(),
    finished_at: new Date().toISOString(),
    ml_ralph_version: pkg.version,
    suite: suitePath,
    tasks: taskResults,
  };
  await mkdir(resultsDir, { recursive: true });
  const file = join(
    resultsDir,
    `${results.started_at.replace(/:/g, "-")}.json`,
  );
  await Bun.write(file, `${JSON.stringify(results, null, 2)}\n`);
  return { ok: true, results, file };
}
