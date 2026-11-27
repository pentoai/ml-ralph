/**
 * Ablations - after a completed run, revert each commit between the baseline
 * and ralph/best one at a time and score the result with the locked evaluator.
 * Evidence only: nothing here promotes, moves a tag or touches the project's
 * working tree (every revert happens in a throwaway git worktree).
 */

import { realpath, rm } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { readLockedEval, scoreCandidate } from "./eval-command.ts";
import { runGit } from "./git.ts";
import { BASELINE_PATH, BEST_TAG, readIncumbent } from "./promotion.ts";
import type { CommandWrapper } from "./sandbox.ts";

export const DEFAULT_MAX_ABLATIONS = 5;
export const ABLATION_DIR = ".ml-ralph/ablation";

export type AblationSkip = "cap" | "budget" | "stopped";

/** One row of the report's Ablations table; `evalId` links failed evals too */
export interface AblationRow {
  /** The commit that was reverted */
  sha: string;
  status: "ok" | "failed" | "skipped";
  /** "cap" | "budget" | "stopped" when skipped, the cause when failed */
  reason?: string;
  evalId?: string;
  mean?: number;
  std?: number;
}

export type AblationOutcome =
  | { state: "disabled" }
  | { state: "none" }
  | { state: "ran"; rows: AblationRow[] };

export type MaxAblationsResult =
  | { ok: true; max: number }
  | { ok: false; error: string };

/** `max_ablations` from config.json: a non-negative integer, default 5, 0 disables */
export async function readMaxAblations(
  projectPath: string,
): Promise<MaxAblationsResult> {
  let value: unknown;
  try {
    const config = (await Bun.file(
      join(projectPath, ".ml-ralph/config.json"),
    ).json()) as Record<string, unknown> | null;
    value = config?.max_ablations;
  } catch {
    return { ok: true, max: DEFAULT_MAX_ABLATIONS };
  }
  if (value === undefined || value === null) {
    return { ok: true, max: DEFAULT_MAX_ABLATIONS };
  }
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    return {
      ok: false,
      error: `config.json: max_ablations must be a non-negative integer (got ${JSON.stringify(value)})`,
    };
  }
  return { ok: true, max: value };
}

async function readBaseline(projectPath: string): Promise<string | null> {
  try {
    const v = (await Bun.file(`${projectPath}/${BASELINE_PATH}`).json()) as {
      ref?: unknown;
    } | null;
    return typeof v?.ref === "string" && v.ref ? v.ref : null;
  } catch {
    return null;
  }
}

/** ralph/best and the commits after the baseline that lead to it, oldest first; null when nothing was promoted */
export async function deriveAblations(
  projectPath: string,
): Promise<{ best: string; commits: string[] } | null> {
  const incumbent = await readIncumbent(projectPath);
  if (incumbent.state !== "ok") return null;
  const baseline = await readBaseline(projectPath);
  if (!baseline) return null;
  const tag = await runGit(projectPath, [
    "rev-parse",
    "--verify",
    `refs/tags/${BEST_TAG}^{commit}`,
  ]);
  const best = tag.code === 0 ? tag.out.trim() : incumbent.incumbent.ref;
  const base = await runGit(projectPath, [
    "rev-parse",
    "--verify",
    `${baseline}^{commit}`,
  ]);
  if (base.code !== 0 || base.out.trim() === best) return null;
  const list = await runGit(projectPath, [
    "rev-list",
    "--reverse",
    "--no-merges",
    `${base.out.trim()}..${best}`,
  ]);
  if (list.code !== 0) return null;
  const commits = list.out.split("\n").filter(Boolean);
  return commits.length > 0 ? { best, commits } : null;
}

export interface AblationOptions {
  projectPath: string;
  runId: string;
  maxAblations: number;
  /** Why no more ablations may start (budget caps, a stop), or null to go on */
  stopReason: () => "budget" | "stopped" | null;
  /** Called with each finished row, so the runner can log it */
  onRow: (row: AblationRow) => Promise<void>;
  python?: string;
  /** Docker mode: run the evaluator, and with it the reverted candidate code, in a container as search evals do */
  wrap?: CommandWrapper;
}

const NO_HOOKS = ["-c", "core.hooksPath=/dev/null"];
const IDENTITY = [
  "-c",
  "user.name=ml-ralph",
  "-c",
  "user.email=ml-ralph@localhost",
];

/**
 * Run the ablation phase. Never throws and never changes ralph/best: each
 * revert is committed on a detached worktree under .ml-ralph/ablation/.
 */
export async function runAblations(
  o: AblationOptions,
): Promise<AblationOutcome> {
  const { projectPath } = o;
  if (o.maxAblations === 0) return { state: "disabled" };
  const derived = await deriveAblations(projectPath).catch(() => null);
  if (!derived) return { state: "none" };

  const rows: AblationRow[] = [];
  const push = async (row: AblationRow) => {
    rows.push(row);
    await o.onRow(row);
  };
  const { best, commits } = derived;
  const failAll = async (from: number, reason: string) => {
    for (const sha of commits.slice(from)) {
      await push({ sha, status: "failed", reason });
    }
  };

  const locked = await readLockedEval(projectPath);
  if (!locked.ok) {
    await failAll(0, oneLine(locked.error));
    return { state: "ran", rows };
  }
  const incumbent = await readIncumbent(projectPath);
  const candidate =
    incumbent.state === "ok" ? incumbent.incumbent.candidate : "";
  // The container mounts the real path, so every path handed to it must be the real one
  const projectAbs = await realpath(projectPath).catch(() =>
    resolve(projectPath),
  );
  o = { ...o, projectPath: projectAbs };
  const candidateRel = isAbsolute(candidate)
    ? relative(projectAbs, candidate)
    : candidate;
  if (!candidateRel || candidateRel.startsWith("..")) {
    await failAll(
      0,
      "the incumbent's candidate is not a path inside the project",
    );
    return { state: "ran", rows };
  }

  const dir = join(projectAbs, ABLATION_DIR, o.runId);
  await rm(dir, { recursive: true, force: true }).catch(() => {});
  const added = await runGit(projectAbs, [
    "worktree",
    "add",
    "--detach",
    dir,
    best,
  ]);
  if (added.code !== 0) {
    await failAll(0, oneLine(`worktree: ${added.err}`));
    return { state: "ran", rows };
  }

  try {
    for (const [i, sha] of commits.entries()) {
      if (i >= o.maxAblations) {
        await push({ sha, status: "skipped", reason: "cap" });
        continue;
      }
      const stop = o.stopReason();
      if (stop) {
        await push({ sha, status: "skipped", reason: stop });
        continue;
      }
      await push(await ablateOne(o, locked, dir, best, sha, candidateRel));
    }
  } finally {
    await runGit(projectAbs, ["worktree", "remove", "--force", dir]);
    await rm(dir, { recursive: true, force: true }).catch(() => {});
    await runGit(projectAbs, ["worktree", "prune"]);
  }
  return { state: "ran", rows };
}

const oneLine = (text: string) => {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > 200 ? `${line.slice(0, 197)}...` : line;
};

async function ablateOne(
  o: AblationOptions,
  locked: Extract<Awaited<ReturnType<typeof readLockedEval>>, { ok: true }>,
  dir: string,
  best: string,
  sha: string,
  candidateRel: string,
): Promise<AblationRow> {
  try {
    await runGit(dir, ["reset", "--hard", best]);
    await runGit(dir, ["clean", "-fdx"]);
    const revert = await runGit(dir, [
      ...NO_HOOKS,
      "revert",
      "--no-commit",
      sha,
    ]);
    if (revert.code !== 0) {
      await runGit(dir, ["revert", "--abort"]);
      return {
        sha,
        status: "failed",
        reason: "revert did not apply cleanly",
      };
    }
    const commit = await runGit(dir, [
      ...NO_HOOKS,
      ...IDENTITY,
      "commit",
      "--allow-empty",
      "--no-verify",
      "-m",
      `ablation: revert ${sha}`,
    ]);
    const head = await runGit(dir, ["rev-parse", "HEAD"]);
    if (commit.code !== 0 || head.code !== 0) {
      return {
        sha,
        status: "failed",
        reason: oneLine(
          `could not commit the revert: ${commit.err || head.err}`,
        ),
      };
    }
    const result = await scoreCandidate({
      projectDir: resolve(o.projectPath),
      locked,
      sha: head.out.trim(),
      candidatePath: join(dir, candidateRel),
      wrap: o.wrap,
      python: o.python ?? (Bun.which("python") ? "python" : "python3"),
    });
    const m = result.metrics;
    if (!m) {
      return { sha, status: "failed", reason: oneLine(result.stderr) };
    }
    if (m.status === "ok") {
      return { sha, status: "ok", evalId: m.eval_id, mean: m.mean, std: m.std };
    }
    return {
      sha,
      status: "failed",
      reason: oneLine(m.reason),
      evalId: m.eval_id,
    };
  } catch (error) {
    return {
      sha,
      status: "failed",
      reason: oneLine(error instanceof Error ? error.message : String(error)),
    };
  }
}
