/**
 * Hook for reading Ralph state from .ml-ralph files
 * Watches prd.json, kanban.json, and log.jsonl for changes
 */

import { useCallback, useEffect, useState } from "react";
import {
  aggregateEvents,
  type Kanban,
  type LogSummary,
  type PRD,
  readKanbanFile,
  readLogFile,
  readPrdFile,
} from "../../infrastructure/ralph/index.ts";

export interface UseRalphStateOptions {
  projectPath: string;
  /** Polling interval in ms (default: 1000) */
  pollInterval?: number;
}

export interface UseRalphStateResult {
  /** The current PRD */
  prd: PRD | null;
  /** Aggregated log data */
  log: LogSummary | null;
  /** The current Kanban (working plan) */
  kanban: Kanban | null;
  /** Whether initial load is complete */
  isLoaded: boolean;
  /** Any error that occurred */
  error: string | null;
  /** Manually refresh the data */
  refresh: () => Promise<void>;
}

export function useRalphState(
  options: UseRalphStateOptions,
): UseRalphStateResult {
  const { projectPath, pollInterval = 1000 } = options;

  const [prd, setPrd] = useState<PRD | null>(null);
  const [log, setLog] = useState<LogSummary | null>(null);
  const [kanban, setKanban] = useState<Kanban | null>(null);
  const [isLoaded, setIsLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      // Read PRD
      const prdData = await readPrdFile(projectPath);
      setPrd(prdData);

      // Read and aggregate log
      const events = await readLogFile(projectPath);
      const summary = aggregateEvents(events);
      setLog(summary);

      // Read Kanban
      const kanbanData = await readKanbanFile(projectPath);
      setKanban(kanbanData);

      setError(null);
      setIsLoaded(true);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Failed to read Ralph state",
      );
    }
  }, [projectPath]);

  // Initial load
  useEffect(() => {
    refresh();
  }, [refresh]);

  // Set up polling for file changes
  useEffect(() => {
    const interval = setInterval(() => {
      refresh();
    }, pollInterval);

    return () => clearInterval(interval);
  }, [refresh, pollInterval]);

  return {
    prd,
    log,
    kanban,
    isLoaded,
    error,
    refresh,
  };
}
