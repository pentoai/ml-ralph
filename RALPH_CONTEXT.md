# Ralph Project Context

## Overview

**ml-ralph** (`@pentoai/ml-ralph`) is a terminal app that runs an autonomous ML engineering agent. You run it with `bunx @pentoai/ml-ralph` inside an ML project. It launches the `claude` CLI in a loop and shows the agent's plan, experiments and learnings live. The agent works like an experienced ML engineer: it reasons carefully, documents decisions and respects user guidance.

This repository is the whole product. There is no separate Python agent. The agent's behaviour is prompt text in `src/infrastructure/ralph/templates.ts` (`RALPH_MD`, `SKILL_MD`, `CLAUDE_MD`, `AGENTS_MD`), which `init` writes into the user's project.

## Tech Stack

- **Runtime**: Bun (no build step; the package ships `src/` and Bun runs the TSX)
- **TUI framework**: OpenTUI (`@opentui/core`, `@opentui/react`) with React 19
- **Ink-style API**: `src/ui/ink.tsx` is a compatibility shim. It keeps `Box`/`Text`/`useInput` on top of OpenTUI, and widgets import from it
- **State**: zustand
- **Language**: TypeScript (strict)
- **Agent**: the `claude` CLI, spawned as a subprocess with `--output-format stream-json`
- **Layout**: tmux (the app re-launches itself in a tmux session `ml-ralph-<dir>` and splits the window)
- **Tooling**: Biome (`bun run lint:ci`), `tsc --noEmit`, `bun test`

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│                     UI Layer                            │
│   (OpenTUI/React: app, screens, widgets, hooks)         │
├─────────────────────────────────────────────────────────┤
│                  Application Layer                      │
│   (DefaultOrchestrator, zustand store)                  │
├─────────────────────────────────────────────────────────┤
│                Infrastructure Layer                     │
│   (ralph: RalphRunner/init/log-parser/templates,        │
│    tmux, file-store)                                    │
├─────────────────────────────────────────────────────────┤
│                    Domain Layer                         │
│   (pure types and validation)                           │
└─────────────────────────────────────────────────────────┘
```

See `docs/ARCHITECTURE.md` for the details. In short:

- `src/index.tsx` handles `--help`, `--teams` and `init`, re-launches inside tmux, and renders `<App>`.
- `src/ui/app.tsx` calls `ensureInitialized`, creates a `DefaultOrchestrator`, and owns the keyboard shortcuts.
- `DefaultOrchestrator` (`src/application/orchestrator`) wraps `RalphRunner` and fans its callbacks out to the UI.
- `RalphRunner` (`src/infrastructure/ralph/runner.ts`) runs up to N iterations. Each one spawns `claude --dangerously-skip-permissions --verbose -p <prompt> --output-format stream-json` in the project directory and parses the stream into `StreamEvent`s. With `--teams` it sets `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`.
- `log-parser.ts` reads and watches `.ml-ralph/log.jsonl`, `prd.json` and `kanban.json`. The panels render what it returns.

Every module under `src/infrastructure` is used by the running app. If you add one, wire it in. If you stop using one, delete it with its tests.

## UI Modes

`Tab` cycles through three modes.

- **Planning**: the tmux window is split. An interactive `claude` session runs in the terminal pane, where you create or refine the PRD. The TUI shows the knowledge tabs (PRD, Kanban, Learnings, Research).
- **Monitor**: live activity feed, cognitive map, and the knowledge panel (hypotheses, experiments with metrics charts and any W&B links the agent logged).
- **Output**: the raw agent stream (text, tool calls, results, errors, iteration markers).

## Keyboard Shortcuts

| Key         | Action                                                    |
| ----------- | --------------------------------------------------------- |
| `Tab`       | Cycle Planning, Monitor and Output modes                  |
| `1`-`4`     | Switch tab: PRD, Kanban, Learnings, Research              |
| `f` / `i`   | Focus the terminal pane (Planning mode)                   |
| `s`         | Start or stop the agent (asks for confirmation)           |
| `h`         | Add a hint for the next iteration (while the agent runs)  |
| `j` / `k`   | Scroll                                                    |
| `b`/`c`/`a` | Expand backlog / completed / abandoned (Kanban tab)       |
| `t`         | Stop the active training job (Monitor mode)               |
| `w`         | Open the W&B URL of a training job (Monitor mode)         |
| `Esc`       | Dismiss errors or leave input mode                        |
| `q`         | Quit (asks for confirmation)                              |

`t` and `w` act on `.ml-ralph/runs/active.json`. Nothing writes training jobs to that file yet, so they currently do nothing.

## CLI

```
ml-ralph [project-path]       Launch the TUI (default: current directory)
ml-ralph init [name] [path]   Initialize a project, keeping existing files
ml-ralph --teams              Enable parallel experiments via agent teams
ml-ralph init --force         Overwrite template files, keep project data
```

`ml-ralph init` and the TUI's first launch both go through `initRalph` (`src/infrastructure/ralph/init.ts`). It creates:

- `.ml-ralph/RALPH.md` (agent prompt), `prd.json`, `kanban.json`, `log.jsonl`, `config.json`, `runs/active.json`, `chat/`
- `CLAUDE.md` and `AGENTS.md` in the project root
- `.claude/skills/ml-ralph/SKILL.md` and `.codex/skills/ml-ralph/SKILL.md`
- with `--teams`, `.claude/settings.json` with agent teams enabled

## The `.ml-ralph/` Files

| File               | Format | Written by                             | Purpose                                                    |
| ------------------ | ------ | -------------------------------------- | ---------------------------------------------------------- |
| `RALPH.md`         | MD     | `init`                                 | The agent's instructions                                   |
| `prd.json`         | JSON   | `init` (empty draft), then the agent   | The destination: problem, goal, success criteria, scope    |
| `kanban.json`      | JSON   | `init` (empty), then the agent         | The journey: current focus, up next, backlog, completed, abandoned |
| `log.jsonl`        | JSONL  | the agent and `RalphRunner`            | Append-only event log; everything the TUI shows comes from it |
| `config.json`      | JSON   | `init`                                 | Project config (name, W&B project, agent and runtime settings) |
| `runs/active.json` | JSON   | `init` (`{"jobs": []}`)                | Active training jobs, read by the store                    |

`JsonFileStore` can also read `learnings.jsonl`, `research.jsonl` and `runs/history.jsonl` when they exist. The agent does not write them. It logs learnings, research and experiments as events in `log.jsonl`.

### The agent's loop

The agent alternates between four phases, logged as `phase` events:

```
UNDERSTAND → STRATEGIZE → EXECUTE → REFLECT
```

Other event types in `log.jsonl` include `thinking`, `mental_model`, `research`, `path_analysis`, `hypothesis`, `experiment`, `learning`, `decision`, `strategic_retreat`, `prd_updated`, `kanban_updated` and `parallel_*` events for agent teams. The TypeScript interfaces are at the bottom of `templates.ts`. The same events are documented in the `ralph-log-events` skill, and the file schemas are in the `ralph-file-schemas` skill. Change them together.

Experiment events can carry `wandb_run_id` and `wandb_url`, and the experiments panel shows them. The agent is told to track every training run in W&B (using offline mode if the user is not logged in). The app has no W&B API client.

### User control

- Hints (`h`) are queued in the runner and added to the next iteration's prompt.
- The agent stops when it prints `<project_complete>` or the iteration limit is reached.
- The agent runs with `--dangerously-skip-permissions`, so run it in a project where that is acceptable.

## Source Layout

```
src/
├── index.tsx                    # CLI entry: help, init, tmux re-launch, render <App>
├── ui/
│   ├── app.tsx                  # Modes, dialogs, shortcuts, orchestrator wiring
│   ├── ink.tsx                  # Ink-compatible Box/Text/useInput on OpenTUI
│   ├── screens/                 # planning, monitor, output
│   ├── widgets/                 # knowledge panel, kanban, hypotheses, experiments, activity feed, ...
│   ├── hooks/                   # use-log-stream, use-ralph-state, use-tmux-layout, use-tmux-pane, ...
│   └── theme/colors.ts
├── application/
│   ├── orchestrator/            # DefaultOrchestrator (wraps RalphRunner)
│   └── state/                   # zustand store
├── domain/
│   ├── types/                   # PRD, Story, Learning, Research, Job, Kanban, Config, enums
│   └── validation/              # PRD and learning validation
└── infrastructure/
    ├── ralph/                   # runner, init, log-parser, templates
    ├── tmux/                    # TmuxManager, TmuxLayoutManager
    └── file-store/              # JsonFileStore
```

## Development

- Install: `bun install --frozen-lockfile`
- Run: `bun run dev` (needs tmux and an authenticated `claude` CLI)
- Check: `bun run check` (Biome and `tsc --noEmit`)
- Test: `bun test` (the tmux tests need a real tmux binary)
- Do not edit `version` in `package.json`; `.husky/post-commit` bumps it.

## Key Files

- `src/index.tsx`: entry point
- `src/ui/app.tsx`: main component
- `src/application/orchestrator/orchestrator.ts`: `DefaultOrchestrator`
- `src/infrastructure/ralph/runner.ts`: the agent loop
- `src/infrastructure/ralph/templates.ts`: agent prompts and log event types
- `src/infrastructure/ralph/log-parser.ts`: log, PRD and kanban parsing
- `docs/knowledge/CLAUDE_CLI_STREAM_JSON.md`: notes on the stream-json protocol
