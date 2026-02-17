/**
 * Process/Job manager types
 */

import type { TrainingJob } from "../../domain/types/index.ts";

export interface JobManager {
  /**
   * Launch a training job as a detached process
   */
  launch(command: string[], options: LaunchOptions): Promise<TrainingJob>;

  /**
   * Check if a job is still running
   */
  isRunning(pid: number): boolean;

  /**
   * Stop a running job
   */
  stop(pid: number): Promise<boolean>;

  /**
   * Get the exit code of a completed job
   */
  getExitCode(pid: number): number | null;
}

export interface LaunchOptions {
  storyId: string;
  experimentId: string;
  cwd: string;
  logPath: string;
  wandbRunId?: string;
  wandbUrl?: string;
}
