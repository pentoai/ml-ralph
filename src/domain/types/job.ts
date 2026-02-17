/**
 * Training job types - long-running training processes
 */

import type { JobStatus } from "./enums.ts";

export interface JobMetrics {
  epoch?: number;
  step?: number;
  [key: string]: number | undefined;
}

export interface TrainingJob {
  id: string; // "job_20260126_103000"
  storyId: string;
  experimentId: string;

  // Process
  pid: number;
  command: string; // What was executed
  logPath: string; // Path to log file

  // Tracking
  wandbRunId?: string;
  wandbUrl?: string;

  // Timing
  startedAt: string; // ISO timestamp
  completedAt?: string; // ISO timestamp

  // Status
  status: JobStatus;
  exitCode?: number;
  error?: string;

  // Cached metrics (from W&B)
  latestMetrics?: JobMetrics;
  lastMetricsUpdate?: string; // ISO timestamp
}

/**
 * Create a new training job
 */
export function createTrainingJob(
  partial: Pick<
    TrainingJob,
    "storyId" | "experimentId" | "pid" | "command" | "logPath"
  > &
    Partial<Pick<TrainingJob, "wandbRunId" | "wandbUrl">>,
): TrainingJob {
  return {
    ...partial,
    id: `job_${Date.now()}`,
    startedAt: new Date().toISOString(),
    status: "running",
  };
}
