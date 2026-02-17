/**
 * Job manager implementation
 */

import { spawn } from "bun";
import { generateJobId } from "../../domain/logic/index.ts";
import type { TrainingJob } from "../../domain/types/index.ts";
import type { JobManager, LaunchOptions } from "./types.ts";

export class BunJobManager implements JobManager {
  async launch(
    command: string[],
    options: LaunchOptions,
  ): Promise<TrainingJob> {
    const logFile = Bun.file(options.logPath);

    // Spawn detached process
    const proc = spawn({
      cmd: command,
      cwd: options.cwd,
      stdout: logFile,
      stderr: logFile,
    });

    // Unref to allow parent to exit
    proc.unref();

    const job: TrainingJob = {
      id: generateJobId(),
      storyId: options.storyId,
      experimentId: options.experimentId,
      pid: proc.pid,
      command: command.join(" "),
      logPath: options.logPath,
      wandbRunId: options.wandbRunId,
      wandbUrl: options.wandbUrl,
      startedAt: new Date().toISOString(),
      status: "running",
    };

    return job;
  }

  isRunning(pid: number): boolean {
    try {
      // Signal 0 checks if process exists without killing it
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }

  async stop(pid: number): Promise<boolean> {
    try {
      process.kill(pid, "SIGTERM");

      // Wait a bit for graceful shutdown
      await new Promise((resolve) => setTimeout(resolve, 1000));

      // Check if still running and force kill if needed
      if (this.isRunning(pid)) {
        process.kill(pid, "SIGKILL");
      }

      return true;
    } catch {
      return false;
    }
  }

  getExitCode(_pid: number): number | null {
    // Note: Getting exit code of a detached process is complex
    // For now, we rely on the job status being updated when checked
    return null;
  }
}
