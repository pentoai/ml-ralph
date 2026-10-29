/**
 * Stop-job flow behind the t key, kept free of React so it can be tested
 */

import type { TrainingJob } from "../domain/types/index.ts";
import type { StopJobResult } from "../infrastructure/ralph/index.ts";

export interface StopJobDeps {
  stop: (job: TrainingJob) => Promise<StopJobResult>;
  /** Re-read active.json into the job list */
  refresh: () => Promise<void>;
  setNotice: (notice: string | null) => void;
  closeLog: () => void;
}

/** What the user sees after a stop attempt */
export function stopNotice(job: TrainingJob, result: StopJobResult): string {
  return result.outcome === "stopped"
    ? `stopping ${job.id} (SIGKILL in 10s if it ignores SIGTERM)`
    : result.message;
}

/**
 * Stop a job, refresh the list, and only then set the notice, so nothing
 * that reacts to the refresh can wipe it before it is shown.
 */
export async function stopSelectedJob(
  job: TrainingJob,
  deps: StopJobDeps,
): Promise<void> {
  try {
    const result = await deps.stop(job);
    deps.closeLog();
    await deps.refresh();
    deps.setNotice(stopNotice(job, result));
  } catch (error) {
    deps.setNotice(`Failed to stop job: ${(error as Error).message}`);
  }
}

export interface FollowLogDeps {
  logPath: string;
  tail: (logPath: string) => Promise<string[] | null>;
  onLines: (lines: string[]) => void;
  /** True while the user has scrolled up: the view must not slide, so reloads pause */
  isPaused: () => boolean;
  intervalMs?: number;
}

/**
 * Reload a job's log tail on an interval. Stopping does one last reload (even
 * when paused) so the lines written just before the job exited still appear.
 */
export function followJobLog(deps: FollowLogDeps): () => void {
  const reload = () =>
    deps.tail(deps.logPath).then((lines) => {
      if (lines !== null) deps.onLines(lines);
    });
  const timer = setInterval(() => {
    if (!deps.isPaused()) void reload();
  }, deps.intervalMs ?? 1000);
  return () => {
    clearInterval(timer);
    void reload();
  };
}
