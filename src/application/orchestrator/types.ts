/**
 * Orchestrator types
 */

import type {
  Learning,
  ProgressEntry,
  ResearchItem,
  Story,
} from "../../domain/types/index.ts";
import type {
  BudgetStatus,
  EvalChange,
  RunCompleteReason,
  StreamEvent,
} from "../../infrastructure/ralph/index.ts";

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
  onComplete(callback: (reason: RunCompleteReason) => void): () => void;
  /** Spend and elapsed time against the budget caps */
  onBudget(callback: (status: BudgetStatus) => void): () => void;
  /** A locked eval file changed and the run is paused awaiting a decision */
  onContractChange(
    callback: (changes: EvalChange[], relockError?: string) => void,
  ): () => void;
  /** Re-lock the eval files as they are now and resume the paused run */
  relockContract(): boolean;
  /** End the paused run with reason `contract_changed` */
  stopForContractChange(): boolean;
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
