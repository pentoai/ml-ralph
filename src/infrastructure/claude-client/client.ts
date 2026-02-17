/**
 * Claude CLI client using stream-json protocol
 */

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { type Subprocess, spawn } from "bun";
import type {
  ClaudeClientEvents,
  ClaudeClientOptions,
  ContentBlockDeltaEvent,
  ContentBlockStartEvent,
  InputMessage,
  OutputMessage,
  SessionInfo,
  StreamEvent,
  ToolInfo,
  TurnResult,
} from "./types.ts";

/**
 * Find the claude CLI command path
 */
function findClaudeCommand(): string {
  const home = homedir();
  const candidates = [
    join(home, ".local", "bin", "claude"),
    join(home, ".npm-global", "bin", "claude"),
    "/usr/local/bin/claude",
    "/opt/homebrew/bin/claude",
  ];

  for (const path of candidates) {
    if (existsSync(path)) {
      return path;
    }
  }

  return "claude";
}

export class ClaudeClient {
  private proc: Subprocess<"pipe", "pipe", "pipe"> | null = null;
  private sessionId: string | null = null;
  private buffer = "";
  private currentText = "";
  private currentToolId: string | null = null;
  private events: ClaudeClientEvents;
  private options: ClaudeClientOptions;
  private claudePath: string;
  private running = false;

  constructor(options: ClaudeClientOptions, events: ClaudeClientEvents = {}) {
    this.options = options;
    this.events = events;
    this.claudePath = findClaudeCommand();
  }

  /**
   * Start the Claude process
   */
  start(): void {
    if (this.proc) {
      throw new Error("Client already started");
    }

    const args = [
      "-p",
      "--input-format",
      "stream-json",
      "--output-format",
      "stream-json",
      "--include-partial-messages",
    ];

    if (this.options.dangerouslySkipPermissions !== false) {
      args.push("--dangerously-skip-permissions");
    }

    if (this.options.systemPrompt) {
      args.push("--append-system-prompt", this.options.systemPrompt);
    }

    if (this.options.model) {
      args.push("--model", this.options.model);
    }

    this.proc = spawn([this.claudePath, ...args], {
      cwd: this.options.cwd,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });

    this.running = true;

    // Read stdout
    this.readStream(this.proc.stdout, (data) => {
      this.handleOutput(data);
    });

    // Read stderr
    this.readStream(this.proc.stderr, (data) => {
      this.events.onError?.(new Error(`stderr: ${data}`));
    });

    // Handle exit
    this.proc.exited.then((code) => {
      this.running = false;
      if (code !== 0) {
        this.events.onError?.(new Error(`Process exited with code ${code}`));
      }
    });
  }

  /**
   * Send a message to Claude
   */
  send(content: string): void {
    if (!this.proc?.stdin) {
      throw new Error("Client not started");
    }

    // Reset state for new turn
    this.currentText = "";
    this.currentToolId = null;

    const msg: InputMessage = {
      type: "user",
      message: { role: "user", content },
    };

    this.proc.stdin.write(`${JSON.stringify(msg)}\n`);
  }

  /**
   * Stop the Claude process
   */
  stop(): void {
    if (this.proc) {
      this.proc.stdin.end();
      this.proc.kill();
      this.proc = null;
      this.running = false;
    }
  }

  /**
   * Check if client is running
   */
  isRunning(): boolean {
    return this.running;
  }

  /**
   * Get current session ID
   */
  getSessionId(): string | null {
    return this.sessionId;
  }

  /**
   * Read a stream and call callback with data
   */
  private async readStream(
    stream: ReadableStream<Uint8Array>,
    onData: (data: string) => void,
  ): Promise<void> {
    const reader = stream.getReader();
    const decoder = new TextDecoder();

    try {
      while (this.running) {
        const { done, value } = await reader.read();
        if (done) break;
        onData(decoder.decode(value));
      }
    } catch {
      // Stream closed
    } finally {
      reader.releaseLock();
    }
  }

  /**
   * Handle output from Claude process
   */
  private handleOutput(data: string): void {
    this.buffer += data;

    // Process complete lines
    const lines = this.buffer.split("\n");
    this.buffer = lines.pop() ?? "";

    for (const line of lines) {
      if (!line.trim()) continue;

      try {
        const msg = JSON.parse(line) as OutputMessage;
        this.handleMessage(msg);
      } catch {
        // Ignore parse errors for malformed lines
      }
    }
  }

  /**
   * Handle a parsed message
   */
  private handleMessage(msg: OutputMessage): void {
    switch (msg.type) {
      case "system":
        if (msg.subtype === "init") {
          this.sessionId = msg.session_id;
          const session: SessionInfo = {
            sessionId: msg.session_id,
            model: msg.model,
            tools: msg.tools,
            cwd: msg.cwd,
          };
          this.events.onInit?.(session);
        }
        break;

      case "stream_event":
        this.handleStreamEvent(msg.event);
        break;

      case "user":
        // Tool result
        if (msg.message.content[0]?.type === "tool_result") {
          const toolResult = msg.message.content[0];
          this.events.onToolEnd?.(
            toolResult.tool_use_id,
            toolResult.content,
            toolResult.is_error,
          );
          this.currentToolId = null;
        }
        break;

      case "result": {
        const turnResult: TurnResult = {
          text: msg.result,
          costUsd: msg.total_cost_usd,
          durationMs: msg.duration_ms,
          numTurns: msg.num_turns,
        };
        this.events.onTurnComplete?.(turnResult);

        if (msg.is_error && msg.error) {
          this.events.onError?.(new Error(msg.error));
        }
        break;
      }
    }
  }

  /**
   * Handle stream events
   */
  private handleStreamEvent(event: StreamEvent): void {
    switch (event.type) {
      case "content_block_start": {
        const startEvent = event as ContentBlockStartEvent;
        if (startEvent.content_block.type === "tool_use") {
          const tool: ToolInfo = {
            id: startEvent.content_block.id,
            name: startEvent.content_block.name,
          };
          this.currentToolId = tool.id;
          this.events.onToolStart?.(tool);
        }
        break;
      }

      case "content_block_delta": {
        const deltaEvent = event as ContentBlockDeltaEvent;
        if (deltaEvent.delta.type === "text_delta") {
          this.currentText += deltaEvent.delta.text;
          this.events.onTextDelta?.(deltaEvent.delta.text);
        }
        break;
      }

      case "content_block_stop":
        // Emit full text when text block completes
        if (this.currentText && !this.currentToolId) {
          this.events.onText?.(this.currentText);
        }
        break;
    }
  }
}
