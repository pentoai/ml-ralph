/**
 * ML-Ralph runner - executes the autonomous agent loop
 */

import type { Subprocess } from "bun";
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
import { type HoldoutResult, scoreHoldout } from "./holdout.ts";
import {
  findHoldoutToolUse,
  type HoldoutNeedles,
  loadHoldoutNeedles,
} from "./holdout-guard.ts";
import {
  judgeCandidate,
  type PromotionDeps,
  parseCandidateComplete,
  recordBaselineRef,
} from "./promotion.ts";

/** Why a run ended. Only the runner ends a run: the agent's output never does */
export type RunCompleteReason =
  | "max_iterations"
  | "contract_changed"
  | "holdout_access";

export interface RunnerConfig {
  projectPath: string;
  maxIterations?: number;
  enableTeams?: boolean;
  onOutput?: (event: StreamEvent) => void;
  onIterationStart?: (iteration: number) => void;
  onIterationEnd?: (iteration: number, result: string) => void;
  onComplete?: (reason: RunCompleteReason) => void;
  /**
   * A locked eval file changed; the run is paused until resolveContractChange
   * is called. `relockError` is set when the previous re-lock attempt failed.
   */
  onContractChanged?: (changes: EvalChange[], relockError?: string) => void;
  onError?: (error: Error) => void;
  /** Replaces the verifier and git lookups of the promotion gate (tests) */
  promotionDeps?: Partial<PromotionDeps>;
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

export class RalphRunner {
  private config: RunnerConfig;
  private running = false;
  private currentProcess: Subprocess | null = null;
  private currentIteration = 0;
  private pendingHints: string[] = [];
  private pendingFeedback: string[] = [];
  private lastToolCall: ToolCallRef | null = null;
  private holdoutNeedles: HoldoutNeedles = [];
  private holdoutAccess: { toolName: string } | null = null;
  private pinnedHashes: EvalLock["files"] | null = null;
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
    if (this.running) return;

    const initialized = await this.isInitialized();
    if (!initialized) {
      this.config.onError?.(new Error("Not initialized. Run init first."));
      return;
    }

    this.running = true;
    this.currentIteration = 0;
    this.pinnedHashes = null;
    this.pendingFeedback = [];
    this.holdoutAccess = null;
    let baselineRecorded = false;

    const basePrompt = `Read .ml-ralph/RALPH.md for instructions.

Execute one iteration of the cognitive loop. Update state files as needed.
When done, output exactly: <iteration_complete>

If you have a candidate you believe is a new best, follow "Completing a Candidate" in RALPH.md and also output: <candidate_complete eval_id="...">
Only the runner decides whether a candidate is promoted, and only the runner ends the run.`;

    try {
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
        const prompt =
          basePrompt + this.consumeFeedback() + (this.consumeHints() ?? "");
        const iterationStartedAt = new Date().toISOString();

        // Emit iteration marker
        this.config.onOutput?.({
          type: "iteration_marker",
          content: `═══ Iteration ${i} ═══`,
        });

        this.holdoutNeedles = await loadHoldoutNeedles(this.config.projectPath);
        const result = await this.runIteration(prompt);

        const access = this.holdoutAccessed();
        if (access) {
          await this.endForHoldoutAccess(access.toolName);
          return;
        }

        this.config.onIterationEnd?.(i, result);

        await this.judgeIteration(result, iterationStartedAt);
      }

      if (this.running && this.currentIteration >= this.config.maxIterations!) {
        this.config.onComplete?.("max_iterations");
      }
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      this.config.onError?.(err);
      throw err;
    } finally {
      this.running = false;
      this.currentProcess = null;
    }
  }

  /**
   * Stop the running loop
   */
  stop(): void {
    this.running = false;
    this.settleContractDecision(null);
    if (this.currentProcess) {
      killTree(this.currentProcess, "SIGTERM");
      this.currentProcess = null;
    }
  }

  /**
   * Score an eval's candidate on the sealed holdout, at most once per eval_id.
   * The holdout path is read from the user-level config and reaches only the
   * evaluator subprocess; it is never part of a prompt.
   */
  scoreHoldout(evalId: string): Promise<HoldoutResult> {
    return scoreHoldout(evalId, { projectPath: this.config.projectPath });
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
    this.config.onComplete?.("holdout_access");
  }

  /**
   * Act on the agent's output: a <candidate_complete> goes to the promotion
   * gate and its decision is queued for the next prompt. <project_complete> is
   * ignored; the agent cannot end a run.
   */
  private async judgeIteration(
    result: string,
    iterationStartedAt: string,
  ): Promise<void> {
    const candidate = parseCandidateComplete(result);
    if (candidate && this.pinnedHashes) {
      const decision = await judgeCandidate(
        {
          projectPath: this.config.projectPath,
          claimedEvalId: candidate.evalId,
          iterationStartedAt,
          lockedFiles: this.pinnedHashes,
        },
        this.config.promotionDeps,
      );
      this.pendingFeedback.push(decision.feedback);
    }
    if (result.includes("<project_complete>")) {
      this.pendingFeedback.push(
        'The runner ignores <project_complete>: only the runner ends a run. Hand in a candidate with <candidate_complete eval_id="..."> instead.',
      );
    }
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
        this.config.onComplete?.("contract_changed");
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
    return this.running;
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
    const logPath = `${this.config.projectPath}/.ml-ralph/log.jsonl`;
    const line = `${JSON.stringify({ ts: new Date().toISOString(), ...event })}\n`;
    const file = Bun.file(logPath);
    const existing = (await file.exists()) ? await file.text() : "";
    await Bun.write(logPath, existing + line);
  }

  /**
   * Run a single iteration
   */
  protected async runIteration(prompt: string): Promise<string> {
    // Inject an initial log event so the TUI shows something immediately
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
        ...(this.config.enableTeams
          ? { CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: "1" }
          : {}),
      },
    });
    this.currentProcess = proc;

    // claude is no longer in the TUI's process group, so a normal exit must reap it
    const killOnExit = () => killTree(proc, "SIGKILL");
    process.on("exit", killOnExit);
    try {
      return await this.readIteration(proc);
    } finally {
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
          if (this.holdoutAccess) break;
        }
        if (this.holdoutAccess) {
          await reader.cancel().catch(() => {});
          break;
        }
      }

      // Process remaining buffer
      if (!this.holdoutAccess) {
        fullResult = this.processLine(buffer, fullResult);
      }
    } finally {
      reader.releaseLock();
    }

    const exitCode = await proc.exited;

    if (exitCode !== 0 && !this.holdoutAccess) {
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
    return { ...parsed, result: (record.result as string) || "", ...flag };
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
