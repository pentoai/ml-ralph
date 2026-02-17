/**
 * All enumerated types for ml-ralph
 */

// Story types
export type StoryType =
  | "discovery" // EDA, data understanding
  | "experiment" // Model/feature experiments
  | "evaluation" // Validation, error analysis
  | "implementation" // Production code, refactoring
  | "ops"; // Infrastructure, tooling

// Story status
export type StoryStatus =
  | "pending" // Not started
  | "in_progress" // Currently being worked on
  | "done" // Completed successfully
  | "superseded"; // Replaced by another story

// Learning categories
export type LearningCategory =
  | "data" // Data quality, distribution, leakage
  | "model" // Architecture, hyperparameters
  | "evaluation" // Metrics, validation strategy
  | "infrastructure" // Training, deployment, performance
  | "domain" // Business/domain-specific insights
  | "process"; // ML workflow, tooling, methodology

// Learning impact
export type LearningImpact = "high" | "medium" | "low";

// Learning confidence
export type LearningConfidence = "proven" | "likely" | "speculative";

// Research types
export type ResearchType =
  | "paper" // Academic paper
  | "documentation" // Library/framework docs
  | "tutorial" // How-to guide
  | "stackoverflow" // Q&A
  | "blog" // Blog post
  | "repository" // GitHub repo
  | "other";

// Job status
export type JobStatus = "running" | "completed" | "failed" | "stopped"; // Manually stopped

// Progress decision
export type ProgressDecision = "keep" | "revert" | "investigate";

// Evidence types
export type EvidenceType = "wandb" | "artifact" | "log" | "commit" | "other";

// Success criterion priority
export type CriterionPriority = "must" | "should" | "nice";

// Chat roles
export type ChatRole = "user" | "assistant";

// Chat session purpose
export type ChatPurpose = "prd_creation" | "prd_refinement";

// Package managers
export type PackageManager = "uv" | "pip" | "poetry" | "conda";

// Agent status
export type AgentStatus = "idle" | "running" | "paused";

// App mode
export type AppMode = "planning" | "monitor" | "output";

// Tab selection in planning mode
export type PlanningTab =
  | "prd"
  | "hypotheses"
  | "learnings"
  | "research"
  | "stories"
  | "kanban"
  | "experiments";
