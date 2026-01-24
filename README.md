# ML-Ralph

![ML-Ralph](https://raw.githubusercontent.com/JoaquinCampo/ml-ralph/main/ralph.webp)

ML-Ralph is an autonomous ML agent loop (Claude or Codex) that turns an ML project into an evidence‑first workflow. It keeps a living backlog in `prd.json`, enforces one story per iteration, and leaves an audit trail in `progress.jsonl` so each run is reproducible and reviewable. The goal is simple: fast, safe progress without losing context between iterations. Based on [Ralph](https://github.com/snarktank/ralph).

## What you need

- [Claude Code](https://docs.anthropic.com/en/docs/claude-code) or [Codex CLI](https://developers.openai.com/codex/cli/)
- `jq`
- A git repo for your ML project
- Python with `uv` package manager
- Weights & Biases account (for experiment tracking)

## Install

Install the CLI once, then initialize each project.

```bash
uv tool install ml-ralph
```

In your project:

```bash
ml-ralph init
```

## Setup Weights & Biases (Required Before Running)

**You** need to set up wandb before running ML-Ralph. Agents assume wandb is already configured and ready to use.

Set up authentication and project configuration:

```bash
# Install wandb
uv add wandb

# Login (opens browser)
wandb login

# Set project name
export WANDB_PROJECT="your-project-name"

# Optional: set entity (team or username)
export WANDB_ENTITY="your-entity"
```

## Quick workflow

1. Create an ML PRD (use the prd skill)
2. Convert PRD → `prd.json` (use the ralph skill)
3. Run the loop:

```bash
ml-ralph run --tool codex --max-iterations 250
```

Notes:

- Default Codex mode is full autonomy (no approvals, no sandbox). Use `--codex-safe` for workspace-write sandboxing.

## How it works

```bash
ml-ralph explain
```

## Key files

| File                            | Purpose                    |
| ------------------------------- | -------------------------- |
| `prd.json`                      | Living backlog             |
| `progress.jsonl`                | Evidence log and learnings |
| `outputs/logs/active_runs.json` | Long‑run tracking          |
| `.claude/skills/`               | Claude skills              |
| `.codex/skills/`                | Codex skills               |

## Debugging

```bash
cat prd.json | jq '.userStories[] | {id, title, passes}'
cat progress.jsonl
git log --oneline -10
```
