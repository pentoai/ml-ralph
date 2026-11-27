/**
 * GPU-hours ledger: one record per `ml-ralph job start --gpus N` job under
 * .ml-ralph/budget/gpu-jobs/, so the run's usage survives job ends and restarts
 */

import { mkdir, readdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

const LEDGER_DIR = ".ml-ralph/budget/gpu-jobs";
const MS_PER_HOUR = 3_600_000;

/** Milliseconds between heartbeats of a running job's ledger record */
export const HEARTBEAT_MS = 30_000;

export interface GpuJobRecord {
  job_id: string;
  run_id: string;
  gpus: number;
  pid: number;
  started_at: number;
  /** Last time the job's `job start` process confirmed the job was alive */
  last_seen: number;
  ended_at?: number;
}

const recordPath = (projectDir: string, jobId: string) =>
  join(projectDir, LEDGER_DIR, `${jobId}.json`);

/** Write (or replace) a job's record atomically, so a reader never sees half of it */
export async function writeGpuJob(
  projectDir: string,
  record: GpuJobRecord,
): Promise<void> {
  await mkdir(join(projectDir, LEDGER_DIR), { recursive: true });
  const tmp = `${recordPath(projectDir, record.job_id)}.${process.pid}.tmp`;
  await writeFile(tmp, `${JSON.stringify(record)}\n`);
  await rename(tmp, recordPath(projectDir, record.job_id));
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * GPU-hours of `runId`: gpus × runtime over its finished and running jobs.
 * A record with no end time counts up to now while its process is alive and up
 * to its last heartbeat once it is gone, so a killed wrapper stops accruing.
 */
export async function readGpuHours(
  projectDir: string,
  runId: string | null,
  now = Date.now(),
  alive: (pid: number) => boolean = pidAlive,
): Promise<number> {
  if (!runId) return 0;
  let names: string[];
  try {
    names = await readdir(join(projectDir, LEDGER_DIR));
  } catch {
    return 0;
  }
  let hours = 0;
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    try {
      const r = (await Bun.file(
        join(projectDir, LEDGER_DIR, name),
      ).json()) as GpuJobRecord;
      if (r.run_id !== runId) continue;
      const end = r.ended_at ?? (alive(r.pid) ? now : r.last_seen);
      hours += (r.gpus * Math.max(0, end - r.started_at)) / MS_PER_HOUR;
    } catch {
      // A torn or foreign file is not a record
    }
  }
  return hours;
}
