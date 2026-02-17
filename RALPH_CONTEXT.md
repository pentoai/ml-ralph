# Ralph Project Context

## Overview

**Ralph** is an autonomous ML engineering agent designed to help teams iterate on machine learning projects by automating the experiment loop and accumulating knowledge. It works like an experienced Machine Learning Engineer, reasoning carefully, documenting decisions, and respecting user guidance.

The project consists of two complementary components:

1. **ml-ralph** (TypeScript/Bun) - Terminal User Interface
2. **ml-ralph-agent** (Python) - Core agent logic and cognitive loop

---

## ml-ralph (This Repository) - Terminal User Interface

### Purpose

A terminal user interface (TUI) built with Ink (React for terminals) that provides two interaction modes for working with the Ralph agent.

### Tech Stack

- **Runtime**: Bun
- **TUI Framework**: Ink (React for terminals)
- **Language**: TypeScript
- **State Management**: Zustand
- **Agent Integration**: Claude Code (via subprocess)
- **Experiment Tracking**: Weights & Biases (W&B)
- **Markdown Rendering**: ink-markdown

### Architecture

Ralph follows a clean layered architecture:

```
┌─────────────────────────────────────────────────────────┐
│                     UI Layer                            │
│   (Ink/React Components - Planning & Monitor screens)   │
├─────────────────────────────────────────────────────────┤
│                  Application Layer                      │
│   (AgentOrchestrator, UIState, Commands)               │
├─────────────────────────────────────────────────────────┤
│                    Domain Layer                         │
│   (Pure types, validation, story selection logic)      │
├─────────────────────────────────────────────────────────┤
│                Infrastructure Layer                     │
│   (FileStore, ClaudeCodeClient, WandBClient, Process)  │
└─────────────────────────────────────────────────────────┘
```

#### Layers Explained

1. **UI Layer** (`src/ui/`)
   - Planning and Monitor screens
   - Widgets: chat panel, metrics, learnings, research, stories
   - All state flows down via props/hooks

2. **Application Layer** (`src/application/`)
   - `AgentOrchestrator`: The "brain" that manages the agent loop and story selection
   - `UIState`: Manages what the UI needs to display
   - Commands: Handle user actions and state transitions

3. **Domain Layer** (`src/domain/`)
   - Pure types and validation
   - Story selection logic
   - No external dependencies

4. **Infrastructure Layer** (`src/infrastructure/`)
   - `FileStore`: Read/write `.ml-ralph/` configuration files
   - `ClaudeCodeClient`: Spawn and communicate with Claude Code
   - `WandBClient`: Fetch metrics from Weights & Biases
   - `ProcessManager`: Manage training jobs

### Two UI Modes

#### Planning Mode

- Chat with Claude Code to create or refine your PRD
- View accumulated learnings from past iterations
- Review research the agent has gathered
- See your story backlog and prioritize work

#### Monitor Mode

- Watch the agent execute stories in real-time
- View experiment metrics and training curves via W&B
- See current story and hypothesis being tested
- Control the agent (start/stop) and training jobs

### Keyboard Shortcuts

| Key            | Action                                    |
| -------------- | ----------------------------------------- |
| `Tab`          | Switch between Planning and Monitor modes |
| `1/2/3`        | Switch tabs in Planning mode              |
| `i` or `Enter` | Enter chat input mode                     |
| `Esc`          | Exit input mode / dismiss errors          |
| `s`            | Start/Stop agent                          |
| `t`            | Stop training job (Monitor mode)          |
| `w`            | Open W&B dashboard                        |
| `q`            | Quit                                      |

### File Structure

```
src/
├── ui/
│   ├── app.tsx              # Main app component
│   ├── screens/
│   │   ├── planning.tsx     # Planning mode screen
│   │   └── monitor.tsx      # Monitor mode screen
│   ├── widgets/
│   │   ├── chat-panel.tsx   # Claude Code chat interface
│   │   ├── learnings.tsx    # Learnings display
│   │   ├── research.tsx     # Research findings
│   │   ├── stories.tsx      # Story backlog
│   │   └── metrics.tsx      # W&B metrics display
│   └── hooks/
│       └── index.ts         # React hooks
├── application/
│   └── orchestrator/
│       ├── orchestrator.ts  # Agent orchestration logic
│       └── types.ts         # Orchestrator types
├── domain/
│   └── types.ts             # Core domain types
└── infrastructure/
    ├── file-store/          # File system operations
    ├── wandb/               # W&B integration
    └── process/             # Process management
```

---

## ml-ralph-agent (Python Package)

### Purpose

The core agent logic that runs through a structured cognitive loop, integrating with Claude Code or Codex CLIs.

**Repository**: `github.com/pentoai/ML-Ralph`
**Package**: `pip install ml-ralph` or `uv tool install ml-ralph`
**Version**: 0.3.0

### Tech Stack

- **CLI Framework**: Typer
- **Terminal Output**: Rich
- **Python**: 3.10+
- **Integration**: Claude/Codex CLI via subprocess streaming

### CLI Commands

#### `ml-ralph init`

Initialize Ralph in a project:

- Creates `.ml-ralph/` directory structure
- Sets up templates (RALPH.md, prd.json placeholders)
- Installs skills for Claude Code and Codex CLIs
- Copies configuration files to project root

#### `ml-ralph run`

Execute the autonomous loop:

- Runs up to N iterations (default: 100)
- Integrates with Claude Code CLI via streaming JSON protocol
- Displays tool invocations and progress in real-time
- Automatically handles exit conditions

### The 7-Phase Cognitive Loop

Ralph works through a structured cycle, looping from DECIDE back to HYPOTHESIZE:

```
ORIENT → RESEARCH → HYPOTHESIZE → EXECUTE → ANALYZE → VALIDATE → DECIDE
                         ↑                                         │
                         └─────────────────────────────────────────┘
```

#### Phase Definitions

1. **ORIENT** - Understand the problem, constraints, failure modes
2. **RESEARCH** - Learn from existing knowledge, find SOTA approaches
3. **HYPOTHESIZE** - Form testable bets with expected outcomes
4. **EXECUTE** - Implement minimal changes, run experiments
5. **ANALYZE** - Examine results, find failure patterns
6. **VALIDATE** - Check for leakage, ensure results are trustworthy
7. **DECIDE** - Keep/revert/pivot, update PRD based on evidence

### Two Operational Modes

#### SETUP Mode (Interactive PRD Creation)

- Triggered when no `prd.json` exists
- Agent asks clarifying questions one at a time
- User provides ML problem context
- Agent writes `.ml-ralph/prd.json` when ready
- Status transitions to "approved" when user says `/start`

#### EXECUTION Mode (Autonomous Loop)

- Triggered when `prd.json` exists with `status: "approved"`
- Agent works autonomously through cognitive loop
- Each iteration: reads state files, executes one phase, updates logs
- Checks `inbox.json` for user commands each iteration
- Updates PRD based on evidence (refinement)
- Stops when all success criteria are met → outputs `<promise>COMPLETE</promise>`

### MLE Mindset (Core Principles)

- **Evidence over intuition** - Log what you observed, not what you expected
- **One hypothesis at a time** - No simultaneous testing
- **Minimal changes** - Smallest experiment to test hypothesis
- **Skepticism** - Metrics suspicious until proven trustworthy
- **Error-driven** - Find patterns in failures

### User Control via Inbox

Commands written to `inbox.json`:

- `hint` - Provide guidance without stopping
- `pause` - Pause execution
- `resume` - Resume execution
- `redirect` - Change direction

---

## Core Data Models

### PRD (Product Requirements Document)

```typescript
interface PRD {
  projectName: string;
  description: string;
  goals: string[];
  successCriteria: SuccessCriterion[];
  constraints: string[];
  scope: {
    inScope: string[];
    outOfScope: string[];
  };
  dataSources: DataSource[];
  evaluationStrategy: EvaluationStrategy;
  stories: Story[];
  status: "draft" | "approved" | "completed";
}
```

### Story

```typescript
interface Story {
  id: string;
  type: "discovery" | "experiment" | "evaluation" | "implementation" | "ops";
  title: string;
  description: string;
  hypothesis?: string; // Format: "If X, then Y because Z"
  state: "pending" | "in_progress" | "done" | "superseded";
  createdAt: string;
  completedAt?: string;
}
```

### Learning

```typescript
interface Learning {
  id: string;
  insight: string;
  implications: string[];
  category:
    | "data"
    | "model"
    | "evaluation"
    | "infrastructure"
    | "domain"
    | "process";
  impact: "high" | "medium" | "low";
  confidence: "proven" | "likely" | "speculative";
  sourceStory?: string;
  sourceExperiment?: string;
  wandbRunId?: string;
  createdAt: string;
}
```

### Progress Log Entry

```typescript
interface ProgressEntry {
  iteration: number;
  phase: string;
  hypothesis: string;
  assumptions: string[];
  changes: string[];
  metrics: {
    baseline: Record<string, number>;
    result: Record<string, number>;
  };
  decision: "keep" | "revert" | "investigate";
  evidence: {
    wandbArtifacts?: string[];
    logs?: string[];
    commits?: string[];
  };
  timestamp: string;
}
```

### Research

```typescript
interface Research {
  id: string;
  type:
    | "paper"
    | "documentation"
    | "tutorial"
    | "stackoverflow"
    | "blog"
    | "repo";
  title: string;
  url?: string;
  summary: string;
  keyTakeaways: string[];
  codeSnippets?: string[];
  relatedStories: string[];
  createdAt: string;
}
```

### Training Job

```typescript
interface TrainingJob {
  id: string;
  pid: number;
  command: string;
  logPath: string;
  wandbRunId?: string;
  wandbUrl?: string;
  status: "running" | "completed" | "failed" | "stopped";
  startedAt: string;
  endedAt?: string;
}
```

---

## State Files (`.ml-ralph/` Directory)

| File                     | Format | Purpose                                           |
| ------------------------ | ------ | ------------------------------------------------- |
| `config.json`            | JSON   | Project configuration                             |
| `prd.json`               | JSON   | Current PRD (the contract)                        |
| `ralph.json`             | JSON   | Current execution state (phase, iteration, stats) |
| `backlog.json`           | JSON   | Queue of hypotheses to test                       |
| `learnings.jsonl`        | JSONL  | Extracted insights (one per line)                 |
| `research.jsonl`         | JSONL  | Research findings                                 |
| `progress.jsonl`         | JSONL  | Iteration logs (thinking log)                     |
| `chat.jsonl`             | JSONL  | Conversation history                              |
| `inbox.json`             | JSON   | User commands (hint, pause, redirect, resume)     |
| `runs/active.json`       | JSON   | Currently running training jobs                   |
| `runs/history.jsonl`     | JSONL  | Completed training jobs                           |
| `chat/prd-session.jsonl` | JSONL  | PRD chat session history                          |

---

## Workflow

1. **Initialize**: `ml-ralph init` creates `.ml-ralph/` directory with config
2. **Plan**: Chat with Claude Code in Planning Mode to refine your PRD
3. **Execute**: Agent autonomously works through stories, runs experiments
4. **Monitor**: Watch execution in Monitor Mode, see metrics and learnings
5. **Learn**: Accumulated insights inform next iteration's decisions

---

## Long-Running Job Support

Ralph handles training jobs that outlast individual iterations:

- Detach processes via `nohup`, `setsid`, or `tmux`
- Track via `outputs/logs/active_runs.json` with PID, log path, W&B URL
- Next iterations enter "monitoring mode" to observe and decide
- Jobs survive agent exit/iteration boundaries

---

## Integration Points

### Claude Code Integration

- Spawned as subprocess with `--output-format stream-json`
- Restricted tools: `Bash`, `Read`, `Write`, `Edit`, `Glob`, `Grep`
- Real-time streaming of tool invocations and responses

### Weights & Biases Integration

- Fetch experiment metrics
- Display training curves
- Link runs to stories and learnings
- Open dashboard via keyboard shortcut

---

## Default Tooling (Agent Instructions)

When Ralph runs experiments, it defaults to:

- `uv` - Package management
- `ruff` - Linting & formatting
- `wandb` - Experiment tracking
- `pydantic` - Data models
- `loguru` - Logging
- `typer` - CLI building

---

## Key Files Reference

### In ml-ralph (TypeScript TUI)

- `src/ui/app.tsx` - Main application entry
- `src/ui/screens/planning.tsx` - Planning mode screen
- `src/application/orchestrator/orchestrator.ts` - Agent orchestration
- `package.json` - Dependencies and scripts

### In ml-ralph-agent (Python)

- `ml_ralph/cli.py` - CLI entry points
- `ml_ralph/runner.py` - Agent execution loop
- `templates/RALPH.md` - Full agent instructions
- `templates/CLAUDE.md` - Project instructions template
