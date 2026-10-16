/**
 * ML-Ralph infrastructure - init, runner, and log parser
 */

export type { EvalChange, EvalLock, EvalLockResult } from "./eval-lock.ts";
export {
  checkEvalGate,
  describeEvalChanges,
  findEvalChanges,
  lockEvalContract,
  readEvalLock,
  relockEvalContract,
} from "./eval-lock.ts";
export type { InitOptions, InitResult } from "./init.ts";
export {
  enableAgentTeamsSettings,
  ensureInitialized,
  initRalph,
  isInitialized,
} from "./init.ts";
export type { LogCommandOptions, LogCommandResult } from "./log-command.ts";
export { runLogCommand } from "./log-command.ts";
export type {
  AbandonedTask,
  CompletedTask,
  HypothesisWithStatus,
  Kanban,
  KanbanTask,
  LogSummary,
  PrdChange,
} from "./log-parser.ts";
export {
  aggregateEvents,
  appendEvent,
  readKanbanFile,
  readLogFile,
  readPrdFile,
  watchLogFile,
} from "./log-parser.ts";
export type {
  ContractDecision,
  RunCompleteReason,
  RunnerConfig,
  StreamEvent,
} from "./runner.ts";
export { createRunner, RalphRunner } from "./runner.ts";
export type {
  ContractRelockedEvent,
  DecisionEvent,
  ExperimentEvent,
  HypothesisEvent,
  LearningEvent,
  ParallelResultEvent,
  ParallelStartEvent,
  ParallelSynthesisEvent,
  PhaseEvent,
  PRD,
  PrdUpdatedEvent,
  RalphEvent,
  ResearchEvent,
  StatusEvent,
  VerifierVerdictEvent,
} from "./templates.ts";
export type {
  VerifierVerdict,
  VerifyCandidateOptions,
  VerifyCandidateResult,
} from "./verifier.ts";
export { formatVerdictForAgent, verifyCandidate } from "./verifier.ts";
