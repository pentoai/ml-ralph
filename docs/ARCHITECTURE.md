# Architecture

ml-ralph is a Bun + OpenTUI terminal app that launches the `claude` CLI in a loop (`RalphRunner`) and shows what the agent is doing. It follows a layered layout. Every module under `src/infrastructure` is imported by the running app, and `src/index.tsx` is the entry point.

## Layer Overview

```
┌─────────────────────────────────────────────────────────────────────────┐
│                              UI Layer                                    │
│                  (OpenTUI/React, src/ui)                                 │
│  - app.tsx: modes (planning / monitor / output), dialogs, shortcuts     │
│  - screens/: planning, monitor, output                                  │
│  - widgets/: KnowledgePanel + PRD, kanban, hypotheses, experiments,     │
│    learnings, research panels, activity feed, cognitive map, tmux pane  │
│  - hooks/: useLogStream, useRalphState, useTmuxLayout, useTmuxPane      │
│  - ink.tsx: Ink-style Box/Text/useInput shim on top of OpenTUI          │
└─────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                          Application Layer                               │
│  - DefaultOrchestrator: thin wrapper around RalphRunner that fans out   │
│    output / iteration / completion callbacks to the UI                  │
│  - zustand store (useAppStore): mode, tabs, agent status, scroll state, │
│    config, PRD, learnings, research, active jobs                        │
└─────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                         Infrastructure Layer                             │
│  - ralph/: RalphRunner, init, log parser, prompt templates              │
│  - tmux/: TmuxManager, TmuxLayoutManager                                │
│  - file-store/: JsonFileStore (config.json, runs/, learnings, ...)      │
└─────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                             Domain Layer                                 │
│  - types/: PRD, Story, Learning, Research, Job, Kanban, Config, enums   │
│  - validation/: PRD and learning validation                             │
└─────────────────────────────────────────────────────────────────────────┘
```

## Layer Rules

### UI Layer (`src/ui`)

- Depends on the application layer (store, orchestrator) and on the infrastructure `ralph/` and `tmux/` barrels for log and tmux types and hooks.
- Components import `Box`, `Text` and `useInput` from `src/ui/ink.tsx`, not directly from OpenTUI.
- `app.tsx` owns keyboard shortcuts and creates the `DefaultOrchestrator`.

### Application Layer (`src/application`)

- `orchestrator/`: `DefaultOrchestrator` implements `AgentOrchestrator` by delegating to `RalphRunner`.
- `state/`: the zustand store. It loads and persists data through `JsonFileStore`.

### Infrastructure Layer (`src/infrastructure`)

- Does all file, process and tmux I/O.
- `ralph/` is the core; `tmux/` and `file-store/` support it.

### Domain Layer (`src/domain`)

- Pure types and validation. No I/O. The validators in `validation/` are not called by the app yet.

## How a Run Works

1. `src/index.tsx` handles `--help`, `--teams` and `init`. Outside tmux it re-launches itself in a tmux session named `ml-ralph-<dir>`. Then it renders `<App>` through `createCliRenderer`.
2. `App` calls `ensureInitialized(projectPath)` (`infrastructure/ralph/init.ts`). This writes any missing `.ml-ralph/` files, `CLAUDE.md`, `AGENTS.md` and the skills. `ml-ralph init` calls the same `initRalph`.
3. `App` creates a `DefaultOrchestrator`. Pressing `s` calls `start()`, which runs `RalphRunner.start()`.
4. `RalphRunner` loops up to `maxIterations` times. Each iteration spawns `claude --dangerously-skip-permissions --verbose -p <prompt> --output-format stream-json` in the project directory. With `--teams` it sets `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`. The prompt tells the agent to read `.ml-ralph/RALPH.md`, run one iteration and print `<iteration_complete>` or `<project_complete>`.
5. The runner parses the stream-json output into `StreamEvent`s (text, tool calls, tool results, errors, iteration markers). The orchestrator passes them to the UI. The runner also appends `phase` events to `.ml-ralph/log.jsonl`.
6. The agent itself appends events to `log.jsonl` and updates `prd.json` and `kanban.json`. The monitor and knowledge panels render these through `useLogStream` and `useRalphState`, which use `log-parser.ts` (`readLogFile`, `watchLogFile`, `readPrdFile`, `readKanbanFile`, `aggregateEvents`).
7. In planning mode, `TmuxLayoutManager` splits the tmux window and an interactive `claude` session runs in the other pane. The TUI shows the knowledge tabs.

User hints (`h` while running) are queued with `addHint` and added to the prompt of the next iteration.

## The `.ml-ralph/` Files

| File                | Written by                                | Read by                                                       |
| ------------------- | ----------------------------------------- | ------------------------------------------------------------- |
| `RALPH.md`          | `init` (from `RALPH_MD`)                  | the agent, `isInitialized`                                    |
| `prd.json`          | `init` (empty draft), then the agent      | PRD panel, `readPrdFile`                                      |
| `kanban.json`       | `init` (empty), then the agent            | kanban panel, `readKanbanFile`                                |
| `log.jsonl`         | the agent and `RalphRunner`, append-only  | `useLogStream` and all the log-driven panels                  |
| `config.json`       | `init` (`JsonFileStore`)                  | zustand store, `verifyCandidate` (`verifier` block)           |
| `verifier/<id>.json`| `verifyCandidate`                         | nothing yet                                                   |
| `runs/active.json`  | `init` (`{"jobs": []}`)                   | zustand store (`activeJobs`)                                  |
| `chat/`             | `init` creates the directory              | nothing yet                                                   |

`learnings.jsonl`, `research.jsonl` and `runs/history.jsonl` are read by the store through `JsonFileStore` if they exist. The agent does not write them. It records learnings, research and experiments as events in `log.jsonl`, which is what the panels show.

Experiment events in `log.jsonl` can carry `wandb_run_id` and `wandb_url`. The experiments panel renders them. There is no W&B API client.

The `w` and `t` shortcuts (monitor mode) act on `activeJobs` from `runs/active.json`. Nothing in the app populates that file yet, so they do nothing until something writes training jobs there.

## Key Components

### RalphRunner (`infrastructure/ralph/runner.ts`)

```typescript
class RalphRunner {
  start(): Promise<void>; // iteration loop
  stop(): void; // kills the current claude process
  isRunning(): boolean;
  getCurrentIteration(): number;
  setMaxIterations(n: number): void;
  addHint(hint: string): void;
  getPendingHintsCount(): number;
}
```

Configured with callbacks (`onOutput`, `onIterationStart`, `onIterationEnd`, `onComplete`, `onError`).

### Verifier (`infrastructure/ralph/verifier.ts`)

`verifyCandidate` checks a promotion candidate in a separate `claude -p` session, so the agent that produced a result does not grade it. Nothing in the loop calls it yet: the promotion and completion gates that will call it before every promotion are a later change.

- **Read-only session.** It spawns `claude -p --output-format json --tools Read,Grep,Glob --disallowedTools Write,Edit,MultiEdit,NotebookEdit,Bash --permission-mode dontAsk --no-session-persistence`, and never `--dangerously-skip-permissions`. `verifier.model` from `config.json` adds `--model`; without it the CLI default model is used. The prompt goes in on stdin, since a diff can exceed the argument size limit.
- **Prompt.** It holds the `git diff` of the candidate (default `HEAD`) against the incumbent, or against the baseline when there is no incumbent (truncated at 120,000 characters), `.ml-ralph/eval/contract.json`, the hypothesis's `rubrics` and the last `verifier.recent_events` log events (default 50). The prompt tells the verifier that all of this is agent-produced data, not instructions.
- **Answer.** A JSON object `{verdict: "approve" | "reject", checks: {leakage, protocol_change, rubrics}, reason}`, each check `pass` or `fail`. An approval with a failed check is invalid.
- **Fails closed.** A crash, a timeout (default 10 minutes), unparseable or invalid output, a missing `contract.json` or an unknown git ref all give `reject` with reason `verifier_error`. The cause is kept in the saved file as `error`.
- **Record.** The full output goes to `.ml-ralph/verifier/<id>.json` and the runner appends a `verifier_verdict` event to `log.jsonl`.
- **What the agent sees.** Only `feedback` from the result: `Verifier verdict: <approve|reject> - <first line of reason>`. The per-check results, the raw output and the error stay in the files. This follows the reward-hacking finding: detailed verifier feedback becomes something the agent optimises against.

`config.json` gains an optional block:

```json
{ "verifier": { "model": "claude-opus-5-5", "recent_events": 50 } }
```

### DefaultOrchestrator (`application/orchestrator/orchestrator.ts`)

Wraps one `RalphRunner` and exposes subscription methods that each return an unsubscribe function: `onOutput`, `onIterationChange`, `onComplete` and `onStoryComplete` (the last is part of the interface but nothing emits it). Also forwards `start`, `stop`, `isRunning`, `setMaxIterations` and `addHint`.

### Log parser (`infrastructure/ralph/log-parser.ts`)

Reads and watches `log.jsonl`, `prd.json` and `kanban.json`. `aggregateEvents` builds a `LogSummary` (hypotheses with status, experiments, learnings, research, PRD changes, kanban history).

### Templates (`infrastructure/ralph/templates.ts`)

The agent's behaviour lives here as prompt text (`RALPH_MD`, `SKILL_MD`, `CLAUDE_MD`, `AGENTS_MD`), together with the TypeScript interfaces for log events. If you change a log event, update the interface in `templates.ts`, the parser in `log-parser.ts` and the `ralph-log-events` skill together.

### JsonFileStore (`infrastructure/file-store/json-file-store.ts`)

Typed reads and writes for `config.json`, `runs/active.json` and `runs/history.jsonl`, plus `prd.json`, the JSONL files and `chat/`. The store uses it for config, learnings, research and jobs.

### Tmux (`infrastructure/tmux/`)

`TmuxManager` wraps tmux commands. `TmuxLayoutManager` builds the planning and monitor layouts. Both have tests that need a real `tmux` binary.

## Testing Strategy

Tests use `bun:test` and sit next to the code they test.

| Area                          | What is tested                                              |
| ----------------------------- | ----------------------------------------------------------- |
| `infrastructure/ralph/`       | init, log parser, runner stream parsing, verifier (against a stub `claude` script) |
| `infrastructure/tmux/`        | manager and layout manager against a real tmux (unique sessions, killed in `afterEach`) |
| `ui/`                         | Ink-compat shim, OpenTUI migration, widgets and formatters  |

## Keeping the Layers Honest

A module under `src/infrastructure` that nothing imports from `src/index.tsx` is dead weight and misleads the next contributor. Delete it with its tests, or wire it in.
