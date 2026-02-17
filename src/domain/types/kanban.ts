/**
 * Kanban types - the working plan that evolves each iteration
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

export function createEmptyKanban(): Kanban {
  return {
    last_updated: "",
    update_reason: "",
    current_focus: null,
    up_next: [],
    backlog: [],
    completed: [],
    abandoned: [],
  };
}
