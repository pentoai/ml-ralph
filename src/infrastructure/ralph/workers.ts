/**
 * Runner-managed workers - up to two iteration loops, each in its own git
 * worktree, sharing one budget and one log.
 *
 * A worktree holds a worker's code. Its `.ml-ralph/` is a real directory of
 * symlinks to the project's state (so the agent's file tools see the same
 * RALPH.md, kanban and evals), except `conclusions.md`, which is the worker's
 * own. `.ml-ralph/worker.json` tells the CLI tools run there which project
 * they belong to. The runner merges the workers' conclusions at iteration
 * boundaries (see mergeConclusions).
 */

import {
  appendFile,
  lstat,
  mkdir,
  readdir,
  readlink,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { runGit } from "./git.ts";
import { WORKER_MARKER } from "./log-command.ts";

export const MAX_WORKERS = 2;
export const WORKTREES_DIR = ".ml-ralph/worktrees";

const CONCLUSIONS = "conclusions.md";
/** State directories the agent or its tools write into */
const SHARED_DIRS = ["evals", "budget", "runs"];

/** Parse a `--workers` value: 1 (the default) or 2; anything else is refused with the reason */
export function parseWorkers(
  value: string | undefined,
): { ok: true; workers: number } | { ok: false; error: string } {
  if (value === undefined) return { ok: true, workers: 1 };
  const n = /^\d+$/.test(value) ? Number(value) : Number.NaN;
  if (!Number.isInteger(n) || n < 1) {
    return {
      ok: false,
      error: `--workers must be 1 or ${MAX_WORKERS}, got ${JSON.stringify(value)}`,
    };
  }
  if (n > MAX_WORKERS) {
    return {
      ok: false,
      error: `--workers supports at most ${MAX_WORKERS} workers, got ${n}`,
    };
  }
  return { ok: true, workers: n };
}

export const workerDir = (projectPath: string, worker: number) =>
  join(projectPath, WORKTREES_DIR, `worker-${worker}`);

/**
 * One merged view of the workers' conclusions: each worker's text under a
 * `[worker N]` tag, by concatenation. Workers with nothing yet are left out.
 */
export function mergeConclusions(
  sections: { worker: number; text: string }[],
): string {
  return sections
    .filter((s) => s.text.trim())
    .map((s) => `[worker ${s.worker}]\n${s.text.trim()}`)
    .join("\n\n");
}

/**
 * Undo mergeConclusions: the text under each `[worker N]` tag, by worker.
 * Text with no tags (a single-worker run's conclusions) belongs to worker 1.
 */
export function splitConclusions(text: string): Map<number, string> {
  const sections = new Map<number, string>();
  if (!text.trim()) return sections;
  if (!/^\[worker \d+\]$/m.test(text)) return sections.set(1, text);
  let current: number | null = null;
  for (const line of text.split("\n")) {
    const tag = line.match(/^\[worker (\d+)\]$/);
    if (tag) {
      current = Number(tag[1]);
      continue;
    }
    if (current !== null) {
      sections.set(current, `${sections.get(current) ?? ""}${line}\n`);
    }
  }
  return sections;
}

export interface Worktree {
  worker: number;
  /** The worktree directory: the cwd of the worker's claude process */
  dir: string;
  branch: string;
  /** Added to the worker's environment so its git calls ignore the links (and nothing else) */
  env: Record<string, string>;
}

/** Whether `projectPath` is a git repository with at least one commit, which a worktree is made from */
export async function checkWorktreeSupport(
  projectPath: string,
): Promise<string | null> {
  const head = await runGit(projectPath, ["rev-parse", "--verify", "HEAD"]);
  return head.code === 0
    ? null
    : "--workers needs a git repository with at least one commit: each worker runs in a git worktree";
}

/**
 * Create a worker's worktree on a new branch at HEAD and link the project's
 * state into it. Untracked top-level entries of the project (data, virtualenvs)
 * are linked too, so the worker's code finds its inputs.
 */
export async function createWorktree(
  projectPath: string,
  worker: number,
  options: { runId: string; conclusions: string },
): Promise<Worktree> {
  // Real paths, so the links and the marker also resolve inside a container that mounts the real path
  projectPath = await realpath(projectPath);
  const dir = workerDir(projectPath, worker);
  const branch = `ralph/${options.runId.slice(0, 8)}-worker-${worker}`;
  await removeWorktreeDir(projectPath, dir);
  await mkdir(join(projectPath, WORKTREES_DIR), { recursive: true });
  const added = await runGit(projectPath, [
    "worktree",
    "add",
    "-b",
    branch,
    dir,
    "HEAD",
  ]);
  if (added.code !== 0) {
    throw new Error(
      `git worktree add failed for worker ${worker}: ${added.err.trim().slice(-300)}`,
    );
  }
  const linked: string[] = [".ml-ralph"];
  try {
    await linkState(projectPath, dir, worker, options.conclusions, linked);
  } catch (error) {
    await removeWorktreeDir(projectPath, dir);
    throw error;
  }

  // Keep the links and the state out of the worker's commits, for the git calls its agent makes.
  // An environment-level setting leaves the shared .git/info/exclude and the repository's config alone.
  const excludeFile = join(dir, ".ml-ralph", "worker.exclude");
  await writeFile(excludeFile, `${linked.map((n) => `/${n}`).join("\n")}\n`);
  return {
    worker,
    dir,
    branch,
    env: {
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "core.excludesFile",
      GIT_CONFIG_VALUE_0: excludeFile,
    },
  };
}

/** Fill a fresh worktree: the project's state and untracked entries as links, the worker's own conclusions, the marker */
async function linkState(
  projectPath: string,
  dir: string,
  worker: number,
  conclusions: string,
  linked: string[],
): Promise<void> {
  const state = join(projectPath, ".ml-ralph");
  const own = join(dir, ".ml-ralph");
  // What the agent writes with its file tools must land in the shared state, so these exist before they are linked
  await appendFile(join(state, "log.jsonl"), "");
  for (const name of SHARED_DIRS)
    await mkdir(join(state, name), { recursive: true });
  // A tracked .ml-ralph/ came along with the checkout: the worker sees the project's files instead
  await rm(own, { recursive: true, force: true });
  await mkdir(own, { recursive: true });
  for (const name of await readdir(state)) {
    if (name === "worktrees" || name === CONCLUSIONS) continue;
    await symlink(join(state, name), join(own, name));
  }
  for (const name of await readdir(projectPath)) {
    if (name === ".git" || name === ".ml-ralph") continue;
    const target = join(dir, name);
    if (await exists(target)) continue;
    await symlink(join(projectPath, name), target);
    linked.push(name);
  }
  await writeFile(join(own, CONCLUSIONS), conclusions);
  await writeFile(
    join(own, WORKER_MARKER),
    `${JSON.stringify({ worker, project: projectPath }, null, 2)}\n`,
  );
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch {
    return false;
  }
}

/** Remove one worktree directory and its registration; never throws */
async function removeWorktreeDir(
  projectPath: string,
  dir: string,
): Promise<void> {
  // Links go first, so nothing below can reach the project's data through one
  await unlinkLinks(dir);
  await runGit(projectPath, ["worktree", "remove", "--force", dir]);
  // A crashed run can leave a directory git no longer knows (or never finished creating)
  await rm(dir, { recursive: true, force: true }).catch(() => {});
  await runGit(projectPath, ["worktree", "prune"]);
}

/**
 * Remove the worktrees of a run. The worker branches stay: the commits the
 * evals scored (and the ralph/best tag) are reachable from them.
 */
export async function removeWorktrees(
  projectPath: string,
  worktrees: Worktree[],
): Promise<void> {
  for (const w of worktrees) await removeWorktreeDir(projectPath, w.dir);
}

/**
 * Clean up after a run that crashed: every directory left under
 * .ml-ralph/worktrees/ goes, and git forgets worktrees whose directory is
 * gone. Returns the directories removed.
 */
export async function cleanStaleWorktrees(
  projectPath: string,
): Promise<string[]> {
  const root = join(projectPath, WORKTREES_DIR);
  let names: string[] = [];
  try {
    names = await readdir(root);
  } catch {
    // No worktree directory: nothing to remove
  }
  const removed: string[] = [];
  for (const name of names) {
    const dir = join(root, name);
    await removeWorktreeDir(projectPath, dir);
    removed.push(dir);
  }
  await runGit(projectPath, ["worktree", "prune"]);
  return removed;
}

/** Remove the symlinks at the top level of a worktree and in its .ml-ralph/, never following them */
async function unlinkLinks(dir: string): Promise<void> {
  for (const base of [dir, join(dir, ".ml-ralph")]) {
    let names: string[] = [];
    try {
      names = await readdir(base);
    } catch {
      continue;
    }
    for (const name of names) {
      const path = join(base, name);
      try {
        await readlink(path);
        await rm(path, { force: true });
      } catch {
        // Not a link
      }
    }
  }
}
