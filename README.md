# ML-Ralph

![ML-Ralph](ralph.webp)

ML-Ralph is an autonomous ML agent loop (Claude or Codex) that turns a messy ML project into an evidence‑first workflow. It keeps a living backlog in `prd.json`, enforces one story per iteration, and leaves an audit trail in `progress.txt` so each run is reproducible and reviewable. The goal is simple: fast, safe progress without losing context between iterations. Based on [Geoffrey Huntley's Ralph pattern](https://github.com/snarktank/ralph).

## What you need

- [Claude Code](https://docs.anthropic.com/en/docs/claude-code) or [Codex CLI](https://developers.openai.com/codex/cli/)
- `jq`
- A git repo for your ML project

## Install

```bash
# From your project root
mkdir -p scripts/ml-ralph
cp /path/to/ml-ralph/ml-ralph.sh scripts/ml-ralph/
cp /path/to/ml-ralph/CLAUDE.md CLAUDE.md
cp /path/to/ml-ralph/CODEX.md CODEX.md
cp /path/to/ml-ralph/AGENTS.md AGENTS.md

chmod +x scripts/ml-ralph/ml-ralph.sh
```

## Quick workflow

1. Create an ML PRD (use the prd skill)
2. Convert PRD → `prd.json` (use the ralph skill)
3. Run the loop:

```bash
./scripts/ml-ralph/ml-ralph.sh [--tool claude|codex] [--codex-safe] [max_iterations]
```

Notes:

- Codex uses `CODEX.md` and auto-loads `AGENTS.md`.
- Default Codex mode is full autonomy (no approvals, no sandbox). Use `--codex-safe` for workspace-write sandboxing.

## Key files

| File           | Purpose                          |
| -------------- | -------------------------------- |
| `ml-ralph.sh`  | Loop runner                      |
| `CLAUDE.md`    | Claude prompt (source of truth)  |
| `CODEX.md`     | Codex prompt                     |
| `prd.json`     | Living backlog                   |
| `progress.txt` | Evidence log and learnings       |
| `skills/`      | PRD creation + conversion skills |

## Debugging

```bash
cat prd.json | jq '.userStories[] | {id, title, passes}'
cat progress.txt
git log --oneline -10
```
