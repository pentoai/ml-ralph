# ML-Ralph Agent Instructions

## Overview

ML-Ralph is an autonomous agent loop for ML projects. Each iteration is a fresh instance with clean context. Memory persists via git history, `progress.txt`, and `prd.json`.

## Key Files

- `ml-ralph.sh` - The ML-Ralph loop runner (Claude or Codex)
- `CODEX.md` - Codex prompt passed via stdin (AGENTS.md is still auto-loaded)
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
- Never ask the user questions during runs; make reasonable assumptions and log them in progress.txt
- Only emit `<promise>COMPLETE</promise>` after counting remaining stories in prd.json and confirming zero; log the count in progress.txt
- At the end of every iteration, reflect on new evidence and adjust prd.json if needed. Use the checklist: metrics/error analysis shifts, data issues (missingness/leakage/drift), compute constraints, or results that supersede a story. If no change, log “Backlog unchanged” with a one‑sentence reason
- For long training runs, always detach the process (nohup/setsid/tmux), log PID + log path + W&B run URL/ID, and monitor progress across iterations without blocking; if a run is active, the current iteration is a monitoring decision pass (observe W&B curves/logs, extract insight, decide continue/stop+fix/pivot, and log rationale)
- Maintain `outputs/logs/active_runs.json` so the next iteration can always detect and monitor active training runs
