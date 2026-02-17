/**
 * Application state types
 */

import type {
  AgentStatus,
  AppMode,
  ChatMessage,
  Learning,
  PlanningTab,
  PRD,
  ProjectConfig,
  ResearchItem,
  Story,
  TrainingJob,
} from "../../domain/types/index.ts";
import type { StreamEvent } from "../../infrastructure/ralph/index.ts";

export interface AppState {
  // Mode
  mode: AppMode;

  // Project
  projectPath: string | null;
  config: ProjectConfig | null;

  // Data
  prd: PRD | null;
  learnings: Learning[];
  research: ResearchItem[];
  activeJobs: TrainingJob[];

  // Agent
  agentStatus: AgentStatus;
  currentStory: Story | null;
  agentOutput: StreamEvent[];

  // Chat (planning mode)
  chatMessages: ChatMessage[];

  // UI
  selectedTab: PlanningTab;
  inputMode: boolean; // When true, keyboard goes to chat input
  scrollOffset: number; // Scroll offset for knowledge panel
  backlogExpanded: boolean; // Kanban backlog toggle
  backlogOffset: number; // Kanban backlog scroll offset
  completedExpanded: boolean; // Kanban completed toggle
  completedOffset: number; // Kanban completed scroll offset
  abandonedExpanded: boolean; // Kanban abandoned toggle
  abandonedOffset: number; // Kanban abandoned scroll offset

  // Experiments tab
  selectedExperimentId: string | null; // Composite ID of selected experiment
  experimentFlatList: string[]; // Ordered flat list of experiment IDs for navigation
  expandedExperimentId: string | null; // Which experiment is expanded (null = none)

  // Error state
  error: string | null;
}

export interface AppActions {
  // Project
  setProjectPath: (path: string) => void;
  loadProject: () => Promise<void>;
  initializeProject: (name: string) => Promise<void>;

  // Mode
  setMode: (mode: AppMode) => void;
  setSelectedTab: (tab: PlanningTab) => void;
  setInputMode: (active: boolean) => void;
  setScrollOffset: (offset: number) => void;
  scrollUp: () => void;
  scrollDown: () => void;
  setBacklogExpanded: (expanded: boolean) => void;
  setBacklogOffset: (offset: number) => void;
  scrollBacklogUp: () => void;
  scrollBacklogDown: () => void;
  setCompletedExpanded: (expanded: boolean) => void;
  setCompletedOffset: (offset: number) => void;
  scrollCompletedUp: () => void;
  scrollCompletedDown: () => void;
  setAbandonedExpanded: (expanded: boolean) => void;
  setAbandonedOffset: (offset: number) => void;
  scrollAbandonedUp: () => void;
  scrollAbandonedDown: () => void;

  // Experiments
  setSelectedExperimentId: (id: string | null) => void;
  setExperimentFlatList: (list: string[]) => void;
  selectNextExperiment: (flatList: string[]) => void;
  selectPrevExperiment: (flatList: string[]) => void;
  setExpandedExperimentId: (id: string | null) => void;
  toggleExpandedExperiment: (id: string) => void;

  // PRD
  setPRD: (prd: PRD) => void;
  savePRD: () => Promise<void>;

  // Agent
  startAgent: () => Promise<void>;
  stopAgent: () => Promise<void>;
  appendAgentOutput: (event: StreamEvent) => void;
  clearAgentOutput: () => void;
  setCurrentStory: (story: Story | null) => void;
  setAgentStatus: (status: AgentStatus) => void;

  // Chat
  addChatMessage: (message: ChatMessage) => void;
  updateChatMessage: (id: string, updates: Partial<ChatMessage>) => void;
  clearChat: () => void;

  // Data
  addLearning: (learning: Learning) => void;
  addResearch: (item: ResearchItem) => void;
  setActiveJobs: (jobs: TrainingJob[]) => void;
  updateJob: (job: TrainingJob) => void;
  stopTrainingJob: (jobId: string) => Promise<boolean>;

  // Error
  setError: (error: string | null) => void;

  // Refresh
  refreshData: () => Promise<void>;
}

export type AppStore = AppState & AppActions;
