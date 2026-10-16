# Data Models

Complete type definitions for all ml-ralph entities.

## Table of Contents

- [PRD & Stories](#prd--stories)
- [Learnings](#learnings)
- [Research](#research)
- [Progress](#progress)
- [Training Jobs](#training-jobs)
- [Project Config](#project-config)
- [Eval Contract](#eval-contract)
- [Log Events](#log-events)
- [Chat](#chat)
- [Enums](#enums)

---

## PRD & Stories

The Product Requirements Document defines the ML project.

```typescript
interface PRD {
  // Identity
  project: string; // Project name
  description: string; // What this project is about
  createdAt: string; // ISO timestamp
  updatedAt: string; // ISO timestamp

  // Goals
  goal: string; // Primary objective
  successCriteria: SuccessCriterion[];

  // Boundaries
  constraints: string[]; // Technical/business constraints
  scope: {
    inScope: string[];
    outOfScope: string[];
  };

  // Data
  dataSources: DataSource[];

  // Evaluation
  evaluation: {
    metric: string; // Primary metric (e.g., "AUC-ROC")
    validationStrategy: string; // e.g., "5-fold CV", "temporal split"
    testSet?: string; // Hold-out test set description
  };

  // Work
  stories: Story[];
}

interface SuccessCriterion {
  id: string;
  description: string;
  priority: "must" | "should" | "nice";
  validation: string; // How to verify this is met
}

interface DataSource {
  name: string;
  path?: string;
  description: string;
  details?: Record<string, unknown>;
}

interface Story {
  id: string; // "US-001"
  title: string;
  description: string;
  hypothesis: string; // "If X, then Y because Z"
  type: StoryType;
  status: StoryStatus;
  supersededBy?: string; // Story ID that replaced this
  createdAt: string;
  completedAt?: string;
}

type StoryType =
  | "discovery" // EDA, data understanding
  | "experiment" // Model/feature experiments
  | "evaluation" // Validation, error analysis
  | "implementation" // Production code, refactoring
  | "ops"; // Infrastructure, tooling

type StoryStatus =
  | "pending" // Not started
  | "in_progress" // Currently being worked on
  | "done" // Completed successfully
  | "superseded"; // Replaced by another story
```

**File**: `.ml-ralph/prd.json`

---

## Learnings

Structured insights extracted from iterations.

```typescript
interface Learning {
  id: string; // "L-001"
  timestamp: string; // ISO timestamp

  // Core content (top-level visibility)
  insight: string; // The learning (1-2 sentences)
  implications: string[]; // What to do differently

  // Extended content
  details?: string; // Longer explanation

  // Categorization
  category: LearningCategory;
  tags: string[]; // Freeform tags for search

  // Provenance
  source: {
    storyId: string; // Which story
    experimentId?: string; // Which experiment
    wandbRunId?: string; // W&B run ID
    evidence: string; // What proved this
  };

  // Assessment
  impact: "high" | "medium" | "low";
  confidence: "proven" | "likely" | "speculative";

  // Connections
  appliesTo?: string[]; // Story IDs this affects
}

type LearningCategory =
  | "data" // Data quality, distribution, leakage
  | "model" // Architecture, hyperparameters
  | "evaluation" // Metrics, validation strategy
  | "infrastructure" // Training, deployment, performance
  | "domain" // Business/domain-specific insights
  | "process"; // ML workflow, tooling, methodology
```

**File**: `.ml-ralph/learnings.jsonl` (one JSON object per line)

### Example

```json
{
  "id": "L-001",
  "timestamp": "2026-01-26T10:30:00Z",
  "insight": "Target variable has 23% label noise due to inconsistent annotation",
  "implications": [
    "Need label cleaning before final model training",
    "Consider noise-robust loss functions",
    "Adjust success criteria to account for noise ceiling"
  ],
  "category": "data",
  "tags": ["label-quality", "noise", "annotation"],
  "source": {
    "storyId": "US-003",
    "experimentId": "exp-007",
    "evidence": "Manual review of 100 misclassified samples showed 23 had incorrect ground truth"
  },
  "impact": "high",
  "confidence": "proven",
  "appliesTo": ["US-005", "US-006"]
}
```

---

## Research

Information gathered by the agent via web search.

```typescript
interface ResearchItem {
  id: string; // "R-001"
  timestamp: string; // ISO timestamp

  // What was found
  title: string;
  summary: string; // Agent's summary
  url?: string; // Source URL

  // Categorization
  type: ResearchType;
  tags: string[];

  // Context
  relevance: string; // Why this matters
  storyId?: string; // Which story triggered this

  // Extracted content
  keyTakeaways: string[]; // Bullet points
  codeSnippets?: CodeSnippet[]; // Useful code
}

type ResearchType =
  | "paper" // Academic paper
  | "documentation" // Library/framework docs
  | "tutorial" // How-to guide
  | "stackoverflow" // Q&A
  | "blog" // Blog post
  | "repository" // GitHub repo
  | "other";

interface CodeSnippet {
  language: string;
  code: string;
  description: string;
}
```

**File**: `.ml-ralph/research.jsonl` (one JSON object per line)

### Example

```json
{
  "id": "R-001",
  "timestamp": "2026-01-26T09:15:00Z",
  "title": "XGBoost Documentation: Handling Imbalanced Datasets",
  "summary": "Official XGBoost guide on scale_pos_weight parameter and custom objectives for imbalanced classification",
  "url": "https://xgboost.readthedocs.io/en/latest/tutorials/param_tuning.html",
  "type": "documentation",
  "tags": ["xgboost", "imbalanced", "class-weights"],
  "relevance": "Our dataset has 10:1 class imbalance, need to handle this properly",
  "storyId": "US-002",
  "keyTakeaways": [
    "Use scale_pos_weight = sum(negative) / sum(positive)",
    "Alternative: custom objective with focal loss",
    "eval_metric should be AUC, not accuracy for imbalanced data"
  ],
  "codeSnippets": [
    {
      "language": "python",
      "code": "params = {'scale_pos_weight': (len(y) - sum(y)) / sum(y)}",
      "description": "Calculate scale_pos_weight for binary classification"
    }
  ]
}
```

---

## Progress

Log of each iteration's work.

```typescript
interface ProgressEntry {
  id: string; // "P-001"
  timestamp: string; // ISO timestamp
  storyId: string;
  storyTitle: string;
  type: StoryType;

  // What was tried
  hypothesis: string;
  assumptions: string[];
  changes: string[]; // What code/config changed

  // Results
  evaluation: {
    datasetSplit: string; // e.g., "train/val 80/20"
    metric: string; // Primary metric name
    baseline: string; // Baseline value
    result: string; // Achieved value
    variance?: string; // Stability info
  };

  // Evidence
  evidence: Evidence[];

  // Decision
  decision: "keep" | "revert" | "investigate";
  reasoning: string;
  nextStep: string;

  // Backlog updates (if any)
  backlogChanges?: BacklogChange[];
}

interface Evidence {
  type: "wandb" | "artifact" | "log" | "commit" | "other";
  description: string;
  reference: string; // URL, path, or ID
}

interface BacklogChange {
  change: string; // What changed
  reason: string; // Why
}
```

**File**: `.ml-ralph/progress.jsonl` (one JSON object per line)

---

## Training Jobs

Long-running training processes.

```typescript
interface TrainingJob {
  id: string; // "job_20260126_103000"
  storyId: string;
  experimentId: string;

  // Process
  pid: number;
  command: string; // What was executed
  logPath: string; // Path to log file

  // Tracking
  wandbRunId?: string;
  wandbUrl?: string;

  // Timing
  startedAt: string;
  completedAt?: string;

  // Status
  status: JobStatus;
  exitCode?: number;
  error?: string;

  // Cached metrics (from W&B)
  latestMetrics?: {
    epoch?: number;
    step?: number;
    [key: string]: number | undefined;
  };
  lastMetricsUpdate?: string;
}

type JobStatus = "running" | "completed" | "failed" | "stopped"; // Manually stopped
```

**File**: `.ml-ralph/runs/active.json` (array of active jobs)
**File**: `.ml-ralph/runs/history.jsonl` (completed jobs)

---

## Project Config

Project-level settings.

```typescript
interface ProjectConfig {
  // Identity
  name: string;
  createdAt: string;

  // W&B
  wandb: {
    project: string;
    entity?: string; // Team/user name
  };

  // Agent behavior
  agent: {
    autoAdvance: boolean; // Auto-start next story (default: true)
    maxIterationsPerStory?: number; // Safety limit
  };

  // Tooling
  runtime: {
    packageManager: "uv" | "pip" | "poetry" | "conda";
    pythonVersion?: string;
  };
}
```

**File**: `.ml-ralph/config.json`

### Default Config

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

---

## Eval Contract

The protocol the agent is scored by, fixed before experiments start.

```typescript
interface EvalContract {
  primary_metric: string; // e.g. "auc"
  direction: "max" | "min"; // Is higher or lower better
  search_split: string; // Split the agent searches on, e.g. "cv_5fold"
  seeds: number[]; // Non-empty array of integer seeds
  protocol: string; // Prose description of the eval protocol
  success_threshold: number; // Score that counts as success
  holdout_gap_threshold: number; // Max search-vs-holdout gap, >= 0
  eval_timeout_seconds: number; // Per-eval timeout, > 0
  baseline_score: number; // Baseline score recorded in SETUP
}
```

**Files**: `.ml-ralph/eval/contract.json`, `.ml-ralph/eval/evaluate.py`, `.ml-ralph/eval/lock.json`

All fields are required. The holdout data location is deliberately not part of the contract. When the PRD is approved the runner validates the contract and writes `lock.json` with the SHA-256 of `evaluate.py` and `contract.json` plus `locked_at`; see [FILE_LAYOUT.md](./FILE_LAYOUT.md#ml-ralpheval).

---

## Log Events

`.ml-ralph/log.jsonl` is the agent's memory and the only source for the TUI panels: one JSON object per line, append-only. Every line has `ts` (ISO timestamp) and `type`, plus the fields of that type's schema.

The agent writes events only through the `log` command, run from the project directory:

```bash
ml-ralph log <type> '<json>'
ml-ralph log <type> - < event.json   # JSON on stdin, for quotes and long text
```

(Agents run it as `bunx @pentoai/ml-ralph log ...`, as the package is not installed globally.) The command checks the JSON against the schema for `<type>` in `src/domain/validation/log-event.ts` and, only if it validates, appends exactly one line with `ts` and `type` set (a `ts` in the JSON is replaced). The command looks for `.ml-ralph/` in the current directory and its parents.

On failure nothing is appended, the exit code is non-zero and stderr lists every failing field path with the expected type or allowed values, for example:

```
Invalid hypothesis event, nothing was logged:
rubrics: expected non-empty array of non-empty strings
kill_criterion: missing required field, expected non-empty string
```

An unknown type, JSON that does not parse or is not an object, a `type` in the JSON that differs from the argument, and runner-only types (`verifier_verdict`) are rejected the same way. Fields not in the schema are kept.

### Hypothesis

```typescript
interface HypothesisEvent {
  type: "hypothesis";
  id: string; // e.g. "H-001"; experiments and decisions reference it as hypothesis_id
  claim: string; // One falsifiable sentence
  expected_delta: number; // Expected change in the primary metric vs the incumbent, in metric units
  rubrics: string[]; // Non-empty; implementation checks the verifier applies to the diff
  kill_criterion: string; // Observable result that makes the agent drop the hypothesis
  rationale?: string;
}
```

A hypothesis is rejected unless `id`, `claim`, `expected_delta`, `rubrics` (at least one) and `kill_criterion` are present with these types. Logs written before this schema may hold `hypothesis` and `expected` strings instead of `claim` and `expected_delta`; the log parser still reads them.

### Required fields by type

| Type | Required fields (beyond `ts`, `type`) |
| --- | --- |
| `phase` | `phase` (`UNDERSTAND`, `STRATEGIZE`, `EXECUTE`, `REFLECT`), `summary` |
| `thinking` | `subject`, `thoughts`, `conclusion` |
| `mental_model` | `domain`, `belief`, `confidence` (`high`, `medium`, `low`), `evidence` (string[]) |
| `research` | `source`, `key_insights` (string[]), `relevance`; optional `url`, `insight` |
| `path_analysis` | `paths` (non-empty; each with `id`, `description`, `expected`, `learning_value`), `chosen`, `rationale` |
| `data_verified` | `dataset`, `checks` (array or object), `issues` (string[]), `action` |
| `result_verification` | `result`, `verification_attempts` (each with `check`, `method`, `finding`), `conclusion` |
| `success_verified` | `criteria_met`, `verification_checks`, `attempts_to_break` (string[]); optional `conclusion` |
| `hypothesis` | `id`, `claim`, `expected_delta`, `rubrics`, `kill_criterion` |
| `experiment` | `hypothesis_id`, `metrics` (name to number), `observations`; optional `name`, `wandb_run_id`, `wandb_url`, `config`, `surprises` |
| `learning` | `insight`, `source` |
| `decision` | `hypothesis_id`, `action` (`keep`, `reject`, `iterate`, `pivot`), `reason`; optional `next_step` |
| `strategic_retreat` | `trigger`, `action`, `focus` |
| `prd_updated` | `field`, `change`, `reason` |
| `kanban_updated` | `changes`, `reason` |
| `status` | `status` (`running`, `paused`, `complete`), `reason` |
| `parallel_start` | `team`, `hypotheses` (non-empty string[]), `reason` |
| `parallel_result` | `hypothesis_id`, `agent`, `metrics`, `branch` |
| `parallel_synthesis` | `winner`, `reason`, `merged_branch` |
| `verifier_verdict` (runner-only) | `id`, `verdict`, `checks`, `reason`, `output_path`; optional `model` |

Strings must be non-empty. New event types are added to `LOG_EVENT_SCHEMAS` in `src/domain/validation/log-event.ts`.

---

## Chat

PRD creation conversation history.

```typescript
interface ChatSession {
  id: string; // UUID
  purpose: "prd_creation" | "prd_refinement";
  createdAt: string;
  updatedAt: string;
  messages: ChatMessage[];
}

interface ChatMessage {
  id: string; // UUID
  timestamp: string;
  role: "user" | "assistant";
  content: string;

  // If assistant used tools
  toolCalls?: ToolCall[];
}

interface ToolCall {
  id: string;
  tool: string; // Tool name
  input: unknown; // Tool input
  output?: unknown; // Tool output (if completed)
  status: "running" | "completed" | "error";
}
```

**File**: `.ml-ralph/chat/prd-session.jsonl` (messages as JSONL)

---

## Enums

All enumerated types in one place.

```typescript
// Story types
type StoryType =
  | "discovery"
  | "experiment"
  | "evaluation"
  | "implementation"
  | "ops";

// Story status
type StoryStatus = "pending" | "in_progress" | "done" | "superseded";

// Learning categories
type LearningCategory =
  | "data"
  | "model"
  | "evaluation"
  | "infrastructure"
  | "domain"
  | "process";

// Learning impact
type LearningImpact = "high" | "medium" | "low";

// Learning confidence
type LearningConfidence = "proven" | "likely" | "speculative";

// Research types
type ResearchType =
  | "paper"
  | "documentation"
  | "tutorial"
  | "stackoverflow"
  | "blog"
  | "repository"
  | "other";

// Job status
type JobStatus = "running" | "completed" | "failed" | "stopped";

// Progress decision
type ProgressDecision = "keep" | "revert" | "investigate";

// Evidence types
type EvidenceType = "wandb" | "artifact" | "log" | "commit" | "other";

// Success criterion priority
type CriterionPriority = "must" | "should" | "nice";

// Chat roles
type ChatRole = "user" | "assistant";

// Chat session purpose
type ChatPurpose = "prd_creation" | "prd_refinement";

// Package managers
type PackageManager = "uv" | "pip" | "poetry" | "conda";
```

---

## Validation Rules

Key validation rules for each entity:

### PRD

- `project` is required, non-empty
- `goal` is required, non-empty
- `stories` must have unique IDs
- `evaluation.metric` is required

### Story

- `id` must match pattern `US-\d{3}`
- `hypothesis` should follow "If X, then Y because Z" pattern
- `supersededBy` must reference valid story ID if present

### Learning

- `insight` max 200 characters
- `implications` must have at least 1 item
- `source.storyId` must reference valid story

### Research

- `url` must be valid URL if present
- `keyTakeaways` must have at least 1 item

### EvalContract

- All fields required; error messages name the field
- `direction` is `"max"` or `"min"`
- `seeds` is a non-empty array of integers
- `holdout_gap_threshold` >= 0, `eval_timeout_seconds` > 0
- `success_threshold` and `baseline_score` are finite numbers

### Log events

- Every type has a schema in `LOG_EVENT_SCHEMAS`; see [Log Events](#log-events)
- `hypothesis` needs `claim`, `expected_delta` (number), `rubrics` (non-empty) and `kill_criterion`

### TrainingJob

- `pid` must be positive integer
- `logPath` must exist when status is 'running'
