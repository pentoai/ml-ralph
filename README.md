# @pentoai/ml-ralph-ui

[![npm version](https://badge.fury.io/js/@pentoai%2Fml-ralph-ui.svg)](https://www.npmjs.com/package/@pentoai/ml-ralph-ui)

An autonomous ML engineering agent with a terminal user interface (TUI).

ml-ralph helps you iterate on ML projects by automating the experiment loop: planning, execution, analysis, and learning extraction. You interact with it through a clean TUI that lets you create PRDs, monitor agent execution, and review accumulated knowledge.

## Key Features

- **PRD-driven development**: Define your ML project goals, constraints, and stories through conversational chat with Claude Code
- **Autonomous execution**: Agent runs continuously through stories until stopped, making decisions based on evidence
- **Learning accumulation**: Structured insights extracted from every iteration, searchable and actionable
- **Research integration**: Agent researches approaches and documents findings
- **Training monitoring**: Track long-running jobs with W&B integration

## Architecture

ml-ralph is built as a TUI using [OpenTUI](https://github.com/anomalyco/opentui) with [Bun](https://bun.sh/) as the runtime. It orchestrates [Claude Code](https://claude.ai/code) to perform actual ML engineering work.

```
┌─────────────────────────────────────────────────────────────┐
│                     ml-ralph TUI                            │
│  ┌─────────────────────┐  ┌──────────────────────────────┐  │
│  │     Planning        │  │         Monitor              │  │
│  │  ┌───────┬───────┐  │  │  ┌─────────┬──────────────┐  │  │
│  │  │  CC   │Learn- │  │  │  │ Agent   │ Experiments  │  │  │
│  │  │ Chat  │ings/  │  │  │  │ Output  │ + Metrics    │  │  │
│  │  │       │Research│  │  │  │         │              │  │  │
│  │  └───────┴───────┘  │  │  └─────────┴──────────────┘  │  │
│  └─────────────────────┘  └──────────────────────────────┘  │
└─────────────────────────────────────────────────────────────┘
                            │
                            ▼
                    ┌───────────────┐
                    │  Claude Code  │
                    └───────────────┘
                            │
                            ▼
                    ┌───────────────┐
                    │   Codebase    │
                    │   + W&B       │
                    └───────────────┘
```

## Two Modes

### Planning Mode

- Chat with Claude Code to create/refine your PRD
- View accumulated learnings from past iterations
- Review research the agent has gathered
- See your story backlog

### Monitor Mode

- Watch the agent execute stories in real-time
- View experiment metrics and training curves
- See current story and hypothesis
- Control agent (start/stop)

## Quick Start

```bash
# Run directly with bunx
bunx @pentoai/ml-ralph-ui

# Or install globally
bun install -g @pentoai/ml-ralph-ui
ml-ralph
```

## Requirements

- [Bun](https://bun.sh/) runtime
- [Claude Code](https://claude.ai/code) CLI installed and authenticated

## Documentation

- [Architecture](docs/ARCHITECTURE.md) - System design and layers
- [Data Models](docs/DATA_MODELS.md) - All type definitions
- [File Layout](docs/FILE_LAYOUT.md) - Project file structure
- [Prompts](docs/PROMPTS.md) - Claude Code system prompts
- [MVP Plan](docs/MVP_PLAN.md) - Development phases

## Tech Stack

- **Runtime**: [Bun](https://bun.sh/)
- **TUI Framework**: [OpenTUI](https://github.com/anomalyco/opentui)
- **Language**: TypeScript
- **Agent**: [Claude Code](https://claude.ai/code)
- **Experiment Tracking**: [Weights & Biases](https://wandb.ai/)

## License

MIT
