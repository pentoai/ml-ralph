---
name: ralph-file-schemas
description: "Schema reference for ml-ralph state files (prd.json, kanban.json). Use when reading or writing these files."
---

# Ralph File Schemas

Reference for `.ml-ralph/` state files. Pure schemas - no philosophy (see RALPH.md for that).

---

## prd.json (The Destination)

Your contract with the user. Rarely changes.

```json
{
  "project": "project-name",
  "status": "draft|approved|blocked|complete",
  "problem": "What we're solving",
  "goal": "High-level objective",
  "success_criteria": ["Metric > threshold"],
  "constraints": ["No deep learning", "< 4hr training"],
  "scope": {
    "in": ["Feature engineering", "Gradient boosting"],
    "out": ["Neural networks", "External data"]
  }
}
```

### Status Values

| Status | Meaning | Who Can Set |
|--------|---------|-------------|
| `draft` | PRD being created | Agent |
| `approved` | User approved, work begins | User |
| `blocked` | Agent cannot progress (requires user decision) | Agent |
| `complete` | All success criteria verified met | Agent |

### What Can Change

**Freely:**
- `success_criteria` - Refine based on what's achievable
- `constraints` - Add discovered constraints
- `scope` - Adjust based on learnings

**Requires user approval:**
- `problem` - Core problem definition
- `goal` - High-level objective
- Any claim that success criteria are unachievable

Always log changes with rationale!

---

## eval/ (The Eval Contract)

Drafted in SETUP with the user. Once `prd.json` is `approved`, the runner validates and locks it. Never edit these files after the lock: the runner re-hashes them before every iteration and pauses the run for the user if one changed or was deleted.

| File | Written by | Purpose |
|------|------------|---------|
| `.ml-ralph/eval/evaluate.py` | Agent (SETUP) | Eval script |
| `.ml-ralph/eval/contract.json` | Agent (SETUP) | Eval protocol and baseline score |
| `.ml-ralph/eval/lock.json` | Runner only | SHA-256 of the two files plus lock time |

```json
{
  "primary_metric": "auc",
  "direction": "max|min",
  "search_split": "cv_5fold",
  "seeds": [0, 1, 2],
  "protocol": "5-fold stratified CV, mean over seeds",
  "success_threshold": 0.9,
  "holdout_gap_threshold": 0.02,
  "eval_timeout_seconds": 1800,
  "baseline_score": 0.81
}
```

All fields are required. `seeds` is a non-empty array of integers, `holdout_gap_threshold` >= 0, `eval_timeout_seconds` > 0. Do not put a holdout data path in the contract. Run the baseline in SETUP and record it as `baseline_score`. The runner refuses to run iterations after approval if the contract is invalid, `baseline_score` is missing, `evaluate.py` is missing, or `lock.json` is missing or malformed. After setting `status: "approved"`, end the iteration; the lock is written when the next one starts.

---

## kanban.json (The Journey)

Your working plan. Updated EVERY iteration.

```json
{
  "last_updated": "2024-01-28T10:30:00Z",
  "update_reason": "H-001 revealed distribution shift - reordering priorities",

  "current_focus": {
    "id": "T-007",
    "title": "Investigate pre-2020 performance degradation",
    "why": "H-001 showed temporal features hurt old data",
    "expected_outcome": "Clear understanding of distribution shift",
    "phase": "UNDERSTAND"
  },

  "up_next": [
    {
      "id": "T-008",
      "title": "Research distribution shift handling",
      "why": "Need SOTA approaches before designing solution",
      "depends_on": "T-007"
    }
  ],

  "backlog": [
    {
      "id": "T-011",
      "title": "Explore ensemble approaches",
      "why": "Might help with robustness",
      "notes": "Lower priority until baseline is solid"
    }
  ],

  "completed": [
    {
      "id": "T-006",
      "title": "Run H-001 temporal feature experiment",
      "outcome": "Partial success - revealed distribution shift",
      "completed_at": "2024-01-28T10:00:00Z"
    }
  ],

  "abandoned": [
    {
      "id": "T-003",
      "title": "Try neural network approach",
      "reason": "Research showed tree methods dominate",
      "abandoned_at": "2024-01-27T15:00:00Z"
    }
  ]
}
```

### Field Reference

| Field | Type | Description |
|-------|------|-------------|
| `current_focus` | object | Single task being worked on NOW |
| `up_next` | array | 5-6 step lookahead, ordered with dependencies |
| `backlog` | array | Ideas for later, less defined |
| `completed` | array | Done tasks with outcomes recorded |
| `abandoned` | array | Dropped tasks with reasons |
| `last_updated` | ISO timestamp | When kanban was last modified |
| `update_reason` | string | Why it was modified |

### Task Object Fields

| Field | Required | Description |
|-------|----------|-------------|
| `id` | Yes | Unique identifier (e.g., "T-007") |
| `title` | Yes | Brief description |
| `why` | Yes | Rationale for this task |
| `expected_outcome` | current_focus only | What success looks like |
| `phase` | current_focus only | UNDERSTAND, STRATEGIZE, EXECUTE, or REFLECT |
| `depends_on` | Optional | Task ID this depends on |
| `outcome` | completed only | What actually happened |
| `reason` | abandoned only | Why it was dropped |
