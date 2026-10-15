/**
 * ML-Ralph runner - executes the autonomous agent loop
 */

import type { Subprocess } from "bun";

export interface RunnerConfig {
  projectPath: string;
  maxIterations?: number;
  enableTeams?: boolean;
  onOutput?: (event: StreamEvent) => void;
  onIterationStart?: (iteration: number) => void;
  onIterationEnd?: (iteration: number, result: string) => void;
  onComplete?: (reason: "project_complete" | "max_iterations") => void;
  onError?: (error: Error) => void;
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

export class RalphRunner {
  private config: RunnerConfig;
  private running = false;
  private currentProcess: Subprocess | null = null;
  private currentIteration = 0;
  private pendingHints: string[] = [];
  private lastToolCall: ToolCallRef | null = null;

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

    const basePrompt = `Read .ml-ralph/RALPH.md for instructions.

Execute one iteration of the cognitive loop. Update state files as needed.
When done, output exactly: <iteration_complete>

If the project is complete (success criteria met), output: <project_complete>`;

    try {
      for (let i = 1; i <= this.config.maxIterations!; i++) {
        if (!this.running) break;

        this.currentIteration = i;
        this.config.onIterationStart?.(i);

        // Build prompt with any pending hints
        const hints = this.consumeHints();
        const prompt = hints ? basePrompt + hints : basePrompt;

        // Emit iteration marker
        this.config.onOutput?.({
          type: "iteration_marker",
          content: `═══ Iteration ${i} ═══`,
        });

        const result = await this.runIteration(prompt);

        this.config.onIterationEnd?.(i, result);

        if (result.includes("<project_complete>")) {
          this.config.onComplete?.("project_complete");
          break;
        }
      }

      if (this.currentIteration >= this.config.maxIterations!) {
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
    if (this.currentProcess) {
      this.currentProcess.kill();
      this.currentProcess = null;
    }
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
  private async runIteration(prompt: string): Promise<string> {
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

    const proc = Bun.spawn(cmd, {
      cwd: this.config.projectPath,
      stdout: "pipe",
      stderr: "pipe",
      env: {
        ...process.env,
        ...(this.config.enableTeams
          ? { CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: "1" }
          : {}),
      },
    });
    this.currentProcess = proc;

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
        }
      }

      // Process remaining buffer
      fullResult = this.processLine(buffer, fullResult);
    } finally {
      reader.releaseLock();
    }

    const exitCode = await proc.exited;

    if (exitCode !== 0) {
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
  private processLine(line: string, fullResult: string): string {
    const parsed = parseStreamLine(line, this.lastToolCall);
    this.lastToolCall = parsed.lastToolCall;
    for (const output of parsed.outputs) {
      this.config.onOutput?.(output);
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
}

/**
 * Parse one raw stdout line from `claude --output-format stream-json`.
 * Blank lines yield no output; non-JSON lines are surfaced as text.
 */
export function parseStreamLine(
  line: string,
  lastToolCall: ToolCallRef | null,
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
  let parsed: ReturnType<typeof parseStreamEvent>;
  try {
    parsed = parseStreamEvent(record, lastToolCall);
  } catch {
    // Valid JSON with an unexpected shape: surface the raw line instead of aborting the loop
    return { outputs: [{ type: "text", content: line }], lastToolCall };
  }
  if (record.type === "result") {
    return { ...parsed, result: (record.result as string) || "" };
  }
  return parsed;
}

/**
 * Create a new runner instance
 */
export function createRunner(config: RunnerConfig): RalphRunner {
  return new RalphRunner(config);
}

export const __testing = { parseStreamEvent, parseStreamLine };
