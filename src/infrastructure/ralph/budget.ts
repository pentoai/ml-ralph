/**
 * Run budget: the caps in config.json, the spend and time counted against them,
 * and what the agent is told about what is left
 */

import { mkdir, open, rm } from "node:fs/promises";
import { join } from "node:path";

/** Set by the runner on the claude process so `ml-ralph eval` knows which iteration it serves */
export const ITERATION_ENV = "ML_RALPH_ITERATION";

/** The experiment cap the runner read at start; `ml-ralph eval` never trusts a looser one from config.json */
export const MAX_EXPERIMENTS_ENV = "ML_RALPH_MAX_EXPERIMENTS";

const ITERATION_ID = /^[A-Za-z0-9_-]+$/;
const BUDGET_DIR = ".ml-ralph/budget";

export interface BudgetCaps {
  max_wall_clock_minutes?: number;
  max_usd?: number;
  max_experiments_per_iteration?: number;
}

export interface BudgetStatus {
  usd_spent: number;
  elapsed_minutes: number;
  max_usd?: number;
  max_wall_clock_minutes?: number;
  max_experiments_per_iteration?: number;
}

export type BudgetExhaustion = "usd" | "wall_clock";

type CapSpec = { key: keyof BudgetCaps; integer: boolean };
const CAP_KEYS: CapSpec[] = [
  { key: "max_wall_clock_minutes", integer: false },
  { key: "max_usd", integer: false },
  { key: "max_experiments_per_iteration", integer: true },
];

export type CapsResult =
  | { ok: true; caps: BudgetCaps }
  | { ok: false; error: string };

/** Validate the three cap keys of a parsed config.json; unset (absent or null) caps stay unset */
export function parseBudgetCaps(config: unknown): CapsResult {
  const raw = (config && typeof config === "object" ? config : {}) as Record<
    string,
    unknown
  >;
  const caps: BudgetCaps = {};
  for (const { key, integer } of CAP_KEYS) {
    const value = raw[key];
    if (value === undefined || value === null) continue;
    const valid =
      typeof value === "number" &&
      Number.isFinite(value) &&
      value > 0 &&
      (!integer || Number.isInteger(value));
    if (!valid) {
      return {
        ok: false,
        error: `config.json: ${key} must be a positive ${integer ? "integer" : "number"} (got ${JSON.stringify(value)})`,
      };
    }
    caps[key] = value;
  }
  return { ok: true, caps };
}

/** Read the caps from .ml-ralph/config.json; a missing or unreadable file sets none */
export async function readBudgetCaps(projectPath: string): Promise<CapsResult> {
  let config: unknown;
  try {
    config = await Bun.file(join(projectPath, ".ml-ralph/config.json")).json();
  } catch {
    return { ok: true, caps: {} };
  }
  return parseBudgetCaps(config);
}

/** Which cap, if any, the status has reached */
export function exhaustedCap(status: BudgetStatus): BudgetExhaustion | null {
  if (status.max_usd !== undefined && status.usd_spent >= status.max_usd) {
    return "usd";
  }
  if (
    status.max_wall_clock_minutes !== undefined &&
    status.elapsed_minutes >= status.max_wall_clock_minutes
  ) {
    return "wall_clock";
  }
  return null;
}

/**
 * Spend and elapsed time already recorded for `runId` in log.jsonl. The
 * budget_status events hold running totals, so the largest one counts.
 */
export function priorBudget(
  logText: string,
  runId: string,
): { usd_spent: number; elapsed_minutes: number } {
  let usd = 0;
  let minutes = 0;
  for (const line of logText.split("\n")) {
    if (!line.includes("budget_status")) continue;
    try {
      const e = JSON.parse(line) as Record<string, unknown>;
      if (e.type !== "budget_status" || e.run_id !== runId) continue;
      if (typeof e.usd_spent === "number") usd = Math.max(usd, e.usd_spent);
      if (typeof e.elapsed_minutes === "number") {
        minutes = Math.max(minutes, e.elapsed_minutes);
      }
    } catch {
      // A torn line is not a budget record
    }
  }
  return { usd_spent: usd, elapsed_minutes: minutes };
}

const round = (n: number) => Math.round(n * 10000) / 10000;

/** The status event fields: running totals plus every cap that is set */
export function budgetStatus(
  caps: BudgetCaps,
  usdSpent: number,
  elapsedMinutes: number,
): BudgetStatus {
  return {
    usd_spent: round(usdSpent),
    elapsed_minutes: round(elapsedMinutes),
    ...caps,
  };
}

/** The prompt section for an iteration; empty when no cap is set */
export function budgetPrompt(status: BudgetStatus): string {
  const lines: string[] = [];
  if (status.max_usd !== undefined) {
    const left = Math.max(0, status.max_usd - status.usd_spent);
    lines.push(
      `- USD remaining: $${left.toFixed(2)} of $${status.max_usd.toFixed(2)}`,
    );
  }
  if (status.max_wall_clock_minutes !== undefined) {
    const left = Math.max(
      0,
      status.max_wall_clock_minutes - status.elapsed_minutes,
    );
    lines.push(
      `- Minutes remaining: ${left.toFixed(1)} of ${status.max_wall_clock_minutes}`,
    );
  }
  if (status.max_experiments_per_iteration !== undefined) {
    lines.push(
      `- Experiments this iteration: at most ${status.max_experiments_per_iteration} \`ml-ralph eval\` calls; further calls fail`,
    );
  }
  if (lines.length === 0) return "";
  return `\n\nRun budget (the runner stops the run when USD or minutes run out, so plan the smallest experiments that still test your hypothesis):\n${lines.join("\n")}`;
}

const iterationDir = (projectDir: string, id: string) =>
  join(projectDir, BUDGET_DIR, `iteration-${id}`);

/** Forget the eval calls counted for an iteration id; the runner does this as the iteration starts */
export async function resetExperimentCount(
  projectDir: string,
  id: string,
): Promise<void> {
  await rm(iterationDir(projectDir, id), { recursive: true, force: true });
}

/**
 * The experiment cap that applies to an `ml-ralph eval` call: the smaller of
 * the cap the runner pinned in the environment and the one in config.json, so
 * raising either alone does not loosen it. A set cap needs a valid iteration
 * id; without one the call is refused (fail closed) rather than uncapped.
 */
export function experimentCapFor(
  env: Record<string, string | undefined>,
  configCap: number | undefined,
):
  | { ok: true; cap: number | undefined; iterationId: string }
  | { ok: false; error: string } {
  const pinned = env[MAX_EXPERIMENTS_ENV];
  const caps: number[] = [];
  if (pinned !== undefined) {
    const n = Number(pinned);
    if (!Number.isInteger(n) || n <= 0) {
      return {
        ok: false,
        error: `${MAX_EXPERIMENTS_ENV} is not a positive integer`,
      };
    }
    caps.push(n);
  }
  if (configCap !== undefined) caps.push(configCap);
  if (caps.length === 0) return { ok: true, cap: undefined, iterationId: "" };
  const iterationId = env[ITERATION_ENV];
  if (!iterationId || !ITERATION_ID.test(iterationId)) {
    return {
      ok: false,
      error: `an experiment cap is set but ${ITERATION_ENV} is missing or invalid; run eval from the runner's agent session`,
    };
  }
  return { ok: true, cap: Math.min(...caps), iterationId };
}

/**
 * Count one `ml-ralph eval` call against the iteration's cap. Each call claims
 * one of `cap` slot files with an exclusive create, so parallel calls cannot
 * both take the last slot. Returns false when every slot is taken.
 */
export async function claimExperiment(
  projectDir: string,
  id: string,
  cap: number,
): Promise<boolean> {
  if (!ITERATION_ID.test(id)) return false;
  const dir = iterationDir(projectDir, id);
  await mkdir(dir, { recursive: true });
  for (let slot = 1; slot <= cap; slot++) {
    try {
      await (await open(join(dir, String(slot)), "wx")).close();
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }
  return false;
}

/** The "no cap" or "$spent / $cap" and "elapsed / cap" lines of the TUI */
export function formatBudget(status: BudgetStatus): {
  usd: string;
  time: string;
} {
  const usd =
    status.max_usd === undefined
      ? `$${status.usd_spent.toFixed(2)} spent, no cap`
      : `$${status.usd_spent.toFixed(2)} / $${status.max_usd.toFixed(2)}`;
  const elapsed = `${status.elapsed_minutes.toFixed(1)} min`;
  const time =
    status.max_wall_clock_minutes === undefined
      ? `${elapsed}, no cap`
      : `${elapsed} / ${status.max_wall_clock_minutes} min`;
  return { usd, time };
}

/** Spend and time recorded for the run in progress (zeros for a new run), read from log.jsonl */
export async function readRecordedBudget(
  projectPath: string,
): Promise<{ usd_spent: number; elapsed_minutes: number }> {
  const runId = await readRunId(projectPath);
  if (!runId) return { usd_spent: 0, elapsed_minutes: 0 };
  const log = Bun.file(join(projectPath, ".ml-ralph/log.jsonl"));
  return priorBudget((await log.exists()) ? await log.text() : "", runId);
}

/**
 * What the TUI header shows before a run reports: the recorded totals and the
 * caps from config.json. Invalid caps are not shown as caps; `error` names them.
 */
export function headerBudget(
  config: unknown,
  recorded: { usd_spent: number; elapsed_minutes: number },
): { status: BudgetStatus; error?: string } {
  const parsed = parseBudgetCaps(config);
  return parsed.ok
    ? {
        status: budgetStatus(
          parsed.caps,
          recorded.usd_spent,
          recorded.elapsed_minutes,
        ),
      }
    : {
        status: budgetStatus({}, recorded.usd_spent, recorded.elapsed_minutes),
        error: parsed.error,
      };
}

/** Run id store: a run keeps its id across restarts so its budget_status events add up */
export async function readRunId(projectPath: string): Promise<string | null> {
  try {
    const data = (await Bun.file(
      join(projectPath, BUDGET_DIR, "run.json"),
    ).json()) as { run_id?: unknown };
    return typeof data.run_id === "string" ? data.run_id : null;
  } catch {
    return null;
  }
}

export async function writeRunId(
  projectPath: string,
  runId: string,
): Promise<void> {
  await mkdir(join(projectPath, BUDGET_DIR), { recursive: true });
  await Bun.write(
    join(projectPath, BUDGET_DIR, "run.json"),
    `${JSON.stringify({ run_id: runId })}\n`,
  );
}

export async function clearRunId(projectPath: string): Promise<void> {
  await rm(join(projectPath, BUDGET_DIR, "run.json"), { force: true });
}
