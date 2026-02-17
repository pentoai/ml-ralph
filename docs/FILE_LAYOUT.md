# File Layout

Directory structure for ml-ralph projects and the TUI codebase.

## Project Directory (.ml-ralph/)

When ml-ralph is initialized in a project, it creates:

```
your-ml-project/
├── .ml-ralph/                    # ml-ralph data directory
│   ├── config.json               # Project configuration
│   ├── prd.json                  # PRD and stories
│   ├── progress.jsonl            # Iteration log (append-only)
│   ├── learnings.jsonl           # Accumulated learnings (append-only)
│   ├── research.jsonl            # Research items (append-only)
│   ├── chat/
│   │   └── prd-session.jsonl     # PRD creation chat history
│   └── runs/
│       ├── active.json           # Currently running training jobs
│       └── history.jsonl         # Completed training jobs
├── outputs/                      # Training outputs (standard ML convention)
│   ├── logs/
│   │   └── *.log                 # Training log files
│   ├── models/
│   │   └── *.pkl, *.pt, etc.     # Saved models
│   └── artifacts/
│       └── *.png, *.csv, etc.    # Plots, reports, etc.
└── ... (your ML project files)
```

## File Descriptions

### `.ml-ralph/config.json`

Project configuration. Created on `ml-ralph init`.

```json
{
  "name": "my-ml-project",
  "createdAt": "2026-01-26T10:00:00Z",
  "wandb": {
    "project": "my-ml-project"
  },
  "agent": {
    "autoAdvance": true
  },
  "runtime": {
    "packageManager": "uv"
  }
}
```

### `.ml-ralph/prd.json`

Product Requirements Document. Created via PRD chat.

### `.ml-ralph/progress.jsonl`

Iteration log. One JSON object per line, append-only.

```jsonl
{"id":"P-001","timestamp":"2026-01-26T10:30:00Z","storyId":"US-001",...}
{"id":"P-002","timestamp":"2026-01-26T11:15:00Z","storyId":"US-001",...}
```

### `.ml-ralph/learnings.jsonl`

Accumulated learnings. One JSON object per line, append-only.

### `.ml-ralph/research.jsonl`

Research items. One JSON object per line, append-only.

### `.ml-ralph/chat/prd-session.jsonl`

PRD creation conversation. One message per line, append-only.

### `.ml-ralph/runs/active.json`

Currently running training jobs. Array of `TrainingJob` objects.

```json
[
  {
    "id": "job_20260126_103000",
    "storyId": "US-003",
    "status": "running",
    ...
  }
]
```

### `.ml-ralph/runs/history.jsonl`

Completed training jobs. One JSON object per line, append-only.

---

## TUI Codebase Structure

```
ml-ralph/
├── package.json
├── tsconfig.json
├── bun.lockb
├── README.md
│
├── docs/                            # Documentation
│   ├── ARCHITECTURE.md
│   ├── DATA_MODELS.md
│   ├── FILE_LAYOUT.md               # This file
│   ├── PROMPTS.md
│   └── MVP_PLAN.md
│
├── src/
│   ├── index.tsx                    # Entry point
│   │
│   ├── domain/                      # Pure types & logic (NO deps)
│   │   ├── types/
│   │   │   ├── prd.ts               # PRD, Story, SuccessCriterion, DataSource
│   │   │   ├── learning.ts          # Learning
│   │   │   ├── research.ts          # ResearchItem, CodeSnippet
│   │   │   ├── progress.ts          # ProgressEntry, Evidence, BacklogChange
│   │   │   ├── job.ts               # TrainingJob
│   │   │   ├── config.ts            # ProjectConfig
│   │   │   ├── chat.ts              # ChatSession, ChatMessage, ToolCall
│   │   │   ├── enums.ts             # All enum types
│   │   │   └── index.ts             # Re-exports all types
│   │   │
│   │   ├── validation/
│   │   │   ├── prd.ts               # validatePRD, validateStory
│   │   │   ├── learning.ts          # validateLearning
│   │   │   └── index.ts
│   │   │
│   │   └── logic/
│   │       ├── story-selector.ts    # selectNextStory(stories) => Story | null
│   │       ├── id-generator.ts      # generateStoryId, generateLearningId, etc.
│   │       └── index.ts
│   │
│   ├── infrastructure/              # External integrations
│   │   ├── file-store/
│   │   │   ├── types.ts             # FileStore interface
│   │   │   ├── json-file-store.ts   # Implementation
│   │   │   └── index.ts
│   │   │
│   │   ├── claude/
│   │   │   ├── types.ts             # ClaudeCodeClient interface, StreamEvent
│   │   │   ├── client.ts            # Implementation (spawn + stream)
│   │   │   ├── stream-parser.ts     # Parse CC JSON stream
│   │   │   └── index.ts
│   │   │
│   │   ├── wandb/
│   │   │   ├── types.ts             # WandBClient interface
│   │   │   ├── client.ts            # Implementation
│   │   │   └── index.ts
│   │   │
│   │   ├── process/
│   │   │   ├── types.ts             # JobManager interface
│   │   │   ├── job-manager.ts       # Implementation
│   │   │   └── index.ts
│   │   │
│   │   └── prompts/
│   │       ├── story-execution.ts   # System prompt for story execution
│   │       ├── prd-creation.ts      # System prompt for PRD creation
│   │       └── index.ts
│   │
│   ├── application/                 # Orchestration layer
│   │   ├── orchestrator/
│   │   │   ├── types.ts             # AgentOrchestrator interface
│   │   │   ├── orchestrator.ts      # Implementation
│   │   │   └── index.ts
│   │   │
│   │   ├── state/
│   │   │   ├── types.ts             # AppState interface
│   │   │   ├── store.ts             # State management
│   │   │   └── index.ts
│   │   │
│   │   └── commands/
│   │       ├── start-agent.ts
│   │       ├── stop-agent.ts
│   │       ├── create-prd.ts
│   │       └── index.ts
│   │
│   └── ui/                          # OpenTUI components
│       ├── app.tsx                  # Root component
│       │
│       ├── screens/
│       │   ├── planning.tsx         # Planning mode screen
│       │   └── monitor.tsx          # Monitor mode screen
│       │
│       ├── widgets/
│       │   ├── chat-panel.tsx       # CC chat interface
│       │   ├── story-list.tsx       # Story backlog list
│       │   ├── agent-output.tsx     # Agent streaming output
│       │   ├── metrics-chart.tsx    # Experiment metrics display
│       │   ├── learnings-panel.tsx  # Learnings list
│       │   ├── research-panel.tsx   # Research items list
│       │   ├── current-task.tsx     # Current story/hypothesis
│       │   ├── status-bar.tsx       # Bottom status bar
│       │   └── tabs.tsx             # Tab navigation
│       │
│       ├── hooks/
│       │   ├── use-orchestrator.ts  # Access orchestrator
│       │   ├── use-state.ts         # Access app state
│       │   └── use-file-watch.ts    # Watch file changes
│       │
│       └── theme/
│           └── colors.ts            # Color definitions
│
└── tests/
    ├── domain/                      # Unit tests (fast)
    │   ├── validation/
    │   └── logic/
    │
    ├── infrastructure/              # Integration tests
    │   ├── file-store/
    │   ├── claude/
    │   └── wandb/
    │
    └── e2e/                         # End-to-end tests
        └── flows/
```

## Naming Conventions

### Files

- **Types**: `{entity}.ts` in domain/types/
- **Interfaces**: Named `{Entity}` (PascalCase)
- **Components**: `{widget-name}.tsx` (kebab-case files, PascalCase exports)
- **Hooks**: `use-{name}.ts` (kebab-case)
- **Tests**: `{module}.test.ts` colocated or in tests/

### Directories

- All lowercase, kebab-case
- Group by architectural layer first, then by feature

### Exports

- Each directory has `index.ts` for clean imports
- Prefer named exports over default exports

## Import Rules

```typescript
// ✅ Good: Import from layer index
import { Story, PRD } from "../domain/types";
import { FileStore } from "../infrastructure/file-store";
import { useOrchestrator } from "../ui/hooks";

// ❌ Bad: Deep imports
import { Story } from "../domain/types/prd";
import { JsonFileStore } from "../infrastructure/file-store/json-file-store";
```

## Gitignore Recommendations

For user ML projects:

```gitignore
# ml-ralph
.ml-ralph/chat/           # Chat history (optional to commit)
.ml-ralph/runs/           # Training job state

# Keep these
# .ml-ralph/config.json   # Project config
# .ml-ralph/prd.json      # PRD
# .ml-ralph/learnings.jsonl  # Learnings (valuable to keep)
# .ml-ralph/research.jsonl   # Research (valuable to keep)
# .ml-ralph/progress.jsonl   # Progress log (valuable to keep)
```
