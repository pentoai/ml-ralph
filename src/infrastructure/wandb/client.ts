/**
 * W&B client implementation
 *
 * Note: This is a stub implementation. In production, this would use
 * the wandb npm package or the W&B API directly.
 */

import type { WandBClient, WandBMetrics, WandBRun } from "./types.ts";

export class StubWandBClient implements WandBClient {
  private project: string;
  private entity?: string;

  constructor(project: string, entity?: string) {
    this.project = project;
    this.entity = entity;
  }

  async getRun(runId: string): Promise<WandBRun | null> {
    // TODO: Implement actual W&B API call
    console.log(`[W&B Stub] getRun: ${runId} (project: ${this.project})`);
    return null;
  }

  async getMetrics(runId: string): Promise<WandBMetrics | null> {
    // TODO: Implement actual W&B API call
    console.log(`[W&B Stub] getMetrics: ${runId}`);
    return null;
  }

  async listRuns(_limit?: number): Promise<WandBRun[]> {
    // TODO: Implement actual W&B API call
    console.log(`[W&B Stub] listRuns (entity: ${this.entity})`);
    return [];
  }

  async isAvailable(): Promise<boolean> {
    // TODO: Check if W&B API key is configured
    return false;
  }
}

/**
 * Create a W&B client from project config
 */
export function createWandBClient(
  project: string,
  entity?: string,
): WandBClient {
  return new StubWandBClient(project, entity);
}
