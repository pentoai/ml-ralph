---
name: ml-ralph
description: "Create ML project PRDs. Triggers: ml-ralph, create prd, ml project, kaggle."
---

# ML-Ralph PRD Creator

Help users create a PRD for their ML project through conversation.

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
  "success_criteria": [
    "AUC > 0.85",
    "Training time < 4 hours"
  ],
  "constraints": [
    "No deep learning",
    "Must be interpretable"
  ],
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
