/**
 * Agent orchestrator implementation - wraps RalphRunner
 */

import type { Story } from "../../domain/types/index.ts";
import {
  RalphRunner,
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
type CompleteCallback = (reason: "project_complete" | "max_iterations") => void;

export class DefaultOrchestrator implements AgentOrchestrator {
  private runner: RalphRunner;
  private storyCompleteCallbacks: Set<StoryCompleteCallback> = new Set();
  private outputCallbacks: Set<OutputCallback> = new Set();
  private iterationCallbacks: Set<IterationCallback> = new Set();
  private completeCallbacks: Set<CompleteCallback> = new Set();

  constructor(config: OrchestratorConfig) {
    this.runner = new RalphRunner({
      projectPath: config.projectPath,
      maxIterations: config.maxIterations ?? 10,
      enableTeams: config.enableTeams,
      onOutput: (event) => this.emitOutput(event),
      onIterationStart: (iteration) => this.emitIterationChange(iteration),
      onComplete: (reason) => this.emitComplete(reason),
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
    this.runner.stop();
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

  private emitComplete(reason: "project_complete" | "max_iterations"): void {
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
