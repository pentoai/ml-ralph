/**
 * Progress types - log of each iteration's work
 */

import type { EvidenceType, ProgressDecision, StoryType } from "./enums.ts";

export interface Evidence {
  type: EvidenceType;
  description: string;
  reference: string; // URL, path, or ID
}

export interface BacklogChange {
  change: string; // What changed
  reason: string; // Why
}

export interface ProgressEvaluation {
  datasetSplit: string; // e.g., "train/val 80/20"
  metric: string; // Primary metric name
  baseline: string; // Baseline value
  result: string; // Achieved value
  variance?: string; // Stability info
}

export interface ProgressEntry {
  id: string; // "P-001"
  timestamp: string; // ISO timestamp
  storyId: string;
  storyTitle: string;
  type: StoryType;

  // What was tried
  hypothesis: string;
  assumptions: string[];
  changes: string[]; // What code/config changed

  // Results
  evaluation: ProgressEvaluation;

  // Evidence
  evidence: Evidence[];

  // Decision
  decision: ProgressDecision;
  reasoning: string;
  nextStep: string;

  // Backlog updates (if any)
  backlogChanges?: BacklogChange[];
}

/**
 * Create a new progress entry with defaults
 */
export function createProgressEntry(
  partial: Omit<ProgressEntry, "id" | "timestamp">,
): ProgressEntry {
  return {
    ...partial,
    id: `P-${Date.now()}`,
    timestamp: new Date().toISOString(),
  };
}
