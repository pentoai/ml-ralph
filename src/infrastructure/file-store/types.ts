/**
 * FileStore interface - manages .ml-ralph/ directory
 */

import type {
  ChatSession,
  Learning,
  PRD,
  ProgressEntry,
  ProjectConfig,
  ResearchItem,
  TrainingJob,
} from "../../domain/types/index.ts";

export interface FileStore {
  // PRD
  readPRD(): Promise<PRD | null>;
  writePRD(prd: PRD): Promise<void>;

  // Progress
  appendProgress(entry: ProgressEntry): Promise<void>;
  readProgress(): Promise<ProgressEntry[]>;

  // Learnings
  appendLearning(learning: Learning): Promise<void>;
  readLearnings(): Promise<Learning[]>;

  // Research
  appendResearch(item: ResearchItem): Promise<void>;
  readResearch(): Promise<ResearchItem[]>;

  // Jobs
  readActiveJobs(): Promise<TrainingJob[]>;
  writeActiveJobs(jobs: TrainingJob[]): Promise<void>;
  appendJobHistory(job: TrainingJob): Promise<void>;
  readJobHistory(): Promise<TrainingJob[]>;

  // Config
  readConfig(): Promise<ProjectConfig | null>;
  writeConfig(config: ProjectConfig): Promise<void>;

  // Chat
  readChatSession(id: string): Promise<ChatSession | null>;
  writeChatSession(session: ChatSession): Promise<void>;

  // Utility
  exists(): Promise<boolean>;
  initialize(config: ProjectConfig): Promise<void>;
}
