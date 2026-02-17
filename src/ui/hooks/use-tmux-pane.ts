/**
 * Hook for managing a tmux pane in React components
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  TmuxManager,
  type TmuxPaneContent,
  type TmuxSessionConfig,
} from "../../infrastructure/tmux/index.ts";

export interface UseTmuxPaneOptions {
  /** Session name (should be unique per project) */
  sessionName: string;
  /** Working directory */
  cwd: string;
  /** Initial command to run when session is created */
  initialCommand?: string;
  /** Pane width */
  width?: number;
  /** Pane height */
  height?: number;
  /** Polling interval in ms (default 100) */
  pollInterval?: number;
  /** Auto-start on mount (default true) */
  autoStart?: boolean;
}

export interface UseTmuxPaneResult {
  /** Current pane content */
  content: TmuxPaneContent | null;
  /** Whether the session is running */
  isRunning: boolean;
  /** Any error that occurred */
  error: string | null;
  /** Session name */
  sessionName: string;
  /** Send keys to the tmux session */
  sendKeys: (keys: string) => Promise<void>;
  /** Send literal text (escapes special chars) */
  sendText: (text: string) => Promise<void>;
  /** Start the session */
  start: () => Promise<void>;
  /** Stop managing (session continues in background) */
  stop: () => void;
  /** Kill the session entirely */
  kill: () => Promise<void>;
  /** Resize the pane */
  resize: (width: number, height: number) => Promise<void>;
}

export function useTmuxPane(options: UseTmuxPaneOptions): UseTmuxPaneResult {
  const {
    sessionName,
    cwd,
    initialCommand,
    width = 80,
    height = 24,
    pollInterval = 100,
    autoStart = true,
  } = options;

  const [content, setContent] = useState<TmuxPaneContent | null>(null);
  const [isRunning, setIsRunning] = useState(autoStart);
  const [error, setError] = useState<string | null>(null);

  const managerRef = useRef<TmuxManager | null>(null);

  // Create manager config (memoized to avoid recreating on every render)
  const config: TmuxSessionConfig = useMemo(
    () => ({
      name: sessionName,
      cwd,
      width,
      height,
      initialCommand,
    }),
    [sessionName, cwd, width, height, initialCommand],
  );

  // Start the session
  const start = useCallback(async () => {
    if (managerRef.current?.getIsRunning()) return;

    setError(null);

    const manager = new TmuxManager(config, {
      onContentUpdate: setContent,
      onSessionEnd: () => {
        setIsRunning(false);
        setContent(null);
      },
      onError: (err) => setError(err.message),
    });

    const started = await manager.start();
    if (started) {
      manager.startPolling(pollInterval);
      managerRef.current = manager;
      setIsRunning(true);
    } else {
      setError("Failed to start tmux session");
    }
  }, [config, pollInterval]);

  // Stop managing (session continues)
  const stop = useCallback(() => {
    if (managerRef.current) {
      managerRef.current.stop();
      managerRef.current = null;
      setIsRunning(false);
    }
  }, []);

  // Kill session entirely
  const kill = useCallback(async () => {
    if (managerRef.current) {
      await managerRef.current.kill();
      managerRef.current = null;
      setIsRunning(false);
      setContent(null);
    }
  }, []);

  // Send keys
  const sendKeys = useCallback(async (keys: string) => {
    if (managerRef.current) {
      const success = await managerRef.current.sendKeys(keys);
      if (!success) {
        setError("Failed to send keys");
      }
    }
  }, []);

  // Send literal text
  const sendText = useCallback(async (text: string) => {
    if (managerRef.current) {
      const success = await managerRef.current.sendText(text);
      if (!success) {
        setError("Failed to send text");
      }
    }
  }, []);

  // Resize pane
  const resize = useCallback(async (newWidth: number, newHeight: number) => {
    if (managerRef.current) {
      await managerRef.current.resize(newWidth, newHeight);
    }
  }, []);

  // Auto-start on mount
  useEffect(() => {
    if (autoStart) {
      start();
    }

    return () => {
      // Stop polling but don't kill session on unmount
      if (managerRef.current) {
        managerRef.current.stop();
        managerRef.current = null;
      }
    };
  }, [autoStart, start]);

  return {
    content,
    isRunning,
    error,
    sessionName,
    sendKeys,
    sendText,
    start,
    stop,
    kill,
    resize,
  };
}
