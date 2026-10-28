/**
 * ML-Ralph runner - executes the autonomous agent loop
 */

import type { Subprocess } from "bun";
import {
  type BudgetCaps,
  type BudgetExhaustion,
  type BudgetStatus,
  budgetPrompt,
  budgetStatus,
  clearRunId,
  exhaustedCap,
  ITERATION_ENV,
  MAX_EXPERIMENTS_ENV,
  priorBudget,
  readBudgetCaps,
  readRunId,
  resetExperimentCount,
  writeRunId,
} from "./budget.ts";
import {
  buildContextPrompt,
  countLogLines,
  enforceConclusions,
  ensureConclusions,
  readConclusions,
} from "./conclusions.ts";
import { HOLDOUT_PATH_ENV, killTree } from "./eval-command.ts";
import {
  checkEvalGate,
  describeEvalChanges,
  type EvalChange,
  type EvalLock,
  findEvalChanges,
  readEvalLock,
  relockEvalContract,
} from "./eval-lock.ts";
import {
  type HoldoutResult,
  readHoldoutPath,
  scoreHoldout,
} from "./holdout.ts";
import {
  findHoldoutToolUse,
  type HoldoutNeedles,
  loadHoldoutNeedles,
} from "./holdout-guard.ts";
import { appendValidatedEvent } from "./log-command.ts";
import {
  judgeCandidate,
  type PromotedCandidate,
  type PromotionDeps,
  parseCandidateComplete,
  recordBaselineRef,
} from "./promotion.ts";
import { type ReportEndReason, writeReport } from "./report.ts";
import { verifyCandidate } from "./verifier.ts";

/** Why a run ended. Only the runner ends a run: the agent's output never does */
export type RunCompleteReason =
  | "completed"
  | "max_iterations"
  | "contract_changed"
  | "holdout_access"
  | "budget_exhausted";

/** How often the TUI hears about elapsed time while claude runs */
const BUDGET_TICK_MS = 15_000;
/** setTimeout rejects delays above 2^31 - 1 ms */
const MAX_TIMER_MS = 2_147_483_647;

export interface RunnerConfig {
  projectPath: string;
  maxIterations?: number;
  enableTeams?: boolean;
  onOutput?: (event: StreamEvent) => void;
  onIterationStart?: (iteration: number) => void;
  onIterationEnd?: (iteration: number, result: string) => void;
  onComplete?: (reason: RunCompleteReason) => void;
  /** Spend and elapsed time against the caps: at start, at each result event, and while claude runs */
  onBudget?: (status: BudgetStatus) => void;
  /**
   * A locked eval file changed; the run is paused until resolveContractChange
   * is called. `relockError` is set when the previous re-lock attempt failed.
   */
  onContractChanged?: (changes: EvalChange[], relockError?: string) => void;
  onError?: (error: Error) => void;
  /** Replaces the verifier and git lookups of the promotion gate (tests) */
  promotionDeps?: Partial<PromotionDeps>;
  /** Replaces the holdout lookup and scoring of the completion gate (tests); its verifier is promotionDeps.verify */
  completionDeps?: Partial<CompletionDeps>;
}

export type CompletionBlockedReason =
  | "holdout_not_configured"
  | "holdout_unavailable"
  | "holdout_already_scored"
  | "verifier_error"
  | "holdout_error"
  | "completion_error";

export interface CompletionDeps {
  scoreHoldout: (evalId: string) => Promise<HoldoutResult>;
  readHoldoutPath: (projectPath: string) => ReturnType<typeof readHoldoutPath>;
}

const MAX_ERROR_CHARS = 300;
const oneLine = (text: string) => {
  const line = (text.split("\n").find((l) => l.trim()) ?? "").trim();
  return line.length > MAX_ERROR_CHARS
    ? `${line.slice(0, MAX_ERROR_CHARS - 3)}...`
    : line;
};
const errorText = (error: unknown) =>
  oneLine(error instanceof Error ? error.message : String(error));

/** The contract's success criterion, in its direction: at or past success_threshold */
export function meetsSuccess(
  contract: { direction: "max" | "min"; success_threshold: number },
  score: number,
): boolean {
  return contract.direction === "max"
    ? score >= contract.success_threshold
    : score <= contract.success_threshold;
}

export interface StreamEvent {
  type: "text" | "tool_call" | "tool_result" | "error" | "iteration_marker";
  content: string;
  toolName?: string;
  toolInput?: Record<string, unknown>;
  isError?: boolean;
  agentName?: string;
  teamEvent?:
    | "team_create"
    | "teammate_spawn"
    | "teammate_message"
    | "task_update";
}

export type ContractDecision = "relock" | "stop";

const BASE_PROMPT = `Read .ml-ralph/RALPH.md for instructions.

The prompt below inlines .ml-ralph/conclusions.md and the last log events. Do not read the whole log.jsonl.

Execute one iteration of the cognitive loop. Update state files as needed.
When done, output exactly: <iteration_complete>

If you have a candidate you believe is a new best, follow "Completing a Candidate" in RALPH.md and also output: <candidate_complete eval_id="...">
Only the runner decides whether a candidate is promoted, and only the runner ends the run.`;

export class RalphRunner {
  private config: RunnerConfig;
  private running = false;
  private currentProcess: Subprocess | null = null;
  private currentIteration = 0;
  private pendingHints: string[] = [];
  private pendingFeedback: string[] = [];
  /** eval_ids the completion gate has asked scoreHoldout about in this run */
  private holdoutScored = new Set<string>();
  private lastToolCall: ToolCallRef | null = null;
  private holdoutNeedles: HoldoutNeedles = [];
  private holdoutAccess: { toolName: string } | null = null;
  private pinnedHashes: EvalLock["files"] | null = null;
  private budgetCaps: BudgetCaps = {};
  private budgetRunId = "";
  private budgetBase = { usd_spent: 0, elapsed_minutes: 0 };
  private budgetStartedAt = 0;
  private budgetUsd = 0;
  private iterationCost: number | null = null;
  private budgetStop: BudgetExhaustion | null = null;
  private userStopped = false;
  private reported = false;
  /** Pending from start() until the run has ended and its report is on disk */
  private settled: Promise<void> | null = null;
  private contractDecision: ((d: ContractDecision | null) => void) | null =
    null;

  constructor(config: RunnerConfig) {
    this.config = {
      maxIterations: 10,
      ...config,
    };
  }

  /**
   * Check if RALPH.md exists (initialized)
   */
  async isInitialized(): Promise<boolean> {
    const ralphMdPath = `${this.config.projectPath}/.ml-ralph/RALPH.md`;
    return Bun.file(ralphMdPath).exists();
  }

  /**
   * Start the autonomous loop
   */
  async start(): Promise<void> {
    if (this.isRunning()) return;

    const initialized = await this.isInitialized();
    if (!initialized) {
      this.config.onError?.(new Error("Not initialized. Run init first."));
      return;
    }

    await ensureConclusions(this.config.projectPath);

    const caps = await readBudgetCaps(this.config.projectPath);
    if (!caps.ok) {
      this.config.onError?.(new Error(caps.error));
      return;
    }

    this.running = true;
    let settle = () => {};
    this.settled = new Promise<void>((resolve) => {
      settle = resolve;
    });
    this.currentIteration = 0;
    this.budgetStop = null;
    this.userStopped = false;
    this.reported = false;
    this.budgetRunId = "";
    this.pinnedHashes = null;
    this.pendingFeedback = [];
    this.holdoutScored = new Set();
    this.holdoutAccess = null;
    let baselineRecorded = false;

    try {
      await this.startBudget(caps.caps);
      const spent = exhaustedCap(this.budgetNow());
      if (spent) {
        await this.endForBudget(spent);
        return;
      }

      for (let i = 1; i <= this.config.maxIterations!; i++) {
        if (!this.running) break;

        if (!(await this.verifyContract())) return;

        const gate = await checkEvalGate(this.config.projectPath);
        if (!gate.ok) {
          this.config.onError?.(new Error(gate.error));
          return;
        }
        this.pinnedHashes ??=
          (await readEvalLock(this.config.projectPath))?.files ?? null;

        if (!baselineRecorded) {
          baselineRecorded = true;
          await recordBaselineRef(
            this.config.projectPath,
            this.config.promotionDeps?.gitHead,
          );
        }

        this.currentIteration = i;
        this.config.onIterationStart?.(i);

        // Build prompt with the runner's last decision and any pending hints
        const prompt = await this.buildPrompt();
        const conclusionsBefore = await readConclusions(
          this.config.projectPath,
        );
        const logLinesBefore = await countLogLines(this.config.projectPath);
        const iterationStartedAt = new Date().toISOString();

        // Emit iteration marker
        this.config.onOutput?.({
          type: "iteration_marker",
          content: `═══ Iteration ${i} ═══`,
        });

        this.holdoutNeedles = await loadHoldoutNeedles(this.config.projectPath);
        let result: string;
        try {
          result = await this.runIteration(prompt);
        } catch (error) {
          await this.recordBudget();
          await this.enforceConclusions(conclusionsBefore, logLinesBefore);
          throw error;
        }
        await this.recordBudget();
        await this.enforceConclusions(conclusionsBefore, logLinesBefore);

        const access = this.holdoutAccessed();
        if (access) {
          await this.endForHoldoutAccess(access.toolName);
          return;
        }

        if (this.budgetStop) {
          await this.endForBudget(this.budgetStop);
          return;
        }

        this.config.onIterationEnd?.(i, result);

        if (await this.judgeIteration(result, iterationStartedAt)) {
          await this.endRun("completed");
          return;
        }

        // Judging spends time and verifier USD: re-check before building the next prompt
        const exhausted = exhaustedCap(this.budgetNow());
        if (exhausted) {
          await this.endForBudget(exhausted);
          return;
        }
      }

      if (this.running && this.currentIteration >= this.config.maxIterations!) {
        await this.endRun("max_iterations");
        await clearRunId(this.config.projectPath);
      }
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      this.config.onError?.(err);
      throw err;
    } finally {
      this.currentProcess = null;
      // Any other way out (user quit, an error) still leaves a report; isRunning() stays true until it is written
      if (!this.reported) {
        await this.writeRunReport(this.userStopped ? "user_quit" : "error");
      }
      this.running = false;
      this.settled = null;
      settle();
    }
  }

  /**
   * Stop the running loop. The promise settles once the run has ended and
   * its report is written, so a caller about to exit can wait for it.
   */
  stop(): Promise<void> {
    const done = this.settled ?? Promise.resolve();
    if (this.running) this.userStopped = true;
    this.running = false;
    this.settleContractDecision(null);
    if (this.currentProcess) {
      killTree(this.currentProcess, "SIGTERM");
      this.currentProcess = null;
    }
    return done;
  }

  /**
   * Score an eval's candidate on the sealed holdout, at most once per eval_id.
   * The holdout path is read from the user-level config and reaches only the
   * evaluator subprocess; it is never part of a prompt.
   */
  scoreHoldout(evalId: string): Promise<HoldoutResult> {
    return scoreHoldout(evalId, {
      projectPath: this.config.projectPath,
      onInvalidEvent: this.reportInvalidEvent,
    });
  }

  /** The run is over for a reason the TUI hears about: write the report first, then announce it */
  private async endRun(reason: RunCompleteReason): Promise<void> {
    await this.writeRunReport(reason === "completed" ? "run_complete" : reason);
    this.config.onComplete?.(reason);
  }

  /** Write report.md; a failure is logged as report_failed and never stops the run from ending */
  private async writeRunReport(endReason: ReportEndReason): Promise<void> {
    this.reported = true;
    try {
      await writeReport({
        projectPath: this.config.projectPath,
        runId: this.budgetRunId,
        endReason,
      });
    } catch (error) {
      await this.logCompletion({
        type: "report_failed",
        run_id: this.budgetRunId.slice(0, 100),
        reason: errorText(error),
      });
    }
  }

  /** Load the caps and the spend this run already recorded, and start its clock */
  private async startBudget(caps: BudgetCaps): Promise<void> {
    const projectPath = this.config.projectPath;
    this.budgetCaps = caps;
    this.budgetRunId = (await readRunId(projectPath)) ?? crypto.randomUUID();
    await writeRunId(projectPath, this.budgetRunId);
    const logFile = Bun.file(`${projectPath}/.ml-ralph/log.jsonl`);
    this.budgetBase = priorBudget(
      (await logFile.exists()) ? await logFile.text() : "",
      this.budgetRunId,
    );
    this.budgetStartedAt = Date.now();
    this.budgetUsd = 0;
    this.iterationCost = null;
    this.config.onBudget?.(this.budgetNow());
  }

  /** Spend and elapsed time of the whole run, including what earlier starts recorded */
  private budgetNow(): BudgetStatus {
    return budgetStatus(
      this.budgetCaps,
      this.budgetBase.usd_spent + this.budgetUsd,
      this.budgetBase.elapsed_minutes +
        (Date.now() - this.budgetStartedAt) / 60_000,
    );
  }

  /** After an iteration: log the running totals, and a warning when claude reported no cost */
  private async recordBudget(): Promise<void> {
    const reported = this.iterationCost !== null;
    this.iterationCost = null;
    const status = this.budgetNow();
    if (!reported) {
      await this.appendLogEvent({
        type: "budget_warning",
        run_id: this.budgetRunId,
        iteration: this.currentIteration,
        reason:
          "no result event with total_cost_usd; this iteration counted as $0",
      });
    }
    await this.appendLogEvent({
      type: "budget_status",
      run_id: this.budgetRunId,
      iteration: this.currentIteration,
      ...status,
    });
    this.config.onBudget?.(status);
  }

  /** The verifier is a claude session the runner spawns: its cost counts against max_usd */
  private async addVerifierCost(costUsd: number): Promise<void> {
    this.budgetUsd += costUsd;
    const status = this.budgetNow();
    await this.appendLogEvent({
      type: "budget_status",
      run_id: this.budgetRunId,
      iteration: this.currentIteration,
      ...status,
    });
    this.config.onBudget?.(status);
  }

  /** A cap was reached: log it and end the run. The claude session, if still alive, is already killed */
  private async endForBudget(cap: BudgetExhaustion): Promise<void> {
    await this.appendLogEvent({
      type: "budget_exhausted",
      run_id: this.budgetRunId,
      iteration: this.currentIteration,
      cap,
      ...this.budgetNow(),
    });
    await this.endRun("budget_exhausted");
  }

  /** Stop the claude process because a cap was reached; the iteration is not judged */
  private stopForBudget(cap: BudgetExhaustion): void {
    if (this.budgetStop) return;
    this.budgetStop = cap;
    if (this.currentProcess) killTree(this.currentProcess, "SIGKILL");
  }

  /** The tool call that named the holdout in this run, if any (a method so TS does not narrow the field across awaits) */
  private holdoutAccessed(): { toolName: string } | null {
    return this.holdoutAccess;
  }

  /**
   * The agent's tool call named the sealed holdout path and its claude process
   * was killed: record which tool did it (never the call itself, so the path
   * stays out of log.jsonl) and end the run. No candidate is judged.
   */
  private async endForHoldoutAccess(toolName: string): Promise<void> {
    await this.appendLogEvent({
      type: "holdout_access",
      tool: toolName,
      iteration: this.currentIteration,
    });
    await this.endRun("holdout_access");
  }

  /**
   * Act on the agent's output: a <candidate_complete> goes to the promotion
   * gate and its decision is queued for the next prompt. <project_complete> is
   * ignored; the agent cannot end a run. Returns true when a promotion passed
   * the completion gate and the run is over.
   */
  private async judgeIteration(
    result: string,
    iterationStartedAt: string,
  ): Promise<boolean> {
    let completed = false;
    const candidate = parseCandidateComplete(result);
    if (candidate && this.pinnedHashes) {
      const decision = await judgeCandidate(
        {
          projectPath: this.config.projectPath,
          claimedEvalId: candidate.evalId,
          iterationStartedAt,
          lockedFiles: this.pinnedHashes,
          onInvalidEvent: this.reportInvalidEvent,
        },
        this.config.promotionDeps,
      );
      this.pendingFeedback.push(decision.feedback);
      if (decision.costUsd) await this.addVerifierCost(decision.costUsd);
      if (
        decision.promoted &&
        meetsSuccess(decision.promoted.contract, decision.promoted.searchScore)
      ) {
        completed = await this.checkCompletion(decision.promoted);
      }
    }
    if (candidate && !this.pinnedHashes) {
      await this.appendLogEvent({
        type: "candidate_rejected",
        reason: "eval_not_locked",
        ...(candidate.evalId
          ? { eval_id: candidate.evalId.slice(0, 100) }
          : {}),
      });
      this.pendingFeedback.push(
        "Runner decision on your candidate: rejected - eval_not_locked: the eval contract is not locked yet, so no eval can score a candidate. Get the contract locked, then run `ml-ralph eval` and hand the candidate in again.",
      );
    }
    if (!completed && result.includes("<project_complete>")) {
      this.pendingFeedback.push(
        'The runner ignores <project_complete>: only the runner ends a run. Hand in a candidate with <candidate_complete eval_id="..."> instead.',
      );
    }
    return completed;
  }

  /**
   * The completion gate, run after a promotion that meets the success criteria
   * on the search split: the independent verifier first, then the sealed
   * holdout, scored at most once per eval_id. The run ends only when the
   * verifier approves, the holdout meets the success criteria and the
   * search-holdout gap is within the contract threshold. A failed check is
   * logged and queued as a verdict plus one line (no scores) for the next
   * prompt; a check that could not run is only logged and shown. Never throws.
   */
  private async checkCompletion(p: PromotedCandidate): Promise<boolean> {
    const evalId = p.evalId;
    const blocked = async (reason: CompletionBlockedReason, error: string) => {
      await this.logCompletion({
        type: "completion_blocked",
        eval_id: evalId,
        reason,
        error,
      });
      this.config.onOutput?.({
        type: "text",
        content: `Completion blocked for ${evalId}: ${reason} (${error})`,
      });
      return false;
    };
    const rejected = async (
      reason: "verifier_rejected" | "holdout_failed" | "overfitting_gap",
      detail: string,
      verifierId?: string,
    ) => {
      await this.logCompletion({
        type: "completion_rejected",
        eval_id: evalId,
        reason,
        detail,
        ...(verifierId ? { verifier_id: verifierId } : {}),
      });
      this.pendingFeedback.push(
        `Runner completion check on ${JSON.stringify(evalId)}: rejected (${reason}) - ${detail}`,
      );
      this.config.onOutput?.({
        type: "text",
        content: `Completion rejected for ${evalId}: ${reason}`,
      });
      return false;
    };

    try {
      if (this.holdoutScored.has(evalId)) {
        return await blocked(
          "holdout_already_scored",
          "the holdout was already scored for this eval_id",
        );
      }

      // Cheapest check first: no verifier session when there is no holdout to score
      const readPath =
        this.config.completionDeps?.readHoldoutPath ?? readHoldoutPath;
      const holdoutPath = await readPath(this.config.projectPath);
      if (!holdoutPath.ok) {
        return await blocked(
          holdoutPath.notConfigured
            ? "holdout_not_configured"
            : "holdout_unavailable",
          oneLine(holdoutPath.error),
        );
      }

      const verify = this.config.promotionDeps?.verify ?? verifyCandidate;
      let verdict: Awaited<ReturnType<typeof verifyCandidate>>;
      try {
        verdict = await verify({
          projectPath: this.config.projectPath,
          hypothesis: p.hypothesis,
          candidateRef: p.candidateRef,
          baselineRef: p.baselineRef,
          onInvalidEvent: this.reportInvalidEvent,
        });
      } catch (error) {
        return await blocked("verifier_error", errorText(error));
      }
      if (verdict.costUsd) await this.addVerifierCost(verdict.costUsd);
      if (verdict.reason === "verifier_error") {
        return await blocked(
          "verifier_error",
          oneLine(verdict.error ?? "the verifier failed"),
        );
      }
      if (verdict.verdict !== "approve") {
        return await rejected(
          "verifier_rejected",
          oneLine(verdict.reason),
          verdict.id,
        );
      }

      this.holdoutScored.add(evalId);
      let holdout: HoldoutResult;
      try {
        holdout = await (
          this.config.completionDeps?.scoreHoldout ??
          ((id: string) => this.scoreHoldout(id))
        )(evalId);
      } catch (error) {
        return await blocked("holdout_error", errorText(error));
      }
      if (!holdout.ok) {
        return await blocked(
          holdout.notConfigured ? "holdout_not_configured" : "holdout_error",
          oneLine(holdout.error),
        );
      }
      if (!meetsSuccess(p.contract, holdout.holdoutScore)) {
        return await rejected(
          "holdout_failed",
          "the candidate does not meet the success criteria on the sealed holdout",
          verdict.id,
        );
      }
      if (holdout.blocked) {
        return await rejected(
          "overfitting_gap",
          "the gap between the search and holdout scores exceeds the contract threshold",
          verdict.id,
        );
      }

      await this.logCompletion({
        type: "run_complete",
        eval_id: evalId,
        search_score: holdout.searchScore,
        holdout_score: holdout.holdoutScore,
        verifier_verdict: "approve",
        verifier_id: verdict.id,
      });
      return true;
    } catch (error) {
      return await blocked("completion_error", errorText(error));
    }
  }

  private async logCompletion(event: Record<string, unknown>): Promise<void> {
    try {
      await this.appendLogEvent(event);
    } catch {
      // The decision stands even if the log line could not be written
    }
  }

  /**
   * The prompt for the next iteration: instructions, the distilled
   * conclusions plus the last N log events (flat in log length), the budget
   * left, and the runner's pending feedback and hints.
   */
  async buildPrompt(): Promise<string> {
    return (
      BASE_PROMPT +
      (await buildContextPrompt(this.config.projectPath)) +
      budgetPrompt(this.budgetNow()) +
      this.consumeFeedback() +
      (this.consumeHints() ?? "")
    );
  }

  /** Restore conclusions.md and tell the next prompt why when the iteration's edit broke the rules */
  private async enforceConclusions(
    before: string,
    logLinesBefore: number,
  ): Promise<void> {
    const rejection = await enforceConclusions(
      this.config.projectPath,
      before,
      logLinesBefore,
    );
    if (!rejection) return;
    await this.appendLogEvent({
      type: "conclusions_rejected",
      reason: rejection.reason,
      detail: rejection.detail,
      words: rejection.words,
    });
    this.pendingFeedback.push(
      `Your last change to conclusions.md was rejected and the previous version restored: ${rejection.detail}. Edit it again only with a conclusions_changed event.`,
    );
  }

  private consumeFeedback(): string {
    const feedback = this.pendingFeedback;
    this.pendingFeedback = [];
    return feedback.map((line) => `\n\n${line}`).join("");
  }

  /**
   * Re-hash the locked eval files before an iteration. On a mismatch, pause
   * until the user re-locks (then log it and continue) or stops the run.
   * Returns false when the run must end.
   *
   * The hashes are pinned in memory from the first lock seen in this run, so an
   * agent that edits an eval file and rewrites lock.json to match still pauses.
   */
  private async verifyContract(): Promise<boolean> {
    const projectPath = this.config.projectPath;
    let relockError: string | undefined;

    while (this.running) {
      const expected =
        this.pinnedHashes ?? (await readEvalLock(projectPath))?.files;
      const changes = expected
        ? await findEvalChanges(projectPath, expected)
        : [];
      if (changes.length === 0) return true;

      const onContractChanged = this.config.onContractChanged;
      if (!onContractChanged) {
        this.config.onError?.(
          new Error(
            `Locked eval file changed: ${describeEvalChanges(changes)}`,
          ),
        );
        return false;
      }

      const decision = await new Promise<ContractDecision | null>((resolve) => {
        this.contractDecision = resolve;
        onContractChanged(changes, relockError);
      });
      if (decision === null) return false;
      if (decision === "stop") {
        await this.endRun("contract_changed");
        return false;
      }

      const relocked = await relockEvalContract(projectPath);
      if (!relocked.ok) {
        relockError = relocked.error;
        continue;
      }
      this.pinnedHashes = relocked.lock.files;
      await this.appendLogEvent({
        type: "contract_relocked",
        changes,
        files: relocked.lock.files,
      });
      return true;
    }
    return false;
  }

  /**
   * Answer the pause raised by onContractChanged. Returns false when the run
   * is not waiting for a decision.
   */
  resolveContractChange(decision: ContractDecision): boolean {
    return this.settleContractDecision(decision);
  }

  private settleContractDecision(decision: ContractDecision | null): boolean {
    const resolve = this.contractDecision;
    if (!resolve) return false;
    this.contractDecision = null;
    resolve(decision);
    return true;
  }

  /**
   * Check if the runner is currently running
   */
  isRunning(): boolean {
    return this.running || this.settled !== null;
  }

  /**
   * Set the max iterations for the next run
   */
  setMaxIterations(maxIterations: number): void {
    this.config.maxIterations = maxIterations;
  }

  /**
   * Add a hint to the pending hints queue
   * All pending hints will be consumed at the start of the next iteration
   */
  addHint(hint: string): void {
    this.pendingHints.push(hint);
  }

  /**
   * Get the number of pending hints
   */
  getPendingHintsCount(): number {
    return this.pendingHints.length;
  }

  /**
   * Consume and clear all pending hints, returning them formatted for the prompt
   */
  private consumeHints(): string | null {
    if (this.pendingHints.length === 0) return null;

    const hints = this.pendingHints.slice();
    this.pendingHints = [];

    if (hints.length === 1) {
      return `\n\nUser hint for this iteration:\n${hints[0]}`;
    }

    const formattedHints = hints.map((h, i) => `${i + 1}. ${h}`).join("\n");
    return `\n\nUser hints for this iteration:\n${formattedHints}`;
  }

  /**
   * Get current iteration number
   */
  getCurrentIteration(): number {
    return this.currentIteration;
  }

  /**
   * Append a log event to .ml-ralph/log.jsonl
   */
  private async appendLogEvent(event: Record<string, unknown>): Promise<void> {
    await appendValidatedEvent(
      this.config.projectPath,
      event,
      this.reportInvalidEvent,
    );
  }

  /** Show an invalid runner event as an error line in the TUI (it is already on stderr) */
  private reportInvalidEvent = (invalid: { message: string }): void => {
    process.stderr.write(`${invalid.message}\n`);
    this.config.onOutput?.({
      type: "error",
      content: invalid.message,
      isError: true,
    });
  };

  /**
   * Run a single iteration
   */
  protected async runIteration(prompt: string): Promise<string> {
    // Inject an initial log event so the TUI shows something immediately
    await resetExperimentCount(
      this.config.projectPath,
      String(this.currentIteration),
    );
    await this.appendLogEvent({
      type: "phase",
      phase: this.currentIteration === 1 ? "UNDERSTAND" : "EXECUTE",
      summary: `Iteration ${this.currentIteration} starting...`,
    });

    const cmd = [
      "claude",
      "--dangerously-skip-permissions",
      "--verbose",
      "-p",
      prompt,
      "--output-format",
      "stream-json",
    ];

    // The agent's environment never carries the holdout path, even if the user exported it
    const { [HOLDOUT_PATH_ENV]: _holdout, ...agentEnv } = process.env;
    // Own process group, so stop() and the holdout guard also reach what claude's tools started
    const proc = Bun.spawn(cmd, {
      cwd: this.config.projectPath,
      detached: true,
      stdout: "pipe",
      stderr: "pipe",
      env: {
        ...agentEnv,
        [ITERATION_ENV]: String(this.currentIteration),
        // Pinned at start, so editing config.json mid-run cannot loosen the cap
        ...(this.budgetCaps.max_experiments_per_iteration !== undefined
          ? {
              [MAX_EXPERIMENTS_ENV]: String(
                this.budgetCaps.max_experiments_per_iteration,
              ),
            }
          : {}),
        ...(this.config.enableTeams
          ? { CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: "1" }
          : {}),
      },
    });
    this.currentProcess = proc;

    // claude is no longer in the TUI's process group, so a normal exit must reap it
    const killOnExit = () => killTree(proc, "SIGKILL");
    process.on("exit", killOnExit);

    // Wall-clock is enforced by a timer so a long iteration cannot overshoot the cap
    let timer: ReturnType<typeof setTimeout> | undefined;
    const wallClock = this.budgetCaps.max_wall_clock_minutes;
    if (wallClock !== undefined) {
      const leftMs = (wallClock - this.budgetNow().elapsed_minutes) * 60_000;
      timer = setTimeout(
        () => this.stopForBudget("wall_clock"),
        Math.min(Math.max(0, leftMs), MAX_TIMER_MS),
      );
    }
    const ticker = setInterval(
      () => this.config.onBudget?.(this.budgetNow()),
      BUDGET_TICK_MS,
    );
    try {
      return await this.readIteration(proc);
    } finally {
      clearTimeout(timer);
      clearInterval(ticker);
      process.off("exit", killOnExit);
    }
  }

  /**
   * Read claude's stdout until it ends (or the holdout guard fired) and return
   * the final result text; a non-zero exit is an error unless the guard killed it
   */
  private async readIteration(proc: Subprocess): Promise<string> {
    let fullResult = "";
    const stdout = proc.stdout;
    if (!stdout || typeof stdout === "number") {
      throw new Error("Failed to capture stdout from claude process");
    }
    const reader = stdout.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        for (const line of lines) {
          fullResult = this.processLine(line, fullResult);
          if (this.holdoutAccess || this.budgetStop) break;
        }
        if (this.holdoutAccess || this.budgetStop) {
          await reader.cancel().catch(() => {});
          break;
        }
      }

      // Process remaining buffer
      if (!this.holdoutAccess && !this.budgetStop) {
        fullResult = this.processLine(buffer, fullResult);
      }
    } finally {
      reader.releaseLock();
    }

    const exitCode = await proc.exited;

    if (exitCode !== 0 && !this.holdoutAccess && !this.budgetStop) {
      // Read stderr for error details
      let stderrText = "";
      try {
        const stderr = proc.stderr;
        if (stderr && typeof stderr !== "number") {
          stderrText = await new Response(stderr).text();
        }
      } catch {
        // Ignore stderr read errors
      }
      const errorDetail =
        stderrText.trim().slice(-500) || `exit code ${exitCode}`;
      throw new Error(`Claude process failed: ${errorDetail}`);
    }

    return fullResult;
  }

  /**
   * Parse one stdout line, emit its events and return the running result text
   */
  protected processLine(line: string, fullResult: string): string {
    const parsed = parseStreamLine(
      line,
      this.lastToolCall,
      this.holdoutNeedles,
    );
    this.lastToolCall = parsed.lastToolCall;
    for (const output of parsed.outputs) {
      this.config.onOutput?.(output);
    }
    if (parsed.holdoutAccess && !this.holdoutAccess) {
      this.holdoutAccess = parsed.holdoutAccess;
      if (this.currentProcess) killTree(this.currentProcess, "SIGKILL");
    }
    if (parsed.costUsd !== undefined) {
      this.budgetUsd += parsed.costUsd;
      this.iterationCost = (this.iterationCost ?? 0) + parsed.costUsd;
      const status = this.budgetNow();
      this.config.onBudget?.(status);
      const cap = exhaustedCap(status);
      if (cap === "usd") this.stopForBudget(cap);
    }
    return parsed.result ?? fullResult;
  }
}

export interface ToolCallRef {
  name: string;
  input: Record<string, unknown>;
}

/**
 * Convert one parsed stream-json object into StreamEvents.
 * Pure: takes the previous tool call (for pairing with tool_result) and
 * returns the events to emit plus the updated tool call.
 */
export function parseStreamEvent(
  event: Record<string, unknown>,
  lastToolCall: ToolCallRef | null,
): { outputs: StreamEvent[]; lastToolCall: ToolCallRef | null } {
  const outputs: StreamEvent[] = [];
  const eventType = event.type as string;

  if (eventType === "assistant") {
    const message = event.message as Record<string, unknown> | undefined;
    const content = (message?.content as Array<Record<string, unknown>>) || [];

    for (const block of content) {
      const blockType = block.type as string;

      if (blockType === "text") {
        const text = block.text as string;
        if (text) {
          outputs.push({ type: "text", content: text });
        }
      } else if (blockType === "tool_use") {
        const toolName = block.name as string;
        const toolInput = block.input as Record<string, unknown>;

        // Track last tool call for pairing with tool_result
        lastToolCall = { name: toolName, input: toolInput };

        let description = "";
        if (toolName === "Bash") {
          description =
            (toolInput.description as string) ||
            (toolInput.command as string)?.slice(0, 50) ||
            "";
        } else if (
          toolName === "Read" ||
          toolName === "Write" ||
          toolName === "Edit"
        ) {
          description = toolInput.file_path as string;
        } else if (toolName === "Glob" || toolName === "Grep") {
          description = toolInput.pattern as string;
        }

        // Detect team tools and enrich the event
        let agentName: string | undefined;
        let teamEvent: StreamEvent["teamEvent"];

        if (toolName === "TeamCreate") {
          teamEvent = "team_create";
          agentName = "lead";
          description = (toolInput.team_name as string) || "team";
        } else if (toolName === "Task" && toolInput.team_name) {
          teamEvent = "teammate_spawn";
          agentName = (toolInput.name as string) || "teammate";
          description = (toolInput.description as string) || "";
        } else if (toolName === "SendMessage") {
          teamEvent = "teammate_message";
          agentName = (toolInput.recipient as string) || "teammate";
          description =
            (toolInput.summary as string) ||
            (toolInput.content as string)?.slice(0, 50) ||
            "";
        } else if (toolName === "TaskUpdate") {
          teamEvent = "task_update";
          agentName = "lead";
          description = (toolInput.status as string) || "";
        } else if (toolName === "TaskCreate") {
          teamEvent = "task_update";
          agentName = "lead";
          description = (toolInput.subject as string) || "";
        }

        outputs.push({
          type: "tool_call",
          content: description,
          toolName,
          toolInput,
          agentName,
          teamEvent,
        });
      }
    }
  } else if (eventType === "user") {
    const message = event.message as Record<string, unknown> | undefined;
    const content = (message?.content as Array<Record<string, unknown>>) || [];

    for (const block of content) {
      if ((block.type as string) === "tool_result") {
        const isError = block.is_error as boolean;

        // Enrich tool_result with team context from the last tool_call
        let agentName: string | undefined;
        let teamEvent: StreamEvent["teamEvent"];

        if (lastToolCall) {
          if (lastToolCall.name === "Task" && lastToolCall.input.team_name) {
            teamEvent = "teammate_message";
            agentName = (lastToolCall.input.name as string) || "teammate";
          } else if (lastToolCall.name === "TeamCreate") {
            teamEvent = "team_create";
            agentName = "lead";
          } else if (lastToolCall.name === "SendMessage") {
            teamEvent = "teammate_message";
            agentName = (lastToolCall.input.recipient as string) || "teammate";
          } else if (
            lastToolCall.name === "TaskUpdate" ||
            lastToolCall.name === "TaskCreate"
          ) {
            teamEvent = "task_update";
            agentName = "lead";
          }
        }

        outputs.push({
          type: "tool_result",
          content: isError ? "failed" : "success",
          isError,
          agentName,
          teamEvent,
        });
      }
    }
  }
  // "result" and other event types emit nothing here

  return { outputs, lastToolCall };
}

export interface ParsedStreamLine {
  outputs: StreamEvent[];
  lastToolCall: ToolCallRef | null;
  /** Final result text, set only for a "result" event */
  result?: string;
  /** Set when a tool_use input contains a holdout needle; the tool's name only */
  holdoutAccess?: { toolName: string };
  /** total_cost_usd of a "result" event, when it is a finite non-negative number */
  costUsd?: number;
}

/**
 * Parse one raw stdout line from `claude --output-format stream-json`.
 * Blank lines yield no output; non-JSON lines are surfaced as text. With
 * holdout `needles`, a tool_use whose input contains one is flagged in
 * `holdoutAccess`, whatever else the line parses to.
 */
export function parseStreamLine(
  line: string,
  lastToolCall: ToolCallRef | null,
  needles: HoldoutNeedles = [],
): ParsedStreamLine {
  if (!line.trim()) return { outputs: [], lastToolCall };

  let event: unknown;
  try {
    event = JSON.parse(line);
  } catch {
    return { outputs: [{ type: "text", content: line }], lastToolCall };
  }

  if (typeof event !== "object" || event === null || Array.isArray(event)) {
    return { outputs: [{ type: "text", content: line }], lastToolCall };
  }

  const record = event as Record<string, unknown>;
  const access = findHoldoutToolUse(record, needles);
  const flag = access ? { holdoutAccess: access } : {};
  let parsed: ReturnType<typeof parseStreamEvent>;
  try {
    parsed = parseStreamEvent(record, lastToolCall);
  } catch {
    // Valid JSON with an unexpected shape: surface the raw line instead of aborting the loop
    return {
      outputs: [{ type: "text", content: line }],
      lastToolCall,
      ...flag,
    };
  }
  if (record.type === "result") {
    const cost = record.total_cost_usd;
    const costUsd =
      typeof cost === "number" && Number.isFinite(cost) && cost >= 0
        ? { costUsd: cost }
        : {};
    return {
      ...parsed,
      result: (record.result as string) || "",
      ...costUsd,
      ...flag,
    };
  }
  return { ...parsed, ...flag };
}

/**
 * Create a new runner instance
 */
export function createRunner(config: RunnerConfig): RalphRunner {
  return new RalphRunner(config);
}

export const __testing = { parseStreamEvent, parseStreamLine };
