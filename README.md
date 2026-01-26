# ML-Ralph

![ML-Ralph](https://raw.githubusercontent.com/JoaquinCampo/ml-ralph/main/ml-ralph.webp)

ML-Ralph is an autonomous ML agent (Claude or Codex) that thinks like an experienced MLE. It works through a cognitive loop: ORIENT → RESEARCH → HYPOTHESIZE → EXECUTE → ANALYZE → VALIDATE → DECIDE. Based on [Ralph](https://github.com/snarktank/ralph).

## What you need

- [Claude Code](https://docs.anthropic.com/en/docs/claude-code) or [Codex CLI](https://developers.openai.com/codex/cli/)
- A git repo for your ML project
- Python with `uv` package manager
- Weights & Biases account (for experiment tracking)

## Install

```bash
uv tool install ml-ralph
```

## Quick Start

### 1. Start a Conversation (SETUP Mode)

```bash
ml-ralph chat
```

Ralph will ask clarifying questions to understand your ML problem and create a PRD together. When the PRD is ready, say `/start` to begin execution.

### 2. Run Autonomous Execution

```bash
ml-ralph run
```

Ralph works through the cognitive loop until success criteria are met.

## Commands

| Command | Purpose |
|---------|---------|
| `ml-ralph chat` | Interactive SETUP mode to create PRD |
| `ml-ralph run` | Autonomous EXECUTION through cognitive loop |
| `ml-ralph status` | Show current state (PRD, execution, backlog) |
| `ml-ralph log` | View thinking log entries |
| `ml-ralph hint "msg"` | Send guidance during execution |
| `ml-ralph pause` | Pause autonomous execution |
| `ml-ralph resume` | Resume after pause |
| `ml-ralph reset` | Wipe all Ralph state files |

## Options

```bash
# Use a different tool (default: claude)
ml-ralph chat --tool codex
ml-ralph run --tool codex

# Set max iterations (default: 100)
ml-ralph run --max-iterations 250
```

## Setup Weights & Biases (Required Before Running)

Set up wandb before running ML-Ralph:

```bash
# Install wandb
uv add wandb

# Login (opens browser)
wandb login

# Set project name
export WANDB_PROJECT="your-project-name"
```

## Key Files

| File | Purpose |
|------|---------|
| `prd.json` | The approved PRD (contract) |
| `ralph.json` | Execution state |
| `backlog.json` | Hypotheses queue |
| `log.jsonl` | Thinking log |
| `chat.jsonl` | Conversation history |
| `inbox.json` | User commands |

## The Cognitive Loop

```
ORIENT → RESEARCH → HYPOTHESIZE → EXECUTE → ANALYZE → VALIDATE → DECIDE
                         ↑                                         │
                         └─────────────────────────────────────────┘
```

- **ORIENT**: Understand the problem, constraints, failure modes
- **RESEARCH**: Learn from existing knowledge, find SOTA approaches
- **HYPOTHESIZE**: Form testable bets with expected outcomes
- **EXECUTE**: Implement minimal changes, run experiments
- **ANALYZE**: Understand results, examine failures, find patterns
- **VALIDATE**: Check for leakage, ensure results are trustworthy
- **DECIDE**: Keep/revert/pivot based on evidence

## Debugging

```bash
ml-ralph status
ml-ralph log --tail 5
cat prd.json | jq '.success_criteria'
```
