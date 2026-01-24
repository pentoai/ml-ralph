# ML-Ralph Agent Instructions

## Overview

ML-Ralph is an autonomous Claude-only agent loop for ML projects. Each iteration is a fresh instance with clean context. Memory persists via git history, `progress.txt`, and `prd.json`.

## Commands

```bash
# Run the flowchart dev server
cd flowchart && npm run dev

# Build the flowchart
cd flowchart && npm run build

# Run ML-Ralph (Claude or Codex)
./ml-ralph.sh [--tool claude|codex] [max_iterations]
```

## Key Files

- `ml-ralph.sh` - The ML-Ralph loop runner (Claude or Codex)
- `codex.md` - Codex prompt passed via stdin (AGENTS.md is still auto-loaded)
- `CLAUDE.md` - ML-centric agent instructions and heuristics (source of truth)
- `prd.json.example` - Example ML PRD format
- `skills/prd/` - ML PRD generator skill
- `skills/ralph/` - ML PRD → prd.json converter skill
- `flowchart/` - Visualization of the ML-Ralph loop

## ML Repo Nature

- ML-first reasoning: hypothesis → experiment → evidence → decision
- Evidence is mandatory; metrics are suspicious until validated
- Backlog is dynamic: prd.json is refined each iteration based on evidence
- Tooling defaults: uv, ruff, mypy, pytest, pydantic, loguru, typer, wandb
- Always update AGENTS.md with reusable ML patterns and gotchas
