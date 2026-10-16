# File Layout

Directory structure for ml-ralph projects and the TUI codebase.

## Project Directory (.ml-ralph/)

When ml-ralph is initialized in a project (`ml-ralph init` or the TUI's first launch), it creates:

```
your-ml-project/
├── CLAUDE.md                     # Agent instructions (kept if it already exists)
├── AGENTS.md                     # Agent instructions (kept if it already exists)
├── .claude/skills/ml-ralph/
│   └── SKILL.md                  # ml-ralph skill for Claude
├── .codex/skills/ml-ralph/
│   └── SKILL.md                  # ml-ralph skill for Codex
├── .ml-ralph/                    # ml-ralph data directory
│   ├── RALPH.md                  # Agent prompt
│   ├── config.json               # Project configuration
│   ├── prd.json                  # PRD and stories
│   ├── kanban.json               # Experiment kanban
│   ├── log.jsonl                 # Agent event log (append-only)
│   ├── progress.jsonl            # Iteration log (append-only)
│   ├── learnings.jsonl           # Accumulated learnings (append-only)
│   ├── research.jsonl            # Research items (append-only)
│   ├── evals/
│   │   └── <eval_id>/metrics.json    # Runner-written scores from `ml-ralph eval` (see DATA_MODELS.md)
│   ├── eval/
│   │   ├── evaluate.py           # Eval script (drafted in SETUP, locked on PRD approval)
│   │   ├── contract.json         # Eval contract (see DATA_MODELS.md)
│   │   └── lock.json             # SHA-256 lock written by the runner
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

Re-running init never overwrites existing files. With `--force` only the templates (`RALPH.md`, `CLAUDE.md`, `AGENTS.md`, the skills) are overwritten; the log, PRD, kanban, config and runs are created only if missing.

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

### `.ml-ralph/eval/`

The eval contract. In SETUP the agent drafts `evaluate.py` and `contract.json` with the user and records the baseline score in the contract. Once `prd.json` has `status: "approved"`, the runner validates the contract and, if `evaluate.py` exists, writes `lock.json`:

```json
{
  "locked_at": "2026-01-26T10:45:00.000Z",
  "files": {
    "evaluate.py": "<sha256 hex>",
    "contract.json": "<sha256 hex>"
  }
}
```

Locking fails, with an error naming the file or field, when `contract.json` is missing or invalid, `baseline_score` is missing, or `evaluate.py` does not exist. Only a draft or missing PRD counts as SETUP; any other status (including `blocked`) needs a valid lock. An existing `lock.json` must be well-formed and still cover a valid contract and an existing `evaluate.py`. The runner writes `.ml-ralph/eval-lock.created` when it creates the lock; if `lock.json` later disappears the runner refuses instead of silently locking the current files again (remove the marker to re-lock deliberately). The runner refuses to start an iteration without a usable lock and the TUI shows the reason. The holdout data location is deliberately not part of the contract. Before each iteration the runner also re-hashes the two files against the lock and pauses on any difference (see the tamper check in `ARCHITECTURE.md`); a draft PRD does not switch this off once a lock or the marker exists.

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
│   ├── domain/                      # Pure types & validation (NO deps)
│   │   ├── types/                   # PRD, Story, Learning, Research, Job, Kanban, Config, Chat, enums
│   │   └── validation/              # validatePRD, validateLearning, validateEvalContract
│   │
│   ├── infrastructure/              # External integrations
│   │   ├── ralph/
│   │   │   ├── runner.ts            # RalphRunner: spawns claude per iteration, parses stream-json
│   │   │   ├── init.ts              # initRalph / ensureInitialized
│   │   │   ├── eval-lock.ts         # Lock .ml-ralph/eval/ by hash; gate iterations on the lock
│   │   │   ├── log-parser.ts        # Read/watch log.jsonl, prd.json, kanban.json
│   │   │   ├── templates.ts         # Agent prompts and log event types
│   │   │   └── index.ts
│   │   ├── tmux/                    # TmuxManager, TmuxLayoutManager
│   │   └── file-store/              # JsonFileStore (config.json, runs/, JSONL files)
│   │
│   ├── application/                 # Orchestration layer
│   │   ├── orchestrator/            # DefaultOrchestrator (wraps RalphRunner)
│   │   └── state/                   # zustand store
│   │
│   └── ui/                          # OpenTUI components
│       ├── app.tsx                  # Root component
│       ├── ink.tsx                  # Ink-compatible Box/Text/useInput on OpenTUI
│       ├── screens/                 # planning, monitor, output
│       ├── widgets/                 # knowledge panel, kanban, hypotheses, experiments, activity feed, ...
│       ├── hooks/                   # use-log-stream, use-ralph-state, use-tmux-layout, use-tmux-pane, ...
│       └── theme/colors.ts          # Color definitions
│
│   Tests are colocated as `*.test.ts` next to the code they test.
```

## Naming Conventions

### Files

- **Types**: `{entity}.ts` in domain/types/
- **Interfaces**: Named `{Entity}` (PascalCase)
- **Components**: `{widget-name}.tsx` (kebab-case files, PascalCase exports)
- **Hooks**: `use-{name}.ts` (kebab-case)
- **Tests**: `{module}.test.ts` colocated with the module

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
