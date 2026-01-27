# ML-Ralph

An autonomous ML agent that thinks like an experienced MLE. It works through a cognitive loop: ORIENT → RESEARCH → HYPOTHESIZE → EXECUTE → ANALYZE → VALIDATE → DECIDE.

Based on [Ralph](https://github.com/snarktank/ralph) by Geoffrey Huntley.

## Requirements

- [Claude Code](https://docs.anthropic.com/en/docs/claude-code) or [Codex CLI](https://developers.openai.com/codex/cli/)
- A git repo for your ML project

## Install

```bash
pip install ml-ralph
```

Or with uv:

```bash
uv tool install ml-ralph
```

## Quick Start

### 1. Initialize Ralph in your project

```bash
ml-ralph init
```

This creates:
```
your-project/
├── .ml-ralph/
│   └── RALPH.md           # Agent instructions
├── .claude/skills/ml-ralph/  # Claude Code skill
├── .codex/skills/ml-ralph/   # Codex skill
├── CLAUDE.md              # Claude instructions
└── AGENTS.md              # Agent instructions
```

### 2. Create a PRD with Claude Code

Open Claude Code in your project and use the `/ml-ralph` skill:

```
/ml-ralph
```

Ralph will ask clarifying questions to understand your ML problem and create a PRD at `.ml-ralph/prd.json`.

### 3. Run the Autonomous Loop

```bash
ml-ralph run
```

Ralph works through the cognitive loop until success criteria are met.

## Commands

| Command | Purpose |
|---------|---------|
| `ml-ralph init` | Initialize Ralph in current project |
| `ml-ralph run` | Run autonomous execution loop |

## Options

```bash
# Use Codex instead of Claude (default: claude)
ml-ralph run --tool codex

# Set max iterations (default: 100)
ml-ralph run --max-iterations 200

# Force overwrite on init
ml-ralph init --force
```

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
