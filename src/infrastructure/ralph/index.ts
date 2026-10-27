/**
 * ML-Ralph infrastructure - init, runner, and log parser
 */

export type {
  EvalCommandOptions,
  EvalCommandResult,
} from "./eval-command.ts";
export { runEvalCommand } from "./eval-command.ts";
export type { EvalChange, EvalLock, EvalLockResult } from "./eval-lock.ts";
export {
  checkEvalGate,
  describeEvalChanges,
  findEvalChanges,
  lockEvalContract,
  readEvalLock,
  relockEvalContract,
} from "./eval-lock.ts";
export type {
  EvalCache,
  EvalMetrics,
  EvalMetricsFailed,
  EvalMetricsOk,
  EvalScoring,
  EvalSeedScore,
  EvalSummary,
  VerifiedEvals,
} from "./eval-metrics.ts";
export {
  createEvalCache,
  EVALS_DIR,
  readEvalMetrics,
  readEvalScoring,
  readVerifiedEvals,
} from "./eval-metrics.ts";
export type { HoldoutOptions, HoldoutResult } from "./holdout.ts";
export { holdoutConfigFile, readHoldoutPath, scoreHoldout } from "./holdout.ts";
export type { HoldoutNeedles } from "./holdout-guard.ts";
export {
  findHoldoutToolUse,
  holdoutNeedles,
  loadHoldoutNeedles,
} from "./holdout-guard.ts";
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
  readKanbanFile,
  readLogFile,
  readPrdFile,
  watchLogFile,
} from "./log-parser.ts";
export type {
  GitHead,
  Incumbent,
  PromotionDecision,
  PromotionDeps,
} from "./promotion.ts";
export {
  judgeCandidate,
  parseCandidateComplete,
  readIncumbent,
} from "./promotion.ts";
export type {
  ContractDecision,
  RunCompleteReason,
  RunnerConfig,
  StreamEvent,
} from "./runner.ts";
export { createRunner, RalphRunner } from "./runner.ts";
export type {
  CompletionBlockedEvent,
  CompletionRejectedEvent,
  ContractRelockedEvent,
  DecisionEvent,
  EvalEvent,
  ExperimentEvent,
  HoldoutAccessEvent,
  HypothesisEvent,
  LearningEvent,
  OverfittingEvent,
  ParallelResultEvent,
  ParallelStartEvent,
  ParallelSynthesisEvent,
  PhaseEvent,
  PRD,
  PrdUpdatedEvent,
  PromotionEvent,
  RalphEvent,
  ResearchEvent,
  RunCompleteEvent,
  StatusEvent,
  VerifierVerdictEvent,
} from "./templates.ts";
export type {
  VerifierVerdict,
  VerifyCandidateOptions,
  VerifyCandidateResult,
} from "./verifier.ts";
export { formatVerdictForAgent, verifyCandidate } from "./verifier.ts";
