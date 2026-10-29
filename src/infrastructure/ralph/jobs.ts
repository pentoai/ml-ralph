/**
 * Training jobs: `ml-ralph job start <cmd>` records a job in
 * .ml-ralph/runs/active.json; the TUI lists, stops and tails them.
 */

import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { constants as osConstants } from "node:os";
import { dirname, join } from "node:path";
import type { TrainingJob } from "../../domain/types/index.ts";
import { findProjectDir } from "./log-command.ts";

/** Milliseconds between SIGTERM and SIGKILL when stopping a job */
export const KILL_GRACE_MS = 10_000;
export const LOG_TAIL_LINES = 50;

const activePath = (projectDir: string) =>
  join(projectDir, ".ml-ralph", "runs", "active.json");
const lockPath = (projectDir: string) =>
  join(projectDir, ".ml-ralph", "runs", ".active.lock");

export async function readActiveJobs(
  projectDir: string,
): Promise<TrainingJob[]> {
  try {
    const data = JSON.parse(await readFile(activePath(projectDir), "utf8"));
    return Array.isArray(data?.jobs) ? data.jobs : [];
  } catch {
    return [];
  }
}

/** Read-modify-write active.json under a lock, so concurrent jobs do not drop each other's entries */
async function updateActiveJobs(
  projectDir: string,
  change: (jobs: TrainingJob[]) => TrainingJob[],
): Promise<void> {
  await mkdir(dirname(activePath(projectDir)), { recursive: true });
  const lock = lockPath(projectDir);
  const deadline = Date.now() + 5000;
  while (true) {
    try {
      await mkdir(lock);
      break;
    } catch {
      if (Date.now() > deadline)
        await rm(lock, { recursive: true, force: true });
      else await new Promise((r) => setTimeout(r, 20));
    }
  }
  try {
    const jobs = change(await readActiveJobs(projectDir));
    const tmp = `${activePath(projectDir)}.${process.pid}.tmp`;
    await writeFile(tmp, `${JSON.stringify({ jobs }, null, 2)}\n`);
    await rename(tmp, activePath(projectDir));
  } finally {
    await rm(lock, { recursive: true, force: true });
  }
}

export async function removeActiveJob(
  projectDir: string,
  id: string,
): Promise<void> {
  await updateActiveJobs(projectDir, (jobs) => jobs.filter((j) => j.id !== id));
}

export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Drop entries whose process is gone (a wrapper killed with SIGKILL, a reboot); returns what was removed */
export async function pruneStaleJobs(
  projectDir: string,
  alive: (pid: number) => boolean = isPidAlive,
): Promise<TrainingJob[]> {
  const removed: TrainingJob[] = [];
  await updateActiveJobs(projectDir, (jobs) =>
    jobs.filter((job) => {
      if (alive(job.pid)) return true;
      removed.push(job);
      return false;
    }),
  );
  return removed;
}

export interface StopJobResult {
  /** stopped: SIGTERM sent; not_running: pid already gone; error: the kill failed */
  outcome: "stopped" | "not_running" | "error";
  message: string;
}

export interface StopJobOptions {
  graceMs?: number;
  /** Signal sender (default: the job's process group, then the pid) */
  kill?: (pid: number, signal: NodeJS.Signals | 0) => void;
}

function killJob(pid: number, signal: NodeJS.Signals | 0): void {
  try {
    process.kill(-pid, signal); // jobs run as their own process group
  } catch {
    process.kill(pid, signal);
  }
}

/**
 * SIGTERM the job, SIGKILL it after the grace period if it is still alive,
 * and remove its entry from active.json either way.
 */
export async function stopJob(
  projectDir: string,
  job: TrainingJob,
  options: StopJobOptions = {},
): Promise<StopJobResult> {
  const kill = options.kill ?? killJob;
  const graceMs = options.graceMs ?? KILL_GRACE_MS;
  let result: StopJobResult;
  try {
    kill(job.pid, "SIGTERM");
    result = { outcome: "stopped", message: `stopping ${job.id}` };
    const timer = setTimeout(() => {
      try {
        kill(job.pid, "SIGKILL");
      } catch {
        // already exited
      }
    }, graceMs);
    timer.unref?.();
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    result =
      code === "ESRCH"
        ? { outcome: "not_running", message: "job not running" }
        : { outcome: "error", message: (error as Error).message };
  }
  await removeActiveJob(projectDir, job.id);
  return result;
}

/** The last `lines` lines of the job's log, or null when the file is missing */
export async function tailJobLog(
  logPath: string,
  lines = LOG_TAIL_LINES,
): Promise<string[] | null> {
  let text: string;
  try {
    text = await readFile(logPath, "utf8");
  } catch {
    return null;
  }
  const all = text.split("\n");
  if (all[all.length - 1] === "") all.pop();
  return all.slice(-lines);
}

export interface JobCommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

const USAGE = `Usage: ml-ralph job start <cmd> [args...]

Runs the command, writes its pid, command, start time and log path to
.ml-ralph/runs/active.json, and removes the entry when it exits. Output goes
to the log file and to this terminal. A single argument runs through the shell.`;

/** `ml-ralph job start <cmd>`: run the command as a recorded job; resolves when it exits */
export async function runJobCommand(
  args: string[],
  options: { cwd?: string } = {},
): Promise<JobCommandResult> {
  const fail = (stderr: string): JobCommandResult => ({
    code: 1,
    stdout: "",
    stderr: `${stderr}\n`,
  });
  if (args[0] !== "start" || args.length < 2) return fail(USAGE);
  const cmd = args.slice(1);

  const cwd = options.cwd ?? process.cwd();
  const projectDir = await findProjectDir(cwd);
  if (!projectDir)
    return fail("No .ml-ralph/ directory found; run init first.");

  const id = `job_${Date.now()}_${process.pid}_${randomBytes(2).toString("hex")}`;
  const logPath = join(projectDir, ".ml-ralph", "runs", "logs", `${id}.log`);
  await mkdir(dirname(logPath), { recursive: true });
  const log = createWriteStream(logPath, { flags: "a" });

  const child =
    cmd.length === 1
      ? spawn("sh", ["-c", cmd[0] as string], { cwd, detached: true })
      : spawn(cmd[0] as string, cmd.slice(1), { cwd, detached: true });

  const exit = new Promise<number>((resolve) => {
    child.on("error", (error) => {
      process.stderr.write(`${error.message}\n`);
      resolve(127);
    });
    child.on("close", (code, signal) =>
      resolve(code ?? (signal ? 128 + (osConstants.signals[signal] ?? 15) : 1)),
    );
  });
  for (const [stream, sink] of [
    [child.stdout, process.stdout],
    [child.stderr, process.stderr],
  ] as const) {
    stream?.on("data", (chunk: Buffer) => {
      log.write(chunk);
      sink.write(chunk);
    });
  }

  if (child.pid === undefined) {
    log.end();
    return { code: await exit, stdout: "", stderr: "" };
  }
  const pid = child.pid;
  await updateActiveJobs(projectDir, (jobs) => [
    ...jobs.filter((j) => j.id !== id),
    {
      id,
      storyId: "",
      experimentId: "",
      pid,
      command: cmd.join(" "),
      logPath,
      startedAt: new Date().toISOString(),
      status: "running",
    },
  ]);

  const forward = (signal: NodeJS.Signals) => () => {
    try {
      killJob(pid, signal);
    } catch {
      // already gone
    }
  };
  const onTerm = forward("SIGTERM");
  const onInt = forward("SIGINT");
  process.on("SIGTERM", onTerm);
  process.on("SIGINT", onInt);

  const code = await exit;
  process.off("SIGTERM", onTerm);
  process.off("SIGINT", onInt);
  await new Promise<void>((resolve) => log.end(resolve));
  await removeActiveJob(projectDir, id);
  return { code, stdout: "", stderr: "" };
}
