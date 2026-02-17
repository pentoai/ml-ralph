/**
 * Log parser for .ml-ralph/log.jsonl
 * Reads and aggregates events into useful views
 */

import type {
  DecisionEvent,
  ExperimentEvent,
  HypothesisEvent,
  LearningEvent,
  PhaseEvent,
  PRD,
  PrdUpdatedEvent,
  RalphEvent,
  ResearchEvent,
} from "./templates.ts";

export interface HypothesisWithStatus {
  id: string;
  hypothesis: string;
  expected?: string;
  status: "pending" | "keep" | "reject" | "iterate" | "pivot";
  experiments: ExperimentEvent[];
  decision?: DecisionEvent;
  createdAt: string;
}

export interface PrdChange {
  ts: string;
  field: string;
  change: string;
  reason: string;
}

export interface LogSummary {
  hypotheses: HypothesisWithStatus[];
  experiments: ExperimentEvent[];
  learnings: LearningEvent[];
  research: ResearchEvent[];
  prdChanges: PrdChange[];
  currentPhase: string | null;
  phases: PhaseEvent[];
  latestStatus: "running" | "paused" | "complete" | null;
}

/**
 * Parse a single line of JSONL
 */
function parseLine(line: string): RalphEvent | null {
  try {
    const trimmed = line.trim();
    if (!trimmed) return null;
    return JSON.parse(trimmed) as RalphEvent;
  } catch {
    return null;
  }
}

/**
 * Read and parse the log file
 */
export async function readLogFile(projectPath: string): Promise<RalphEvent[]> {
  const logPath = `${projectPath}/.ml-ralph/log.jsonl`;

  try {
    const file = Bun.file(logPath);
    if (!(await file.exists())) {
      return [];
    }

    const content = await file.text();
    const lines = content.split("\n");
    const events: RalphEvent[] = [];

    for (const line of lines) {
      const event = parseLine(line);
      if (event) {
        events.push(event);
      }
    }

    return events;
  } catch {
    return [];
  }
}

/**
 * Read the PRD file
 */
export async function readPrdFile(projectPath: string): Promise<PRD | null> {
  const prdPath = `${projectPath}/.ml-ralph/prd.json`;

  try {
    const file = Bun.file(prdPath);
    if (!(await file.exists())) {
      return null;
    }

    const content = await file.json();
    return content as PRD;
  } catch {
    return null;
  }
}

/**
 * Kanban types for the working plan
 */
export interface KanbanTask {
  id: string;
  title: string;
  why: string;
  expected_outcome?: string;
  phase?: string;
  depends_on?: string;
  notes?: string;
}

export interface CompletedTask extends KanbanTask {
  outcome: string;
  completed_at: string;
}

export interface AbandonedTask extends KanbanTask {
  reason: string;
  abandoned_at: string;
}

export interface Kanban {
  last_updated: string;
  update_reason: string;
  current_focus: KanbanTask | null;
  up_next: KanbanTask[];
  backlog: KanbanTask[];
  completed: CompletedTask[];
  abandoned: AbandonedTask[];
}

/**
 * Read the Kanban file
 */
export async function readKanbanFile(
  projectPath: string,
): Promise<Kanban | null> {
  const kanbanPath = `${projectPath}/.ml-ralph/kanban.json`;

  try {
    const file = Bun.file(kanbanPath);
    if (!(await file.exists())) {
      return null;
    }

    const content = await file.json();
    return content as Kanban;
  } catch {
    return null;
  }
}

/**
 * Aggregate events into a summary for the TUI
 */
export function aggregateEvents(events: RalphEvent[]): LogSummary {
  const hypothesesMap = new Map<string, HypothesisWithStatus>();
  const experiments: ExperimentEvent[] = [];
  const learnings: LearningEvent[] = [];
  const research: ResearchEvent[] = [];
  const prdChanges: PrdChange[] = [];
  const phases: PhaseEvent[] = [];
  let latestStatus: "running" | "paused" | "complete" | null = null;

  for (const event of events) {
    switch (event.type) {
      case "hypothesis": {
        const h = event as HypothesisEvent;
        hypothesesMap.set(h.id, {
          id: h.id,
          hypothesis: h.hypothesis,
          expected: h.expected,
          status: "pending",
          experiments: [],
          createdAt: h.ts,
        });
        break;
      }

      case "experiment": {
        const e = event as ExperimentEvent;
        experiments.push(e);
        const hyp = hypothesesMap.get(e.hypothesis_id);
        if (hyp) {
          hyp.experiments.push(e);
        }
        break;
      }

      case "decision": {
        const d = event as DecisionEvent;
        const hyp = hypothesesMap.get(d.hypothesis_id);
        if (hyp) {
          hyp.status = d.action;
          hyp.decision = d;
        }
        break;
      }

      case "learning": {
        learnings.push(event as LearningEvent);
        break;
      }

      case "research": {
        research.push(event as ResearchEvent);
        break;
      }

      case "prd_updated": {
        const p = event as PrdUpdatedEvent;
        prdChanges.push({
          ts: p.ts,
          field: p.field,
          change: p.change,
          reason: p.reason,
        });
        break;
      }

      case "phase": {
        phases.push(event as PhaseEvent);
        break;
      }

      case "status": {
        latestStatus = (event as { status: "running" | "paused" | "complete" })
          .status;
        break;
      }
    }
  }

  // Convert map to array, sorted by creation time
  const hypotheses = Array.from(hypothesesMap.values()).sort((a, b) =>
    a.createdAt.localeCompare(b.createdAt),
  );

  // Get current phase (latest)
  const lastPhase = phases[phases.length - 1];
  const currentPhase = lastPhase?.phase ?? null;

  return {
    hypotheses,
    experiments,
    learnings,
    research,
    prdChanges,
    currentPhase,
    phases,
    latestStatus,
  };
}

/**
 * Watch the log file for changes and call callback
 */
export function watchLogFile(
  projectPath: string,
  callback: (summary: LogSummary) => void,
): () => void {
  const logPath = `${projectPath}/.ml-ralph/log.jsonl`;
  const watcher: ReturnType<typeof Bun.file.prototype.watch> | null = null;

  const refresh = async () => {
    const events = await readLogFile(projectPath);
    const summary = aggregateEvents(events);
    callback(summary);
  };

  // Initial load
  refresh();

  // Set up file watcher using polling (more reliable across platforms)
  let lastSize = 0;
  const interval = setInterval(async () => {
    try {
      const file = Bun.file(logPath);
      if (await file.exists()) {
        const size = file.size;
        if (size !== lastSize) {
          lastSize = size;
          await refresh();
        }
      }
    } catch {
      // Ignore errors
    }
  }, 1000); // Poll every second

  // Return cleanup function
  return () => {
    clearInterval(interval);
    if (watcher) {
      // Clean up watcher if we add native watching later
    }
  };
}

/**
 * Append an event to the log file
 */
export async function appendEvent(
  projectPath: string,
  event: Omit<RalphEvent, "ts">,
): Promise<boolean> {
  const logPath = `${projectPath}/.ml-ralph/log.jsonl`;

  try {
    const eventWithTs = {
      ts: new Date().toISOString(),
      ...event,
    };

    const line = JSON.stringify(eventWithTs) + "\n";

    // Append to file
    const file = Bun.file(logPath);
    const existing = (await file.exists()) ? await file.text() : "";
    await Bun.write(logPath, existing + line);

    return true;
  } catch {
    return false;
  }
}
