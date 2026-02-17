# Architecture

ml-ralph follows a clean layered architecture that separates concerns and enables testability.

## Layer Overview

```
┌─────────────────────────────────────────────────────────────────────────┐
│                              UI Layer                                    │
│                       (OpenTUI/React Components)                         │
│  - Screens (Planning, Monitor)                                          │
│  - Widgets (StoryList, ChatPanel, MetricsChart)                         │
│  - No business logic, just rendering + events                           │
└─────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                          Application Layer                               │
│                           (Orchestration)                                │
│  - AgentOrchestrator (the "brain" - story selection, iteration loop)    │
│  - UIState (what the UI needs to display)                               │
│  - Commands (user actions → state changes)                              │
└─────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                            Domain Layer                                  │
│                         (Business Logic)                                 │
│  - Types (PRD, Story, Learning, Research, etc.)                         │
│  - Validation (is this a valid PRD?)                                    │
│  - Pure functions (selectNextStory, shouldSupersede)                    │
└─────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                         Infrastructure Layer                             │
│                        (External Concerns)                               │
│  - FileStore (read/write .ml-ralph/ files)                              │
│  - ClaudeCodeClient (spawn CC, parse stream)                            │
│  - WandBClient (fetch metrics, runs)                                    │
│  - ProcessManager (spawn/monitor training jobs)                         │
└─────────────────────────────────────────────────────────────────────────┘
```

## Layer Rules

### UI Layer

- **Depends on**: Application layer only
- **Contains**: React/OpenTUI components, hooks for state access
- **Rules**:
  - No business logic
  - No direct infrastructure access
  - Components receive data via props or hooks
  - Events bubble up via callbacks

### Application Layer

- **Depends on**: Domain layer, Infrastructure interfaces
- **Contains**: Orchestrator, state management, command handlers
- **Rules**:
  - Coordinates between UI and infrastructure
  - Owns application state
  - Implements use cases (start agent, create PRD, etc.)

### Domain Layer

- **Depends on**: Nothing (pure)
- **Contains**: Types, validation, pure business logic
- **Rules**:
  - No external dependencies
  - All functions are pure (input → output, no side effects)
  - Types define the ubiquitous language

### Infrastructure Layer

- **Depends on**: Domain types only
- **Contains**: File I/O, Claude Code client, W&B client, process management
- **Rules**:
  - Implements interfaces defined by application layer
  - Handles all external communication
  - Converts external data to domain types

## Dependency Flow

```
UI → Application → Domain ← Infrastructure
                     ↑
                     └──────────────┘
```

- UI depends on Application
- Application depends on Domain and Infrastructure interfaces
- Infrastructure implements interfaces, depends on Domain types
- Domain depends on nothing

## Key Components

### AgentOrchestrator

The "brain" of ml-ralph. Manages the agent loop:

```typescript
interface AgentOrchestrator {
  // State
  status: "idle" | "running" | "paused";
  currentStory: Story | null;

  // Control
  start(): Promise<void>;
  stop(): Promise<void>;

  // Events (for UI)
  onOutput: (callback: (line: string) => void) => void;
  onStoryComplete: (callback: (story: Story) => void) => void;
  onLearning: (callback: (learning: Learning) => void) => void;
}
```

### ClaudeCodeClient

Spawns and communicates with Claude Code:

```typescript
interface ClaudeCodeClient {
  // Streaming execution
  execute(prompt: string): AsyncIterable<StreamEvent>;

  // Cancel running execution
  cancel(): Promise<void>;
}

type StreamEvent =
  | { type: "text"; content: string }
  | { type: "tool_start"; tool: string; input: unknown }
  | { type: "tool_end"; tool: string; output: unknown }
  | { type: "error"; message: string }
  | { type: "done" };
```

### FileStore

Manages .ml-ralph/ directory:

```typescript
interface FileStore {
  // PRD
  readPRD(): Promise<PRD | null>;
  writePRD(prd: PRD): Promise<void>;

  // Progress
  appendProgress(entry: ProgressEntry): Promise<void>;
  readProgress(): Promise<ProgressEntry[]>;

  // Learnings
  appendLearning(learning: Learning): Promise<void>;
  readLearnings(): Promise<Learning[]>;

  // Research
  appendResearch(item: ResearchItem): Promise<void>;
  readResearch(): Promise<ResearchItem[]>;

  // Jobs
  readActiveJobs(): Promise<TrainingJob[]>;
  writeActiveJobs(jobs: TrainingJob[]): Promise<void>;

  // Config
  readConfig(): Promise<ProjectConfig>;
  writeConfig(config: ProjectConfig): Promise<void>;

  // Chat
  readChatSession(id: string): Promise<ChatSession | null>;
  writeChatSession(session: ChatSession): Promise<void>;
}
```

## State Management

Application state is managed centrally and flows down to UI:

```typescript
interface AppState {
  // Mode
  mode: "planning" | "monitor";

  // Data
  prd: PRD | null;
  stories: Story[];
  learnings: Learning[];
  research: ResearchItem[];
  activeJobs: TrainingJob[];

  // Agent
  agentStatus: "idle" | "running" | "paused";
  currentStory: Story | null;
  agentOutput: string[];

  // Chat (planning mode)
  chatMessages: ChatMessage[];

  // UI
  selectedTab: "learnings" | "research" | "stories";
}
```

## Testing Strategy

| Layer          | Test Type   | What to Test                          |
| -------------- | ----------- | ------------------------------------- |
| Domain         | Unit        | All pure functions, type validation   |
| Infrastructure | Integration | File I/O, CC spawning, W&B API        |
| Application    | Integration | Orchestrator flows, state transitions |
| UI             | Snapshot    | Component rendering                   |

## Error Handling

Errors are categorized and handled at appropriate layers:

```typescript
type DomainError =
  | { type: "validation"; field: string; message: string }
  | { type: "invalid_state"; message: string };

type InfrastructureError =
  | { type: "file_not_found"; path: string }
  | { type: "claude_code_error"; message: string }
  | { type: "wandb_error"; message: string }
  | { type: "process_error"; message: string };

type ApplicationError =
  | { type: "agent_error"; message: string }
  | { type: "command_failed"; command: string; reason: string };
```

- Domain errors: Validation failures, invalid business state
- Infrastructure errors: External system failures
- Application errors: Use case failures

UI displays errors appropriately based on type and severity.
