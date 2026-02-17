/**
 * PRD (Product Requirements Document) types
 */

import type { CriterionPriority, StoryStatus, StoryType } from "./enums.ts";

export interface SuccessCriterion {
  id: string;
  description: string;
  priority: CriterionPriority;
  validation: string; // How to verify this is met
}

export interface DataSource {
  name: string;
  path?: string;
  description: string;
  details?: Record<string, unknown>;
}

export interface EvaluationConfig {
  metric: string; // Primary metric (e.g., "AUC-ROC")
  validationStrategy: string; // e.g., "5-fold CV", "temporal split"
  testSet?: string; // Hold-out test set description
}

export interface Scope {
  inScope: string[];
  outOfScope: string[];
}

export interface Story {
  id: string; // "US-001"
  title: string;
  description: string;
  hypothesis: string; // "If X, then Y because Z"
  type: StoryType;
  status: StoryStatus;
  supersededBy?: string; // Story ID that replaced this
  createdAt: string; // ISO timestamp
  completedAt?: string; // ISO timestamp
}

export interface PRD {
  // Identity
  project: string; // Project name
  description: string; // What this project is about
  createdAt: string; // ISO timestamp
  updatedAt: string; // ISO timestamp

  // Goals
  goal: string; // Primary objective
  successCriteria: SuccessCriterion[];

  // Boundaries
  constraints: string[]; // Technical/business constraints
  scope: Scope;

  // Data
  dataSources: DataSource[];

  // Evaluation
  evaluation: EvaluationConfig;

  // Work
  stories: Story[];
}

/**
 * Create a new story with defaults
 */
export function createStory(
  partial: Pick<Story, "id" | "title" | "description" | "hypothesis" | "type">,
): Story {
  return {
    ...partial,
    status: "pending",
    createdAt: new Date().toISOString(),
  };
}

/**
 * Create an empty PRD template
 */
export function createEmptyPRD(projectName: string): PRD {
  const now = new Date().toISOString();
  return {
    project: projectName,
    description: "",
    createdAt: now,
    updatedAt: now,
    goal: "",
    successCriteria: [],
    constraints: [],
    scope: {
      inScope: [],
      outOfScope: [],
    },
    dataSources: [],
    evaluation: {
      metric: "",
      validationStrategy: "",
    },
    stories: [],
  };
}
