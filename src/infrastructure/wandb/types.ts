/**
 * W&B client types
 */

export interface WandBRun {
  id: string;
  name: string;
  state: "running" | "finished" | "failed" | "crashed";
  url: string;
  config: Record<string, unknown>;
  summary: Record<string, unknown>;
  createdAt: string;
}

export interface WandBMetrics {
  [key: string]: number | string | undefined;
}

export interface WandBClient {
  /**
   * Get a specific run by ID
   */
  getRun(runId: string): Promise<WandBRun | null>;

  /**
   * Get the latest metrics for a run
   */
  getMetrics(runId: string): Promise<WandBMetrics | null>;

  /**
   * List recent runs for the project
   */
  listRuns(limit?: number): Promise<WandBRun[]>;

  /**
   * Check if W&B is configured and accessible
   */
  isAvailable(): Promise<boolean>;
}
