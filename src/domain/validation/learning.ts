/**
 * Learning validation functions
 */

import type { Learning } from "../types/index.ts";

export interface ValidationError {
  field: string;
  message: string;
}

export interface ValidationResult {
  valid: boolean;
  errors: ValidationError[];
}

const MAX_INSIGHT_LENGTH = 200;

/**
 * Validate a learning
 */
export function validateLearning(learning: Learning): ValidationResult {
  const errors: ValidationError[] = [];

  // Required fields
  if (!learning.insight.trim()) {
    errors.push({ field: "insight", message: "Insight is required" });
  }

  // Insight length
  if (learning.insight.length > MAX_INSIGHT_LENGTH) {
    errors.push({
      field: "insight",
      message: `Insight must be ${MAX_INSIGHT_LENGTH} characters or less`,
    });
  }

  // Implications
  if (!learning.implications || learning.implications.length === 0) {
    errors.push({
      field: "implications",
      message: "At least one implication is required",
    });
  }

  // Source
  if (!learning.source.storyId.trim()) {
    errors.push({
      field: "source.storyId",
      message: "Source story ID is required",
    });
  }

  if (!learning.source.evidence.trim()) {
    errors.push({
      field: "source.evidence",
      message: "Evidence is required",
    });
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}
