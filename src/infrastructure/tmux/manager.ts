/**
 * Tmux session manager
 *
 * Handles creating, managing, and interacting with tmux sessions.
 */

import type {
  TmuxManagerEvents,
  TmuxPaneContent,
  TmuxSessionConfig,
  TmuxSessionInfo,
} from "./types.ts";

export class TmuxManager {
  private sessionName: string;
  private config: TmuxSessionConfig;
  private events: TmuxManagerEvents;
  private pollInterval: ReturnType<typeof setInterval> | null = null;
  private isRunning = false;

  constructor(config: TmuxSessionConfig, events: TmuxManagerEvents = {}) {
    this.config = config;
    this.sessionName = config.name;
    this.events = events;
  }

  /**
   * Check if tmux is available
   */
  static async isAvailable(): Promise<boolean> {
    try {
      const proc = Bun.spawn(["which", "tmux"], {
        stdout: "pipe",
        stderr: "pipe",
      });
      const code = await proc.exited;
      return code === 0;
    } catch {
      return false;
    }
  }

  /**
   * List all tmux sessions
   */
  static async listSessions(): Promise<TmuxSessionInfo[]> {
    try {
      const proc = Bun.spawn(
        [
          "tmux",
          "list-sessions",
          "-F",
          "#{session_name}|#{session_windows}|#{session_created}|#{session_attached}",
        ],
        { stdout: "pipe", stderr: "pipe" },
      );
      const output = await new Response(proc.stdout).text();
      const code = await proc.exited;

      if (code !== 0) return [];

      return output
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => {
          const parts = line.split("|");
          return {
            name: parts[0] ?? "",
            windows: Number.parseInt(parts[1] ?? "0", 10),
            created: new Date(Number.parseInt(parts[2] ?? "0", 10) * 1000),
            attached: parts[3] === "1",
          };
        })
        .filter((s) => s.name !== "");
    } catch {
      return [];
    }
  }

  /**
   * Check if a session exists
   */
  async sessionExists(): Promise<boolean> {
    try {
      const proc = Bun.spawn(["tmux", "has-session", "-t", this.sessionName], {
        stdout: "pipe",
        stderr: "pipe",
      });
      const code = await proc.exited;
      return code === 0;
    } catch {
      return false;
    }
  }

  /**
   * Create or attach to the session
   */
  async start(): Promise<boolean> {
    if (this.isRunning) return true;

    const exists = await this.sessionExists();

    if (!exists) {
      // Create new session
      const args = [
        "new-session",
        "-d", // detached
        "-s",
        this.sessionName,
        "-x",
        String(this.config.width ?? 80),
        "-y",
        String(this.config.height ?? 24),
        "-c",
        this.config.cwd,
      ];

      const proc = Bun.spawn(["tmux", ...args], {
        stdout: "pipe",
        stderr: "pipe",
      });
      const code = await proc.exited;

      if (code !== 0) {
        const stderr = await new Response(proc.stderr).text();
        this.events.onError?.(new Error(`Failed to create session: ${stderr}`));
        return false;
      }
    }

    // Mark as running before sending any commands
    this.isRunning = true;

    // Wait for shell to initialize before sending commands (only for new sessions)
    if (!exists && this.config.initialCommand) {
      await Bun.sleep(300);
      await this.sendKeys(this.config.initialCommand);
      await this.sendKeys("Enter");
    }

    return true;
  }

  /**
   * Start polling for content updates
   */
  startPolling(intervalMs = 100): void {
    if (this.pollInterval) return;

    this.pollInterval = setInterval(async () => {
      const content = await this.capturePane();
      if (content) {
        this.events.onContentUpdate?.(content);
      }
    }, intervalMs);
  }

  /**
   * Stop polling
   */
  stopPolling(): void {
    if (this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = null;
    }
  }

  /**
   * Capture the current pane content
   */
  async capturePane(preserveColors = true): Promise<TmuxPaneContent | null> {
    if (!this.isRunning) return null;

    try {
      // Get pane dimensions
      const dimProc = Bun.spawn(
        [
          "tmux",
          "display-message",
          "-t",
          this.sessionName,
          "-p",
          "#{pane_width}|#{pane_height}",
        ],
        { stdout: "pipe", stderr: "pipe" },
      );
      const dimOutput = await new Response(dimProc.stdout).text();
      const dimParts = dimOutput.trim().split("|");
      const width = Number.parseInt(dimParts[0] ?? "80", 10) || 80;
      const height = Number.parseInt(dimParts[1] ?? "24", 10) || 24;

      // Capture content
      // -p: print to stdout
      // -e: include escape sequences (colors)
      // -J: join wrapped lines
      const args = ["capture-pane", "-t", this.sessionName, "-p", "-J"];
      if (preserveColors) {
        args.push("-e"); // Include escape sequences
      }

      const proc = Bun.spawn(["tmux", ...args], {
        stdout: "pipe",
        stderr: "pipe",
      });
      const text = await new Response(proc.stdout).text();
      const code = await proc.exited;

      if (code !== 0) return null;

      // Split into lines but preserve trailing empty lines for proper rendering
      const lines = text.split("\n");
      // Remove the last element if it's empty (from trailing newline)
      if (lines[lines.length - 1] === "") {
        lines.pop();
      }

      return { text, lines, width, height };
    } catch (err) {
      this.events.onError?.(err as Error);
      return null;
    }
  }

  /**
   * Send keys to the tmux session
   */
  async sendKeys(keys: string): Promise<boolean> {
    if (!this.isRunning) return false;

    try {
      const proc = Bun.spawn(
        ["tmux", "send-keys", "-t", this.sessionName, keys],
        { stdout: "pipe", stderr: "pipe" },
      );
      const code = await proc.exited;
      return code === 0;
    } catch {
      return false;
    }
  }

  /**
   * Send literal text (escapes special characters)
   */
  async sendText(text: string): Promise<boolean> {
    if (!this.isRunning) return false;

    try {
      const proc = Bun.spawn(
        ["tmux", "send-keys", "-t", this.sessionName, "-l", text],
        { stdout: "pipe", stderr: "pipe" },
      );
      const code = await proc.exited;
      return code === 0;
    } catch {
      return false;
    }
  }

  /**
   * Resize the pane
   */
  async resize(width: number, height: number): Promise<boolean> {
    if (!this.isRunning) return false;

    try {
      // For a single-pane window, we need to resize the window
      const proc = Bun.spawn(
        [
          "tmux",
          "resize-window",
          "-t",
          this.sessionName,
          "-x",
          String(width),
          "-y",
          String(height),
        ],
        { stdout: "pipe", stderr: "pipe" },
      );
      const code = await proc.exited;
      return code === 0;
    } catch {
      return false;
    }
  }

  /**
   * Kill the session
   */
  async kill(): Promise<boolean> {
    this.stopPolling();
    this.isRunning = false;

    try {
      const proc = Bun.spawn(["tmux", "kill-session", "-t", this.sessionName], {
        stdout: "pipe",
        stderr: "pipe",
      });
      const code = await proc.exited;
      if (code === 0) {
        this.events.onSessionEnd?.();
      }
      return code === 0;
    } catch {
      return false;
    }
  }

  /**
   * Stop managing (but don't kill the session)
   */
  stop(): void {
    this.stopPolling();
    this.isRunning = false;
  }

  /**
   * Check if manager is running
   */
  getIsRunning(): boolean {
    return this.isRunning;
  }

  /**
   * Get session name
   */
  getSessionName(): string {
    return this.sessionName;
  }
}
