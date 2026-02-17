/**
 * PRD validation functions
 */

import type { PRD, Story } from "../types/index.ts";

export interface ValidationError {
  field: string;
  message: string;
}

export interface ValidationResult {
  valid: boolean;
  errors: ValidationError[];
}

/**
 * Validate a story
 */
export function validateStory(story: Story): ValidationResult {
  const errors: ValidationError[] = [];

  // ID format
  if (!/^US-\d{3}$/.test(story.id)) {
    errors.push({
      field: "id",
      message: "Story ID must match format US-XXX (e.g., US-001)",
    });
  }

  // Required fields
  if (!story.title.trim()) {
    errors.push({ field: "title", message: "Title is required" });
  }

  if (!story.description.trim()) {
    errors.push({ field: "description", message: "Description is required" });
  }

  if (!story.hypothesis.trim()) {
    errors.push({ field: "hypothesis", message: "Hypothesis is required" });
  }

  // Hypothesis format (soft validation - just a warning style)
  if (
    story.hypothesis &&
    !story.hypothesis.toLowerCase().includes("if") &&
    !story.hypothesis.toLowerCase().includes("then")
  ) {
    errors.push({
      field: "hypothesis",
      message: 'Hypothesis should follow "If X, then Y because Z" pattern',
    });
  }

  // Superseded reference
  if (story.supersededBy && !/^US-\d{3}$/.test(story.supersededBy)) {
    errors.push({
      field: "supersededBy",
      message: "supersededBy must reference a valid story ID",
    });
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

/**
 * Validate a PRD
 */
export function validatePRD(prd: PRD): ValidationResult {
  const errors: ValidationError[] = [];

  // Required fields
  if (!prd.project.trim()) {
    errors.push({ field: "project", message: "Project name is required" });
  }

  if (!prd.goal.trim()) {
    errors.push({ field: "goal", message: "Goal is required" });
  }

  if (!prd.evaluation.metric.trim()) {
    errors.push({
      field: "evaluation.metric",
      message: "Evaluation metric is required",
    });
  }

  if (!prd.evaluation.validationStrategy.trim()) {
    errors.push({
      field: "evaluation.validationStrategy",
      message: "Validation strategy is required",
    });
  }

  // Unique story IDs
  const storyIds = prd.stories.map((s) => s.id);
  const uniqueIds = new Set(storyIds);
  if (storyIds.length !== uniqueIds.size) {
    errors.push({
      field: "stories",
      message: "Story IDs must be unique",
    });
  }

  // Validate each story
  for (const story of prd.stories) {
    const storyResult = validateStory(story);
    for (const error of storyResult.errors) {
      errors.push({
        field: `stories.${story.id}.${error.field}`,
        message: error.message,
      });
    }

    // Check supersededBy references valid story
    if (story.supersededBy && !storyIds.includes(story.supersededBy)) {
      errors.push({
        field: `stories.${story.id}.supersededBy`,
        message: `References non-existent story: ${story.supersededBy}`,
      });
    }
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}
