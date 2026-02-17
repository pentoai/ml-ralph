/**
 * Domain types - re-export all types from a single entry point
 */

// Chat
export type { ChatMessage, ChatSession, ToolCall } from "./chat.ts";
export { createChatMessage, createChatSession } from "./chat.ts";
// Config
export type {
  AgentConfig,
  ProjectConfig,
  RuntimeConfig,
  WandBConfig,
} from "./config.ts";
export { createDefaultConfig } from "./config.ts";
// Enums
export * from "./enums.ts";
// Jobs
export type { JobMetrics, TrainingJob } from "./job.ts";
export { createTrainingJob } from "./job.ts";
// Kanban
export type {
  AbandonedTask,
  CompletedTask,
  Kanban,
  KanbanTask,
} from "./kanban.ts";
export { createEmptyKanban } from "./kanban.ts";
// Learnings
export type { Learning, LearningSource } from "./learning.ts";
export { createLearning } from "./learning.ts";
// PRD & Stories
export type {
  DataSource,
  EvaluationConfig,
  PRD,
  Scope,
  Story,
  SuccessCriterion,
} from "./prd.ts";
export { createEmptyPRD, createStory } from "./prd.ts";
// Progress
export type {
  BacklogChange,
  Evidence,
  ProgressEntry,
  ProgressEvaluation,
} from "./progress.ts";
export { createProgressEntry } from "./progress.ts";
// Research
export type { CodeSnippet, ResearchItem } from "./research.ts";
export { createResearchItem } from "./research.ts";
