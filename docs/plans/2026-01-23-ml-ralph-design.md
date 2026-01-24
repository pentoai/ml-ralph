# ML-Ralph Design

Date: 2026-01-23

## Overview

ML-Ralph is a new repository that keeps the original Ralph loop intact but makes the repo ML-centric by default. The loop stays the same (fresh Claude instance per iteration, guided by `prd.json`), but the prompts, PRD schema, and skills encode ML engineer instincts: scenario understanding, EDA, research, and experiment tracking. The PRD is a living backlog that evolves based on evidence, not a static spec.

## Goals

- Keep the proven Ralph loop intact while making the repo ML-native.
- Encode ML engineer heuristics as defaults (playbook + decision tree), not a rigid lifecycle.
- Support dynamic, evidence-driven backlog changes each iteration.
- Stay stack-agnostic; avoid Kaggle-specific assumptions.

## Core Decisions

- **Claude-only** loop for consistency.
- **ML-centric prompts** in `CLAUDE.md` + summarized in `AGENTS.md`.
- **Dynamic PRD refinement** is part of the loop.
- **Flowchart included** to explain the iteration lifecycle.

## Repo Structure

```
ml-ralph/
  ml-ralph.sh
  CLAUDE.md
  AGENTS.md
  README.md
  prd.json.example
  skills/
    prd/
    ralph/
  flowchart/
```

## ML Engineer Brain (Non-prescriptive)

- Scenario/problem understanding
- Data exploration for objective comprehension
- Research before reinventing
- Experiment tracking setup (wandb)
- Evaluation discipline + leakage awareness
- Baseline-first mindset
- Error analysis + slicing
- Reproducibility & artifacts

This lives in `CLAUDE.md` as a playbook + decision tree.

## Dynamic PRD Rules

- `prd.json` is a living backlog, refined every iteration based on evidence.
- Allowed changes: add, split, reorder, supersede stories.
- Every change must reference evidence and be logged in `progress.txt`.
- Never delete stories; use `supersededBy` for traceability.

## PRD Schema Additions

- `type`: discovery | experiment | evaluation | implementation | ops
- `hypothesis` (optional)
- `evidenceRequired`
- `supersededBy` (optional)
- `risk` or `uncertainty` (optional)

## Progress Log Requirements

Each iteration must log:

- Hypothesis
- Minimal change
- Evaluation method + metric
- Evidence summary
- Decision + next step
- Backlog changes (if any)

## Non-Goals

- No Kaggle-specific logic or instructions
- No forced ML lifecycle
- No framework lock-in
