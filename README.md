# ml-ralph

[![npm version](https://img.shields.io/npm/v/@pentoai/ml-ralph.svg)](https://www.npmjs.com/package/@pentoai/ml-ralph)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

An autonomous ML engineering agent with a terminal user interface. ml-ralph automates the experiment loop — planning, execution, analysis, and learning extraction — so you can iterate on ML projects faster.

You define your goals through a PRD. The agent works through stories autonomously, runs experiments, tracks metrics, and accumulates structured learnings across iterations.

## Install

```bash
bun add -g @pentoai/ml-ralph
```

Or run directly:

```bash
bunx @pentoai/ml-ralph
```

### Prerequisites

- [Bun](https://bun.sh/) v1.0+
- [tmux](https://github.com/tmux/tmux) (`brew install tmux`)
- [Claude Code](https://docs.anthropic.com/en/docs/claude-code) CLI, installed and authenticated

## Quick start

```bash
# Initialize a new project
ml-ralph init my-project

# Launch the TUI
ml-ralph

# Launch with agent teams (parallel experiments)
ml-ralph --teams
```

## Usage

ml-ralph operates in two modes, toggled with `Tab`:

### Planning

Chat with Claude Code to define or refine your PRD — project goals, success criteria, constraints, and stories. Review accumulated learnings and research from prior iterations.

### Monitor

Watch the agent execute stories in real-time. View experiment output, metrics, and training curves. Start, stop, and control the agent.

### Keyboard shortcuts

| Key | Action |
| --- | --- |
| `Tab` | Switch between Planning and Monitor |
| `1` `2` `3` | Switch tabs in Planning mode |
| `f` | Focus terminal pane |
| `s` | Start / Stop agent |
| `t` | Stop training job |
| `w` | Open W&B dashboard |
| `Esc` | Exit / Dismiss |
| `q` | Quit |

## How it works

ml-ralph orchestrates Claude Code through a structured cognitive loop:

```
ORIENT → RESEARCH → HYPOTHESIZE → EXECUTE → ANALYZE → VALIDATE → DECIDE
                         ↑                                         │
                         └─────────────────────────────────────────┘
```

Each iteration, the agent reads project state, selects the next story, forms a hypothesis, runs a minimal experiment, analyzes results, and decides whether to keep, revert, or pivot. Learnings are extracted and persisted so future iterations build on past evidence.

### State files

All project state lives in `.ml-ralph/`:

| File | Purpose |
| --- | --- |
| `config.json` | Project configuration |
| `prd.json` | Product requirements document |
| `learnings.jsonl` | Accumulated insights |
| `research.jsonl` | Research findings |
| `progress.jsonl` | Iteration logs |
| `inbox.json` | User commands (hint, pause, redirect) |

## Architecture

```
┌──────────────────────────────────────────────────┐
│  UI Layer (OpenTUI/React)                        │
│  Planning screen · Monitor screen · Widgets      │
├──────────────────────────────────────────────────┤
│  Application Layer                               │
│  AgentOrchestrator · State management            │
├──────────────────────────────────────────────────┤
│  Domain Layer                                    │
│  Types · Validation · Story selection            │
├──────────────────────────────────────────────────┤
│  Infrastructure Layer                            │
│  Claude Code client · File store · W&B · tmux    │
└──────────────────────────────────────────────────┘
```

Built with [OpenTUI](https://github.com/anthropics/opentui), [Bun](https://bun.sh/), and [Claude Code](https://docs.anthropic.com/en/docs/claude-code).

## Development

```bash
# Install dependencies
bun install

# Run in development
bun run dev

# Run tests
bun test

# Type check
bun run typecheck

# Lint
bun run lint
```

## License

MIT
