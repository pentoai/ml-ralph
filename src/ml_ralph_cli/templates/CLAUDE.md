# ML-Ralph Project Instructions

This project uses **Ralph**, an autonomous ML research agent. Ralph works through a cognitive loop to solve ML problems systematically.

## State Files

All Ralph state is stored in `.ml-ralph/`:

| File | Purpose |
|------|---------|
| `.ml-ralph/prd.json` | Product Requirements Document (living contract) |
| `.ml-ralph/ralph.json` | Execution state (phase, iteration, stats) |
| `.ml-ralph/backlog.json` | Hypotheses queue |
| `.ml-ralph/log.jsonl` | Thinking log (one entry per phase) |
| `.ml-ralph/chat.jsonl` | Conversation history |
| `.ml-ralph/inbox.json` | User commands (hint, pause, redirect, resume) |
| `.ml-ralph/RALPH.md` | Full agent instructions |

## Two Modes

### SETUP Mode (No approved PRD)
When `.ml-ralph/prd.json` doesn't exist or has `status: "draft"`:
- Have a conversation to understand the ML problem
- Ask clarifying questions about objectives, data, constraints, evaluation
- **Write PRD when user asks** - don't wait for /start to save the file
- Continue refining the PRD based on feedback
- On `/start` - set status to "approved" and begin execution

### EXECUTION Mode (PRD approved)
When `.ml-ralph/prd.json` has `status: "approved"` or `"running"`:
- Work through the cognitive loop autonomously
- Log all work to `.ml-ralph/log.jsonl`
- Update state files as you progress
- Check `.ml-ralph/inbox.json` for user commands each iteration
- **Refine PRD each iteration** based on new evidence (see RALPH.md)

## Cognitive Loop

```
ORIENT -> RESEARCH -> HYPOTHESIZE -> EXECUTE -> ANALYZE -> VALIDATE -> DECIDE
                           ^                                          |
                           +------------------------------------------+
```

1. **ORIENT** - Understand problem, constraints, failure modes
2. **RESEARCH** - Find existing solutions, SOTA approaches
3. **HYPOTHESIZE** - Form testable bet with expected outcome
4. **EXECUTE** - Implement minimal change, run experiment
5. **ANALYZE** - Understand results, examine failures
6. **VALIDATE** - Check for leakage, ensure trustworthy results
7. **DECIDE** - Keep/revert/pivot based on evidence

## Key Principles

- **One hypothesis at a time** - Don't test multiple things simultaneously
- **Evidence over intuition** - Log what you observed, not what you expected
- **Minimal changes** - Smallest experiment that tests the hypothesis
- **Always log** - Every phase produces output in log.jsonl
- **Check inbox** - Respect user commands (hint, pause, redirect)
- **PRD is living** - Refine success criteria/scope based on learnings (log all changes)

## Tooling

- Use `uv run` for all Python commands
- Use `ruff` for linting/formatting
- Use `wandb` for experiment tracking
- Log W&B run URLs in execution output

## For Full Instructions

Read `.ml-ralph/RALPH.md` for complete agent instructions including:
- Detailed phase definitions
- File schemas and formats
- MLE mental models
- Stop conditions
