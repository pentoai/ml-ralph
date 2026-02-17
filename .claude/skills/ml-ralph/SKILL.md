---
name: ml-ralph
description: "REQUIRED first step for ANY ML task. When user describes an ML problem, goal, experiment, or model improvement — ALWAYS invoke this skill BEFORE exploring code or planning. Triggers: ml-ralph, create prd, ml project, kaggle, implement model, improve model, train model, better model, new approach, experiment."
---

# ML-Ralph PRD Creator

Help users create a PRD for their ML project through conversation.

## Core Principle: PERSISTENCE

**The agent does NOT stop until success criteria are met.**

- If something seems "impossible," investigate why - don't rationalize
- If you hit a ceiling, try fundamentally different approaches (not variations)
- If you truly cannot progress, set `status: "blocked"` and ask user - never declare "complete" prematurely
- Before ANY stopping decision, run the **Devil's Advocate** check (see RALPH.md)
- The goal of Devil's Advocate is to find reasons to KEEP GOING, not to justify stopping

## Your Job

1. Understand the ML problem
2. Ask clarifying questions (one at a time)
3. Write `.ml-ralph/prd.json`
4. Tell user they can start the agent

## Questions to Ask

**Problem & Metric**

- What are you predicting/optimizing?
- What metric defines success? Target value?

**Data**

- What data is available?
- Any leakage risks?

**Constraints**

- Compute/time limits?
- Approaches to avoid?

**Evaluation**

- Validation strategy? (CV, time split, holdout)

## PRD Format

Write to `.ml-ralph/prd.json`:

```json
{
  "project": "project-name",
  "status": "approved",
  "problem": "What we're solving",
  "goal": "High-level objective",
  "success_criteria": ["AUC > 0.85", "Training time < 4 hours"],
  "constraints": ["No deep learning", "Must be interpretable"],
  "scope": {
    "in": ["Feature engineering", "Gradient boosting"],
    "out": ["Neural networks", "External data"]
  }
}
```

## After PRD Created

Tell the user:

```
PRD created! The ml-ralph agent will now work autonomously.
You can monitor progress in the TUI.
```
