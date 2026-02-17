/**
 * Tmux Layout Manager
 *
 * Manages tmux layout for ml-ralph:
 * - Monitor mode: ml-ralph full screen
 * - Planning mode: split with terminal on left, ml-ralph on right
 */

export interface LayoutManagerConfig {
  /** Session name for the terminal pane */
  sessionName: string;
  /** Working directory for new terminal panes */
  cwd: string;
}

export class TmuxLayoutManager {
  private config: LayoutManagerConfig;
  private terminalPaneId: string | null = null;
  private mlRalphPaneId: string | null = null;
  private isInTmux: boolean = false;
  private initialized: boolean = false;

  constructor(config: LayoutManagerConfig) {
    this.config = config;
  }

  /**
   * Check if we're running inside tmux
   */
  static isInsideTmux(): boolean {
    return !!process.env.TMUX;
  }

  /**
   * Get current tmux session name
   */
  static getCurrentSession(): string | null {
    if (!TmuxLayoutManager.isInsideTmux()) return null;
    // TMUX env var format: /tmp/tmux-501/default,12345,0
    // or we can use tmux display-message
    return process.env.TMUX_SESSION || null;
  }

  /**
   * Initialize the layout manager
   */
  async initialize(): Promise<boolean> {
    if (this.initialized) return true;

    this.isInTmux = TmuxLayoutManager.isInsideTmux();

    if (!this.isInTmux) {
      // Not in tmux - we need to launch ourselves inside tmux
      console.error(
        "ml-ralph works best inside tmux. Please run: tmux new-session -s ml-ralph",
      );
      return false;
    }

    // Get our current pane ID
    try {
      const proc = Bun.spawn(["tmux", "display-message", "-p", "#{pane_id}"], {
        stdout: "pipe",
        stderr: "pipe",
      });
      const output = await new Response(proc.stdout).text();
      await proc.exited;
      this.mlRalphPaneId = output.trim();
    } catch {
      return false;
    }

    // Set up tmux status bar with ml-ralph hint
    await this.setupStatusBar();

    this.initialized = true;
    return true;
  }

  /**
   * Set up tmux status bar and terminal settings
   */
  private async setupStatusBar(): Promise<void> {
    // Enable extended keys so Shift+Enter and other key combos work
    // See: https://github.com/tmux/tmux/issues/3104
    // These commands might fail on older tmux versions, so we ignore errors
    try {
      await this.tmuxCommand(["set-option", "-g", "xterm-keys", "on"]);
      await this.tmuxCommand(["set-option", "-g", "extended-keys", "off"]);
    } catch {
      // Ignore errors on older tmux versions
    }

    // Set status bar style
    await this.tmuxCommand([
      "set-option",
      "-g",
      "status-style",
      "bg=#1a1a2e,fg=#a0a0a0",
    ]);

    // Left side: mode indicator
    await this.tmuxCommand([
      "set-option",
      "-g",
      "status-left",
      "#[fg=#4ADE80,bold] ml-ralph #[fg=#a0a0a0]│ ",
    ]);

    // Right side: hint for returning (Ctrl+b m for ml-ralph)
    await this.tmuxCommand([
      "set-option",
      "-g",
      "status-right",
      " #[fg=#60A5FA]Ctrl+b m → ml-ralph #[fg=#a0a0a0]│ %H:%M ",
    ]);

    // Add key binding: Ctrl+b m to focus ml-ralph pane
    if (this.mlRalphPaneId) {
      await this.tmuxCommand([
        "bind-key",
        "m",
        "select-pane",
        "-t",
        this.mlRalphPaneId,
      ]);
    }
  }

  /**
   * Enter planning mode - create split with terminal on left
   */
  async enterPlanningMode(): Promise<boolean> {
    if (!this.initialized || !this.isInTmux) return false;

    // If terminal pane already exists, just make sure layout is correct
    if (this.terminalPaneId) {
      // Check if pane still exists
      const exists = await this.paneExists(this.terminalPaneId);
      if (exists) {
        // Just ensure proper layout
        await this.adjustLayout();
        return true;
      }
      this.terminalPaneId = null;
    }

    // Create new pane on the left (split horizontally, new pane goes left)
    try {
      const proc = Bun.spawn(
        [
          "tmux",
          "split-window",
          "-h", // horizontal split
          "-b", // new pane goes before (left of) current
          "-c",
          this.config.cwd, // working directory
          "-P", // print pane info
          "-F",
          "#{pane_id}", // format: just pane ID
        ],
        { stdout: "pipe", stderr: "pipe" },
      );
      const output = await new Response(proc.stdout).text();
      const code = await proc.exited;

      if (code !== 0) return false;

      this.terminalPaneId = output.trim();

      // Adjust layout - terminal 1/3, ml-ralph 2/3
      await this.adjustLayout();

      // Launch Claude Code in the terminal pane
      await this.tmuxCommand([
        "send-keys",
        "-t",
        this.terminalPaneId,
        "claude --dangerously-skip-permissions",
        "Enter",
      ]);

      // Focus back on ml-ralph pane
      if (this.mlRalphPaneId) {
        await this.tmuxCommand(["select-pane", "-t", this.mlRalphPaneId]);
      }

      return true;
    } catch {
      return false;
    }
  }

  /**
   * Enter monitor mode - minimize terminal pane, ml-ralph goes nearly full screen
   */
  async enterMonitorMode(): Promise<boolean> {
    if (!this.initialized || !this.isInTmux) return false;

    if (this.terminalPaneId) {
      // Check if pane exists
      const exists = await this.paneExists(this.terminalPaneId);
      if (exists) {
        // Minimize the terminal pane to 1 column (preserve the session)
        await this.tmuxCommand([
          "resize-pane",
          "-t",
          this.terminalPaneId,
          "-x",
          "1",
        ]);
      }
    }

    return true;
  }

  /**
   * Adjust the layout to 1/3 terminal, 2/3 ml-ralph
   */
  private async adjustLayout(): Promise<void> {
    // Get current window width
    const proc = Bun.spawn(
      ["tmux", "display-message", "-p", "#{window_width}"],
      { stdout: "pipe", stderr: "pipe" },
    );
    const output = await new Response(proc.stdout).text();
    await proc.exited;

    const windowWidth = Number.parseInt(output.trim(), 10) || 120;
    const terminalWidth = Math.floor(windowWidth / 3); // 1/3 for terminal

    // Resize terminal pane (left) to 1/3
    if (this.terminalPaneId) {
      await this.tmuxCommand([
        "resize-pane",
        "-t",
        this.terminalPaneId,
        "-x",
        String(terminalWidth),
      ]);
    }
  }

  /**
   * Check if a pane exists
   */
  private async paneExists(paneId: string): Promise<boolean> {
    try {
      const proc = Bun.spawn(["tmux", "list-panes", "-F", "#{pane_id}"], {
        stdout: "pipe",
        stderr: "pipe",
      });
      const output = await new Response(proc.stdout).text();
      await proc.exited;
      return output.includes(paneId);
    } catch {
      return false;
    }
  }

  /**
   * Send keys to the terminal pane
   */
  async sendKeysToTerminal(keys: string): Promise<boolean> {
    if (!this.terminalPaneId) return false;

    try {
      const proc = Bun.spawn(
        ["tmux", "send-keys", "-t", this.terminalPaneId, keys],
        { stdout: "pipe", stderr: "pipe" },
      );
      const code = await proc.exited;
      return code === 0;
    } catch {
      return false;
    }
  }

  /**
   * Focus the terminal pane
   */
  async focusTerminal(): Promise<boolean> {
    if (!this.terminalPaneId) return false;

    try {
      const proc = Bun.spawn(
        ["tmux", "select-pane", "-t", this.terminalPaneId],
        { stdout: "pipe", stderr: "pipe" },
      );
      const code = await proc.exited;
      return code === 0;
    } catch {
      return false;
    }
  }

  /**
   * Focus ml-ralph pane
   */
  async focusMlRalph(): Promise<boolean> {
    if (!this.mlRalphPaneId) return false;

    try {
      const proc = Bun.spawn(
        ["tmux", "select-pane", "-t", this.mlRalphPaneId],
        { stdout: "pipe", stderr: "pipe" },
      );
      const code = await proc.exited;
      return code === 0;
    } catch {
      return false;
    }
  }

  /**
   * Run a tmux command
   */
  private async tmuxCommand(args: string[]): Promise<boolean> {
    try {
      const proc = Bun.spawn(["tmux", ...args], {
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
   * Get terminal pane ID
   */
  getTerminalPaneId(): string | null {
    return this.terminalPaneId;
  }

  /**
   * Check if terminal pane exists
   */
  hasTerminalPane(): boolean {
    return this.terminalPaneId !== null;
  }

  /**
   * Check if in tmux
   */
  getIsInTmux(): boolean {
    return this.isInTmux;
  }
}
