/**
 * Learning types - structured insights extracted from iterations
 */

import type {
  LearningCategory,
  LearningConfidence,
  LearningImpact,
} from "./enums.ts";

export interface LearningSource {
  storyId: string; // Which story
  experimentId?: string; // Which experiment
  wandbRunId?: string; // W&B run ID
  evidence: string; // What proved this
}

export interface Learning {
  id: string; // "L-001"
  timestamp: string; // ISO timestamp

  // Core content (top-level visibility)
  insight: string; // The learning (1-2 sentences)
  implications: string[]; // What to do differently

  // Extended content
  details?: string; // Longer explanation

  // Categorization
  category: LearningCategory;
  tags: string[]; // Freeform tags for search

  // Provenance
  source: LearningSource;

  // Assessment
  impact: LearningImpact;
  confidence: LearningConfidence;

  // Connections
  appliesTo?: string[]; // Story IDs this affects
}

/**
 * Create a new learning with defaults
 */
export function createLearning(
  partial: Omit<Learning, "id" | "timestamp">,
): Learning {
  return {
    ...partial,
    id: `L-${Date.now()}`,
    timestamp: new Date().toISOString(),
  };
}
