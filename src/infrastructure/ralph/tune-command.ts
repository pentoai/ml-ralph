/**
 * `ml-ralph tune` - Optuna owns the trials of a numeric sweep, the runner scores each one
 *
 * The agent picks the space and the budget; the optimizer proposes parameters
 * (ask/tell over a Python subprocess), the train command runs with them, and
 * each trial's candidate is scored exactly like `ml-ralph eval`. Tune never
 * promotes: its best trial is only a candidate.
 */

import { isAbsolute, resolve } from "node:path";
import {
  findPlaceholders,
  substituteParams,
  type TuneSpace,
  type TuneValue,
  validateTuneSpace,
} from "../../domain/validation/index.ts";
import {
  type BudgetCaps,
  budgetStatus,
  claimExperiment,
  exhaustedCap,
  experimentCapFor,
  readBudgetCaps,
  readRecordedBudget,
} from "./budget.ts";
import {
  DEFAULT_EVAL_TIMEOUT_SECONDS,
  defaultPython,
  type EvalCommandResult,
  killTree,
  readLockedEval,
  scoreCandidate,
} from "./eval-command.ts";
import { evalCommit } from "./git.ts";
import { appendValidatedEvent, findProjectDir } from "./log-command.ts";
import type { TuneResultEvent } from "./templates.ts";

const SAMPLERS = ["tpe", "cmaes"] as const;
type Sampler = (typeof SAMPLERS)[number];
type Params = Record<string, TuneValue>;
const MAX_REASON_CHARS = 300;

export const OPTUNA_INSTALL_HINT =
  "ml-ralph tune needs Python with Optuna: install it with `pip install optuna` (and `pip install cmaes` for --sampler cmaes).";

/** The optimizer behind tune: Optuna in production, a stub in tests */
export interface TuneOptimizer {
  /** The next trial's number and parameters */
  ask(): Promise<{ id: number; params: Params }>;
  /** Report a trial's score, or null when the trial failed */
  tell(id: number, value: number | null): Promise<void>;
  close(): Promise<void>;
}

export interface StartOptimizerOptions {
  python: string;
  space: TuneSpace;
  sampler: Sampler;
  direction: "max" | "min";
  seed?: number;
}

export type StartOptimizer = (
  options: StartOptimizerOptions,
) => Promise<
  { ok: true; optimizer: TuneOptimizer } | { ok: false; error: string }
>;

export interface TuneCommandOptions {
  /** Directory to start looking for .ml-ralph/ from (default: cwd) */
  cwd?: string;
  /** Python executable (default: python, or python3 when there is no python) */
  python?: string;
  /** Replace the Optuna subprocess (tests) */
  startOptimizer?: StartOptimizer;
}

const USAGE = `Usage: ml-ralph tune --space <space.json> --trials <N> --command "<train cmd>" [--sampler tpe|cmaes] [--candidate <path>] [--timeout <seconds>] [--seed <N>]

Runs an Optuna study. Each trial fills the {param} placeholders of --command (and
of --candidate) from space.json, runs it, then scores the candidate like
\`ml-ralph eval\` (default candidate: the current directory). Trials count
against max_experiments_per_iteration and the USD and wall-clock budget.
Tune never promotes; its best trial is only a candidate.

space.json maps each parameter name to one of:
  {"type": "float", "low": 1e-5, "high": 1e-1, "log": true}
  {"type": "int", "low": 1, "high": 8, "step": 1}
  {"type": "categorical", "choices": ["adam", "sgd"]}`;

const fail = (stderr: string, code = 1): EvalCommandResult => ({
  code,
  stdout: "",
  stderr: `${stderr}\n`,
});

interface TuneArgs {
  space: string;
  trials: number;
  command: string;
  sampler: Sampler;
  candidate: string;
  timeout?: number;
  seed?: number;
}

const FLAGS = [
  "--space",
  "--trials",
  "--command",
  "--sampler",
  "--candidate",
  "--timeout",
  "--seed",
];

/** Parse the flags; the error names the flag at fault */
function parseArgs(
  args: string[],
): { ok: true; args: TuneArgs } | { ok: false; error: string } {
  const raw = new Map<string, string>();
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] as string;
    const eq = arg.indexOf("=");
    const flag = eq === -1 ? arg : arg.slice(0, eq);
    if (!FLAGS.includes(flag)) {
      return { ok: false, error: `unknown argument ${JSON.stringify(arg)}` };
    }
    const value = eq === -1 ? args[++i] : arg.slice(eq + 1);
    if (value === undefined)
      return { ok: false, error: `${flag} needs a value` };
    raw.set(flag, value);
  }
  for (const flag of ["--space", "--trials", "--command"]) {
    if (!raw.get(flag)) return { ok: false, error: `${flag} is required` };
  }
  const positive = (flag: string, integer: boolean) => {
    const text = raw.get(flag);
    if (text === undefined) return undefined;
    const n = Number(text);
    if (
      !text.trim() ||
      !Number.isFinite(n) ||
      n <= 0 ||
      (integer && !Number.isInteger(n))
    ) {
      return null;
    }
    return n;
  };
  const trials = positive("--trials", true);
  if (!trials)
    return { ok: false, error: "--trials must be a positive integer" };
  const timeout = positive("--timeout", false);
  if (timeout === null)
    return {
      ok: false,
      error: "--timeout must be a positive number of seconds",
    };
  const seedText = raw.get("--seed");
  const seed = seedText === undefined ? undefined : Number(seedText);
  if (seed !== undefined && (!seedText?.trim() || !Number.isInteger(seed))) {
    return { ok: false, error: "--seed must be an integer" };
  }
  const sampler = raw.get("--sampler") ?? "tpe";
  if (!SAMPLERS.includes(sampler as Sampler)) {
    return { ok: false, error: "--sampler must be tpe or cmaes" };
  }
  return {
    ok: true,
    args: {
      space: raw.get("--space") as string,
      trials,
      command: raw.get("--command") as string,
      sampler: sampler as Sampler,
      candidate: raw.get("--candidate") ?? ".",
      timeout,
      seed,
    },
  };
}

/** The Optuna driver: reads one JSON request per line on stdin, answers one JSON line on stdout */
const OPTUNA_DRIVER = `
import json, sys

def say(obj):
    sys.stdout.write(json.dumps(obj) + "\\n")
    sys.stdout.flush()

try:
    import optuna
except ImportError:
    say({"error": "missing", "message": "the optuna package is not installed"})
    sys.exit(0)

cfg = json.loads(sys.stdin.readline())
optuna.logging.set_verbosity(optuna.logging.WARNING)
try:
    if cfg["sampler"] == "cmaes":
        sampler = optuna.samplers.CmaEsSampler(seed=cfg.get("seed"))
    else:
        sampler = optuna.samplers.TPESampler(seed=cfg.get("seed"))
except ImportError:
    say({"error": "missing", "message": "the cmaes package is not installed"})
    sys.exit(0)
study = optuna.create_study(
    direction="maximize" if cfg["direction"] == "max" else "minimize",
    sampler=sampler,
)
trials = {}
say({"ready": True})
for line in sys.stdin:
    msg = json.loads(line)
    if msg["op"] == "ask":
        trial = study.ask()
        params = {}
        for name, p in cfg["space"].items():
            if p["type"] == "categorical":
                params[name] = trial.suggest_categorical(name, p["choices"])
            elif p["type"] == "int":
                params[name] = trial.suggest_int(name, p["low"], p["high"], step=p.get("step", 1), log=p.get("log", False))
            else:
                params[name] = trial.suggest_float(name, p["low"], p["high"], step=p.get("step"), log=p.get("log", False))
        trials[trial.number] = trial
        say({"id": trial.number, "params": params})
    elif msg["op"] == "tell":
        if msg["value"] is None:
            study.tell(trials.pop(msg["id"]), state=optuna.trial.TrialState.FAIL)
        else:
            study.tell(trials.pop(msg["id"]), msg["value"])
        say({"ok": True})
`;

/** Start the Optuna subprocess; resolves to an install hint when Python or Optuna is missing */
export const startOptuna: StartOptimizer = async (options) => {
  const unavailable = (why: string) => ({
    ok: false as const,
    error: `${why}\n${OPTUNA_INSTALL_HINT}`,
  });
  let proc: ReturnType<typeof Bun.spawn>;
  try {
    proc = Bun.spawn([options.python, "-u", "-c", OPTUNA_DRIVER], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
  } catch {
    return unavailable(`Could not start ${options.python}.`);
  }
  const stdin = proc.stdin as import("bun").FileSink;
  const reader = (proc.stdout as ReadableStream<Uint8Array>).getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  /** The next JSON line of the driver; null when it exited without one */
  const readLine = async (): Promise<Record<string, unknown> | null> => {
    for (;;) {
      const nl = buffer.indexOf("\n");
      if (nl !== -1) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line) continue;
        try {
          return JSON.parse(line) as Record<string, unknown>;
        } catch {
          continue; // stray output is not protocol
        }
      }
      const { done, value } = await reader.read();
      if (done) return null;
      buffer += decoder.decode(value, { stream: true });
    }
  };
  const send = async (msg: object) => {
    stdin.write(`${JSON.stringify(msg)}\n`);
    await stdin.flush();
  };
  const stop = async () => {
    try {
      stdin.end();
    } catch {
      // already closed
    }
    proc.kill();
  };

  try {
    await send({
      sampler: options.sampler,
      direction: options.direction,
      space: options.space,
      seed: options.seed,
    });
    const hello = await readLine();
    if (hello?.ready !== true) {
      await stop();
      const message =
        typeof hello?.message === "string"
          ? hello.message
          : `Python exited before Optuna started: ${(await new Response(proc.stderr as ReadableStream).text()).trim().slice(-MAX_REASON_CHARS)}`;
      return unavailable(message);
    }
  } catch {
    await stop();
    return unavailable("Could not talk to the Optuna process.");
  }

  const request = async (msg: object) => {
    await send(msg);
    const reply = await readLine();
    if (!reply || reply.error) {
      throw new Error(
        `Optuna process failed: ${String(reply?.error ?? "it exited")}`,
      );
    }
    return reply;
  };
  return {
    ok: true,
    optimizer: {
      async ask() {
        const reply = await request({ op: "ask" });
        return { id: reply.id as number, params: reply.params as Params };
      },
      async tell(id, value) {
        await request({ op: "tell", id, value });
      },
      close: stop,
    },
  };
};

/** Run the train command through `sh -c`; killed with its process group on timeout */
async function runTrain(
  command: string,
  cwd: string,
  timeoutSeconds: number,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  let proc: ReturnType<typeof Bun.spawn>;
  try {
    proc = Bun.spawn(["sh", "-c", command], {
      cwd,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      detached: true,
    });
  } catch (error) {
    const why = error instanceof Error ? error.message : String(error);
    return { ok: false, reason: `train command could not start (${why})` };
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
      reason: `train command timed out after ${Math.ceil(timeoutSeconds)}s and was killed`,
    };
  }
  if (outcome === 0) return { ok: true };
  const err = (await stderr).trim() || (await stdout).trim();
  const how =
    proc.signalCode !== null
      ? `was killed by ${proc.signalCode}`
      : `exited with code ${outcome}`;
  const tail = err.slice(-MAX_REASON_CHARS);
  return {
    ok: false,
    reason: `train command ${how}${tail ? `: ${tail}` : ""}`,
  };
}

type Limit =
  | "max_experiments_per_iteration"
  | "max_usd"
  | "max_wall_clock_minutes";

const describeLimit = (
  limit: Limit,
  caps: BudgetCaps,
  experimentCap?: number,
) =>
  limit === "max_usd"
    ? `max_usd ($${caps.max_usd})`
    : limit === "max_wall_clock_minutes"
      ? `max_wall_clock_minutes (${caps.max_wall_clock_minutes})`
      : `max_experiments_per_iteration (${experimentCap})`;

/**
 * Run `ml-ralph tune`. Everything that can be refused is refused before the
 * first trial: bad flags, an invalid space.json, a {param} in --command with no
 * key in space.json, an unlocked or edited eval, uncommitted tracked changes, a
 * missing Python or Optuna. Each trial claims an experiment slot, trains, and is
 * scored as `ml-ralph eval` would; a failed train command is logged as a failed
 * eval and the sweep goes on. When the experiment cap, the USD cap or the
 * wall-clock cap runs out, tune stops, names the limit and keeps what it logged.
 */
export async function runTuneCommand(
  args: string[],
  options: TuneCommandOptions = {},
): Promise<EvalCommandResult> {
  const parsed = parseArgs(args);
  if (!parsed.ok) return fail(`${parsed.error}\n\n${USAGE}`, 2);
  const a = parsed.args;

  const cwd = resolve(options.cwd ?? process.cwd());
  const spacePath = isAbsolute(a.space) ? a.space : resolve(cwd, a.space);
  let spaceJson: unknown;
  try {
    spaceJson = JSON.parse(await Bun.file(spacePath).text());
  } catch (error) {
    const why = error instanceof Error ? error.message : String(error);
    return fail(`Cannot read ${a.space} as JSON (${why}). No trial was run.`);
  }
  const validation = validateTuneSpace(spaceJson);
  if (!validation.valid) {
    const lines = validation.errors.map((e) => `  ${e.field}: ${e.message}`);
    return fail(`Invalid ${a.space}:\n${lines.join("\n")}\nNo trial was run.`);
  }
  const { space } = validation;
  for (const [flag, template] of [
    ["--command", a.command],
    ["--candidate", a.candidate],
  ] as const) {
    const unknown = findPlaceholders(template).filter(
      (name) => !Object.hasOwn(space, name),
    );
    if (unknown.length > 0) {
      return fail(
        `${flag} uses ${unknown.map((n) => `{${n}}`).join(", ")} but ${a.space} has no such key (keys: ${Object.keys(space).join(", ")}). No trial was run.`,
      );
    }
  }

  const projectDir = await findProjectDir(cwd);
  if (!projectDir) {
    return fail(
      "No .ml-ralph/ directory here or in any parent; run from your project directory. No trial was run.",
    );
  }
  const locked = await readLockedEval(projectDir);
  if (!locked.ok) return fail(`${locked.error} No trial was run.`);
  const commit = await evalCommit(projectDir);
  if (commit.state === "dirty") {
    return fail("commit your changes before tune. No trial was run.");
  }

  const budget = await readBudgetCaps(projectDir);
  if (!budget.ok) return fail(`${budget.error}. No trial was run.`);
  const caps = budget.caps;
  const limit = experimentCapFor(
    process.env,
    caps.max_experiments_per_iteration,
  );
  if (!limit.ok) return fail(`${limit.error}. No trial was run.`);

  const python = options.python ?? defaultPython();
  const started = await (options.startOptimizer ?? startOptuna)({
    python,
    space,
    sampler: a.sampler,
    direction: locked.contract.direction,
    seed: a.seed,
  });
  if (!started.ok) return fail(`${started.error} No trial was run.`);
  const { optimizer } = started;

  const recorded = await readRecordedBudget(projectDir);
  const startedAt = Date.now();
  const elapsedMinutes = () =>
    recorded.elapsed_minutes + (Date.now() - startedAt) / 60_000;
  /** The USD and wall-clock caps spent so far; spend is what the runner has recorded */
  const budgetLimit = (): Limit | null => {
    const hit = exhaustedCap(
      budgetStatus(caps, recorded.usd_spent, elapsedMinutes()),
    );
    return hit === "usd"
      ? "max_usd"
      : hit === "wall_clock"
        ? "max_wall_clock_minutes"
        : null;
  };

  const maximize = locked.contract.direction === "max";
  const sha = commit.state === "ok" ? commit.sha : null;
  const lines: string[] = [];
  let run = 0;
  let ok = 0;
  let failed = 0;
  let stopped: Limit | undefined;
  let best:
    | { eval_id: string; params: Params; mean: number; std: number }
    | undefined;
  let crash: string | undefined;
  let dirtyStop = false;

  try {
    for (let trial = 0; trial < a.trials; trial++) {
      stopped = budgetLimit() ?? undefined;
      if (stopped) break;
      if (limit.cap !== undefined) {
        if (
          !(await claimExperiment(projectDir, limit.iterationId, limit.cap))
        ) {
          stopped = "max_experiments_per_iteration";
          break;
        }
      }
      run++;
      const { id, params } = await optimizer.ask();

      const leftSeconds =
        caps.max_wall_clock_minutes === undefined
          ? Number.POSITIVE_INFINITY
          : Math.max(1, (caps.max_wall_clock_minutes - elapsedMinutes()) * 60);
      const train = await runTrain(
        substituteParams(a.command, params, true),
        cwd,
        Math.min(a.timeout ?? DEFAULT_EVAL_TIMEOUT_SECONDS, leftSeconds),
      );
      let failure = train.ok ? undefined : train.reason;
      if (train.ok) {
        // Training may have touched tracked files; a score must stay tied to a commit
        const now = await evalCommit(projectDir);
        if (now.state === "dirty") {
          failure =
            "tracked files changed while training; commit them or keep training output untracked";
          dirtyStop = true;
        }
      }

      const candidate = substituteParams(a.candidate, params, false);
      const result = await scoreCandidate({
        projectDir,
        locked,
        sha,
        candidatePath: isAbsolute(candidate)
          ? candidate
          : resolve(cwd, candidate),
        python,
        trial: { trial: id, params },
        failure,
      });
      const m = result.metrics;
      if (m?.status === "ok") {
        ok++;
        await optimizer.tell(id, m.mean);
        lines.push(
          `trial ${id}: ${m.eval_id} mean ${m.mean} ${JSON.stringify(params)}`,
        );
        if (!best || (maximize ? m.mean > best.mean : m.mean < best.mean)) {
          best = { eval_id: m.eval_id, params, mean: m.mean, std: m.std };
        }
      } else {
        failed++;
        await optimizer.tell(id, null);
        lines.push(
          `trial ${id}: failed ${JSON.stringify(params)} (${m?.status === "failed" ? m.reason : result.stderr.trim()})`,
        );
      }
      // The tree stays dirty, so every later trial would fail the same way
      if (dirtyStop) break;
    }
  } catch (error) {
    crash = error instanceof Error ? error.message : String(error);
  } finally {
    await optimizer.close();
  }

  const event: Omit<TuneResultEvent, "ts"> = {
    type: "tune_result",
    sampler: a.sampler,
    trials_requested: a.trials,
    trials_run: run,
    trials_ok: ok,
    trials_failed: failed,
    ...(best
      ? {
          best_eval_id: best.eval_id,
          best_params: best.params,
          best_mean: best.mean,
        }
      : {}),
    ...(stopped ? { stopped } : {}),
  };
  await appendValidatedEvent(projectDir, event);

  const summary = [
    ...lines,
    `tune: ${run} of ${a.trials} trials run (${a.sampler}), ${ok} scored, ${failed} failed`,
    best
      ? `best eval_id: ${best.eval_id}\nbest params: ${JSON.stringify(best.params)}\nbest mean: ${best.mean} (std ${best.std})\nThis is a candidate only: tune never promotes. To hand it in, train with these params, commit, then run ml-ralph eval.`
      : "No trial produced a score.",
  ];
  if (dirtyStop) {
    summary.push(
      "tune stopped early: training left tracked files uncommitted, so no later trial could be scored. Keep training output untracked (or gitignored), or commit it, and run tune again.",
    );
  }
  if (crash) summary.push(`tune stopped early: ${crash}`);
  if (stopped) {
    summary.push(
      `tune stopped early: ${describeLimit(stopped, caps, limit.cap)} is exhausted. The ${run} completed trials stay logged.`,
    );
  }
  const text = `${summary.join("\n")}\n`;
  const code = stopped || crash || dirtyStop || !best ? 1 : 0;
  return {
    code,
    stdout: code === 0 ? text : "",
    stderr: code === 0 ? "" : text,
  };
}
