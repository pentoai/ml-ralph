/**
 * Types for tmux session management
 */

export interface TmuxSessionConfig {
  /** Session name (must be unique) */
  name: string;
  /** Working directory for the session */
  cwd: string;
  /** Initial width in columns */
  width?: number;
  /** Initial height in rows */
  height?: number;
  /** Initial command to run (optional) */
  initialCommand?: string;
}

export interface TmuxSessionInfo {
  name: string;
  windows: number;
  created: Date;
  attached: boolean;
}

export interface TmuxPaneContent {
  /** Raw text content (may include ANSI codes) */
  text: string;
  /** Lines of content */
  lines: string[];
  /** Pane width */
  width: number;
  /** Pane height */
  height: number;
}

export interface TmuxManagerEvents {
  onContentUpdate?: (content: TmuxPaneContent) => void;
  onSessionEnd?: () => void;
  onError?: (error: Error) => void;
}
