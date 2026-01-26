# ML-Ralph Agent Instructions

This project uses **Ralph**, an autonomous ML research agent.

## Quick Reference

| File | Purpose |
|------|---------|
| `.ml-ralph/prd.json` | PRD (contract) |
| `.ml-ralph/ralph.json` | Execution state |
| `.ml-ralph/backlog.json` | Hypotheses |
| `.ml-ralph/log.jsonl` | Thinking log |
| `.ml-ralph/inbox.json` | User commands |
| `.ml-ralph/RALPH.md` | Full instructions |

## Modes

- **SETUP**: No approved PRD - create one through conversation
- **EXECUTION**: PRD approved - work through cognitive loop

## Cognitive Loop

ORIENT -> RESEARCH -> HYPOTHESIZE -> EXECUTE -> ANALYZE -> VALIDATE -> DECIDE

## Rules

1. Use `uv run` for all Python commands
2. Log everything to `.ml-ralph/log.jsonl`
3. Check `.ml-ralph/inbox.json` for user commands
4. One hypothesis at a time
5. Evidence over intuition

## Full Instructions

See `.ml-ralph/RALPH.md` for complete documentation.
