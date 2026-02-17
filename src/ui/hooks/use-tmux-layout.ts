/**
 * Hook for managing tmux layout in ml-ralph
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { TmuxLayoutManager } from "../../infrastructure/tmux/index.ts";

export interface UseTmuxLayoutOptions {
  /** Working directory */
  cwd: string;
  /** Session name */
  sessionName?: string;
}

export interface UseTmuxLayoutResult {
  /** Whether we're running inside tmux */
  isInTmux: boolean;
  /** Whether the layout manager is initialized */
  isInitialized: boolean;
  /** Whether the terminal pane exists */
  hasTerminalPane: boolean;
  /** Any error that occurred */
  error: string | null;
  /** Enter planning mode (create terminal split) */
  enterPlanningMode: () => Promise<boolean>;
  /** Enter monitor mode (close terminal split) */
  enterMonitorMode: () => Promise<boolean>;
  /** Focus the terminal pane */
  focusTerminal: () => Promise<boolean>;
  /** Focus ml-ralph pane */
  focusMlRalph: () => Promise<boolean>;
  /** Send keys to terminal */
  sendKeysToTerminal: (keys: string) => Promise<boolean>;
}

export function useTmuxLayout(
  options: UseTmuxLayoutOptions,
): UseTmuxLayoutResult {
  const { cwd, sessionName = "ml-ralph" } = options;

  const [isInTmux, setIsInTmux] = useState(false);
  const [isInitialized, setIsInitialized] = useState(false);
  const [hasTerminalPane, setHasTerminalPane] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const managerRef = useRef<TmuxLayoutManager | null>(null);

  // Initialize on mount
  useEffect(() => {
    const manager = new TmuxLayoutManager({ sessionName, cwd });
    managerRef.current = manager;

    const init = async () => {
      const success = await manager.initialize();
      setIsInTmux(manager.getIsInTmux());
      setIsInitialized(success);
      if (!success && manager.getIsInTmux() === false) {
        setError("Please run ml-ralph inside tmux for the best experience");
      }
    };

    init();

    return () => {
      // Don't clean up - let the terminal pane persist
    };
  }, [sessionName, cwd]);

  const enterPlanningMode = useCallback(async () => {
    if (!managerRef.current) return false;
    const success = await managerRef.current.enterPlanningMode();
    setHasTerminalPane(managerRef.current.hasTerminalPane());
    return success;
  }, []);

  const enterMonitorMode = useCallback(async () => {
    if (!managerRef.current) return false;
    const success = await managerRef.current.enterMonitorMode();
    setHasTerminalPane(managerRef.current.hasTerminalPane());
    return success;
  }, []);

  const focusTerminal = useCallback(async () => {
    if (!managerRef.current) return false;
    return managerRef.current.focusTerminal();
  }, []);

  const focusMlRalph = useCallback(async () => {
    if (!managerRef.current) return false;
    return managerRef.current.focusMlRalph();
  }, []);

  const sendKeysToTerminal = useCallback(async (keys: string) => {
    if (!managerRef.current) return false;
    return managerRef.current.sendKeysToTerminal(keys);
  }, []);

  return {
    isInTmux,
    isInitialized,
    hasTerminalPane,
    error,
    enterPlanningMode,
    enterMonitorMode,
    focusTerminal,
    focusMlRalph,
    sendKeysToTerminal,
  };
}
