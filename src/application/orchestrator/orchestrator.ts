/**
 * Agent orchestrator implementation - wraps RalphRunner
 */

import type { Story } from "../../domain/types/index.ts";
import {
  type BudgetStatus,
  describeEvalChanges,
  type EvalChange,
  RalphRunner,
  type RunCompleteReason,
  type StreamEvent,
} from "../../infrastructure/ralph/index.ts";
import type {
  AgentOrchestrator,
  OrchestratorConfig,
  StoryResult,
} from "./types.ts";

type StoryCompleteCallback = (story: Story, result: StoryResult) => void;
type OutputCallback = (event: StreamEvent) => void;
type IterationCallback = (iteration: number) => void;
type CompleteCallback = (reason: RunCompleteReason) => void;
type BudgetCallback = (status: BudgetStatus) => void;
type ContractChangeCallback = (
  changes: EvalChange[],
  relockError?: string,
) => void;

export class DefaultOrchestrator implements AgentOrchestrator {
  private runner: RalphRunner;
  private storyCompleteCallbacks: Set<StoryCompleteCallback> = new Set();
  private outputCallbacks: Set<OutputCallback> = new Set();
  private iterationCallbacks: Set<IterationCallback> = new Set();
  private completeCallbacks: Set<CompleteCallback> = new Set();
  private contractChangeCallbacks: Set<ContractChangeCallback> = new Set();
  private budgetCallbacks: Set<BudgetCallback> = new Set();

  constructor(config: OrchestratorConfig) {
    this.runner = new RalphRunner({
      projectPath: config.projectPath,
      maxIterations: config.maxIterations ?? 10,
      enableTeams: config.enableTeams,
      onOutput: (event) => this.emitOutput(event),
      onIterationStart: (iteration) => this.emitIterationChange(iteration),
      onComplete: (reason) => this.emitComplete(reason),
      onBudget: (status) => {
        for (const callback of this.budgetCallbacks) callback(status);
      },
      onContractChanged: (changes, relockError) => {
        this.emitOutput({
          type: "error",
          content: `Run paused: locked eval file changed (${describeEvalChanges(changes)})`,
          isError: true,
        });
        for (const callback of this.contractChangeCallbacks) {
          callback(changes, relockError);
        }
      },
      onError: (error) => {
        this.emitOutput({
          type: "error",
          content: error.message,
          isError: true,
        });
      },
    });
  }

  async start(): Promise<void> {
    if (this.runner.isRunning()) return;
    await this.runner.start();
  }

  async stop(): Promise<void> {
    await this.runner.stop();
  }

  isRunning(): boolean {
    return this.runner.isRunning();
  }

  getCurrentIteration(): number {
    return this.runner.getCurrentIteration();
  }

  setMaxIterations(maxIterations: number): void {
    this.runner.setMaxIterations(maxIterations);
  }

  addHint(hint: string): void {
    this.runner.addHint(hint);
  }

  getPendingHintsCount(): number {
    return this.runner.getPendingHintsCount();
  }

  relockContract(): boolean {
    return this.runner.resolveContractChange("relock");
  }

  stopForContractChange(): boolean {
    return this.runner.resolveContractChange("stop");
  }

  onContractChange(callback: ContractChangeCallback): () => void {
    this.contractChangeCallbacks.add(callback);
    return () => this.contractChangeCallbacks.delete(callback);
  }

  onStoryComplete(callback: StoryCompleteCallback): () => void {
    this.storyCompleteCallbacks.add(callback);
    return () => this.storyCompleteCallbacks.delete(callback);
  }

  onOutput(callback: OutputCallback): () => void {
    this.outputCallbacks.add(callback);
    return () => this.outputCallbacks.delete(callback);
  }

  onIterationChange(callback: IterationCallback): () => void {
    this.iterationCallbacks.add(callback);
    return () => this.iterationCallbacks.delete(callback);
  }

  onBudget(callback: BudgetCallback): () => void {
    this.budgetCallbacks.add(callback);
    return () => this.budgetCallbacks.delete(callback);
  }

  onComplete(callback: CompleteCallback): () => void {
    this.completeCallbacks.add(callback);
    return () => this.completeCallbacks.delete(callback);
  }

  private emitOutput(event: StreamEvent): void {
    for (const callback of this.outputCallbacks) {
      callback(event);
    }
  }

  private emitIterationChange(iteration: number): void {
    for (const callback of this.iterationCallbacks) {
      callback(iteration);
    }
  }

  private emitComplete(reason: RunCompleteReason): void {
    for (const callback of this.completeCallbacks) {
      callback(reason);
    }
  }
}

export function createOrchestrator(
  config: OrchestratorConfig,
): AgentOrchestrator {
  return new DefaultOrchestrator(config);
}
