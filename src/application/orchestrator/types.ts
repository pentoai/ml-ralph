/**
 * Orchestrator types
 */

import type {
  Learning,
  ProgressEntry,
  ResearchItem,
  Story,
} from "../../domain/types/index.ts";
import type { StreamEvent } from "../../infrastructure/ralph/index.ts";

export interface AgentOrchestrator {
  start(): Promise<void>;
  stop(): Promise<void>;
  isRunning(): boolean;
  getCurrentIteration(): number;
  setMaxIterations(maxIterations: number): void;
  addHint(hint: string): void;
  getPendingHintsCount(): number;
  onStoryComplete(
    callback: (story: Story, result: StoryResult) => void,
  ): () => void;
  onOutput(callback: (event: StreamEvent) => void): () => void;
  onIterationChange(callback: (iteration: number) => void): () => void;
  onComplete(
    callback: (reason: "project_complete" | "max_iterations") => void,
  ): () => void;
}

export interface StoryResult {
  progress: ProgressEntry;
  learnings: Learning[];
  research: ResearchItem[];
  storyComplete: boolean;
}

export interface OrchestratorConfig {
  projectPath: string;
  autoAdvance: boolean;
  maxIterations?: number;
  enableTeams?: boolean;
}
