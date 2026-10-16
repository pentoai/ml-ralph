/**
 * Project configuration types
 */

import type { PackageManager } from "./enums.ts";

export interface WandBConfig {
  project: string;
  entity?: string; // Team/user name
}

export interface AgentConfig {
  autoAdvance: boolean; // Auto-start next story (default: true)
  maxIterationsPerStory?: number; // Safety limit
  enableTeams?: boolean; // Enable parallel experiments via agent teams (default: true)
}

export interface VerifierConfig {
  model?: string; // Model for the verifier session (default: the claude CLI default)
  recent_events?: number; // Log events included in the verifier prompt (default: 50)
}

export interface RuntimeConfig {
  packageManager: PackageManager;
  pythonVersion?: string;
}

export interface ProjectConfig {
  // Identity
  name: string;
  createdAt: string; // ISO timestamp

  // W&B
  wandb: WandBConfig;

  // Agent behavior
  agent: AgentConfig;

  // Independent verifier (read-only claude -p session)
  verifier?: VerifierConfig;

  // Tooling
  runtime: RuntimeConfig;
}

/**
 * Create default project config
 */
export function createDefaultConfig(name: string): ProjectConfig {
  return {
    name,
    createdAt: new Date().toISOString(),
    wandb: {
      project: name,
    },
    agent: {
      autoAdvance: true,
      enableTeams: true,
    },
    runtime: {
      packageManager: "uv",
    },
  };
}
