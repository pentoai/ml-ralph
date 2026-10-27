# Getting Started with ML-Ralph

> Your autonomous ML engineering companion with a visual TUI

ML-Ralph is a terminal-based tool that helps you run autonomous ML experiments. It combines an AI agent (Ralph) with a real-time dashboard to track hypotheses, experiments, and learnings.

---

## Table of Contents

1. [Installation](#installation)
2. [Quick Start](#quick-start)
3. [Understanding the Interface](#understanding-the-interface)
4. [Working with Ralph](#working-with-ralph)
5. [Keyboard Shortcuts](#keyboard-shortcuts)
6. [The RALPH Cognitive Model](#the-ralph-cognitive-model)

---

## Installation

### Prerequisites

- [Bun](https://bun.sh) (v1.0 or higher)
- A terminal that supports 256 colors (iTerm2, Kitty, Alacritty, etc.)
- tmux (installed automatically if missing)

### Install

```bash
# Clone the repository
git clone https://github.com/your-org/ml-ralph.git
cd ml-ralph

# Install dependencies
bun install

# Build the CLI
bun run build
```

<!-- 📸 SCREENSHOT: Terminal showing successful installation -->

---

## Quick Start

### 1. Initialize a new ML project

```bash
# Navigate to your ML project directory
cd ~/my-kaggle-competition

# Initialize ml-ralph
mlr init
```

This creates a `.ml-ralph/` folder with:
- `prd.json` - Your project requirements document
- `kanban.json` - The working plan and task board
- `log.jsonl` - Event log (append-only memory)

<!-- 📸 SCREENSHOT: Terminal after running `mlr init` showing created files -->

### 2. Set the sealed holdout path (optional but recommended)

ML-Ralph scores each candidate once on a holdout split the agent never sees, and compares it with the search score. The holdout path is not part of the project: it lives in a user-level config, `~/.config/ml-ralph/config.json` (or `$XDG_CONFIG_HOME/ml-ralph/config.json`), keyed by the project's absolute path:

```json
{
  "projects": {
    "/home/me/my-kaggle-competition": { "holdout_path": "/data/sealed/my-kaggle-holdout.parquet" }
  }
}
```

- `holdout_path` must be an absolute path that exists. If the file, the project entry or the path is missing, the runner reports an error naming the file and the key.
- The runner passes the path only to your `evaluate.py`, as the `ML_RALPH_HOLDOUT_PATH` environment variable, when it runs it with `--split holdout`. Read the data from there; never copy it into the project or put it in `contract.json`.
- Each eval is scored on the holdout at most once. The result is recorded outside the project, next to `~/.config/ml-ralph/config.json`, so the agent cannot read it from project files. A gap above `holdout_gap_threshold` in `contract.json` logs an `overfitting` event (no scores) and blocks the candidate.
- The holdout must live outside the project directory. A `holdout_path` inside it (also through a symlink) is refused with an error naming the file and the key.
- While a run is active the runner checks every tool call the agent makes. A call whose input contains the holdout path or the path of `~/.config/ml-ralph/config.json` (also in symlink-resolved form) kills the `claude` session (and what it started) and ends the run with reason `holdout_access`; the TUI shows it and `log.jsonl` gets a `holdout_access` event naming the tool. This detects an obvious read, it does not sandbox the agent (see [ARCHITECTURE.md](./ARCHITECTURE.md#holdout-access-guard)), so keep the holdout somewhere the agent has no reason to look.

### 3. Launch the TUI

```bash
mlr
```

This opens the ML-Ralph dashboard in a tmux session.

<!-- 📸 SCREENSHOT: Initial TUI view showing the Planning mode with empty PRD -->

### 4. Start the agent

Press `s` to start Ralph. The agent will:
1. Read your PRD and understand the problem
2. Research similar problems and solutions
3. Form hypotheses and run experiments
4. Learn and iterate

<!-- 📸 SCREENSHOT: TUI with agent running, showing output in the terminal pane -->

---

## Understanding the Interface

The TUI is split into two main areas:

```
┌─────────────────────────────────────────────────────────────┐
│  [Planning]  [Monitor]                          Mode Tabs   │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  ┌─────────────────────┐  ┌─────────────────────────────┐  │
│  │                     │  │                             │  │
│  │   Knowledge Panel   │  │     Terminal / Agent        │  │
│  │   (Left Side)       │  │     Output (Right Side)     │  │
│  │                     │  │                             │  │
│  └─────────────────────┘  └─────────────────────────────┘  │
│                                                             │
│  [Status Bar]                                    s:start    │
└─────────────────────────────────────────────────────────────┘
```

<!-- 📸 SCREENSHOT: Full TUI with labels pointing to each section -->

### Knowledge Panel Tabs

The left panel has 5 tabs (press `1-5` to switch):

| Tab | Key | Description |
|-----|-----|-------------|
| **PRD** | `1` | Project requirements, goals, constraints |
| **Kanban** | `2` | Current focus, up next, backlog, completed |
| **Learnings** | `3` | Insights discovered during experiments |
| **Research** | `4` | External sources and references |
| **Hypotheses** | `5` | All hypotheses with their status |

<!-- 📸 SCREENSHOT: Each tab shown (could be a 5-panel collage or GIF) -->

### The Kanban Board

The Kanban tab shows Ralph's working plan:

```
┌──────────────────────────────────────┐
│  1  Focus   2  Next   15  Backlog    │  ← Pipeline summary
│  Progress: ████████░░░░ 8/15         │  ← Visual progress
├──────────────────────────────────────┤
│  CURRENT FOCUS ──────────────────    │
│  ╔══════════════════════════════╗    │
│  ║ ▶ Investigate feature X      ║    │  ← What Ralph is doing NOW
│  ║   ID: T-007  Phase: EXECUTE  ║    │
│  ╚══════════════════════════════╝    │
├──────────────────────────────────────┤
│  UP NEXT (3) ────────────────────    │
│  ┌─ 1  Validate on holdout set       │  ← Next 5 planned tasks
│  ├─ 2  Try ensemble approach         │
│  └─ 3  Submit to leaderboard         │
├──────────────────────────────────────┤
│  ▶ BACKLOG  15  ideas (press b)      │  ← Collapsed by default
│  ▶ COMPLETED  8  done (press c)      │  ← Collapsed by default
└──────────────────────────────────────┘
```

<!-- 📸 SCREENSHOT: Kanban tab with a real example showing focus, up next, and collapsed sections -->

Press `b` to expand/collapse the backlog, `c` for completed tasks.

<!-- 📸 SCREENSHOT: Kanban with backlog expanded -->

---

## Working with Ralph

### The PRD (Project Requirements Document)

Before starting, edit your PRD to define:

```json
{
  "project": "Higgs Boson Detection",
  "goal": "Classify particle collision events",
  "success_criteria": "AUC > 0.85 on private leaderboard",
  "constraints": ["8 hour training budget", "No external data"],
  "status": "approved"
}
```

Ralph reads this to understand what you're trying to achieve.

<!-- 📸 SCREENSHOT: PRD tab showing a filled-out PRD -->

### Monitoring Progress

Switch to **Monitor** mode (press `m`) to see:
- Real-time agent output
- Current experiment status
- Resource usage

<!-- 📸 SCREENSHOT: Monitor mode with agent actively running an experiment -->

### Stopping the Agent

Press `x` to stop Ralph. A confirmation dialog will appear.

<!-- 📸 SCREENSHOT: Stop confirmation dialog -->

---

## Keyboard Shortcuts

### Global

| Key | Action |
|-----|--------|
| `q` | Quit ML-Ralph |
| `s` | Start agent |
| `x` | Stop agent |
| `?` | Show help |

### Navigation

| Key | Action |
|-----|--------|
| `1-5` | Switch knowledge panel tabs |
| `p` | Planning mode |
| `m` | Monitor mode |
| `j/k` | Scroll down/up |
| `J/K` | Scroll down/up (in expanded sections) |

### Kanban Controls

| Key | Action |
|-----|--------|
| `b` | Toggle backlog expansion |
| `c` | Toggle completed expansion |
| `Shift+J` | Scroll down in expanded section |
| `Shift+K` | Scroll up in expanded section |

<!-- 📸 SCREENSHOT: Help overlay or cheatsheet if one exists -->

---

## The RALPH Cognitive Model

Ralph thinks like a senior ML engineer, following a deliberate cognitive process:

```
    ┌─────────────┐
    │ UNDERSTAND  │  ← 70% of effort here
    │ Read, research, build mental model
    └──────┬──────┘
           │
    ┌──────▼──────┐
    │ STRATEGIZE  │  ← 20% of effort
    │ Form hypotheses, plan experiments
    └──────┬──────┘
           │
    ┌──────▼──────┐
    │   EXECUTE   │  ← 10% of effort
    │ Run the experiment
    └──────┬──────┘
           │
    ┌──────▼──────┐
    │   REFLECT   │
    │ Learn, update beliefs, adapt plan
    └─────────────┘
```

### Why This Matters

> "One hour of reading what others have learned can save ten hours of experiments that others have already proven don't work."

Ralph spends most of its cognitive effort **understanding** before executing. This mimics how experienced MLEs work - they run fewer, better-chosen experiments because they think more deeply first.

<!-- 📸 SCREENSHOT: Agent output showing UNDERSTAND phase with research being done -->

---

## File Structure

```
your-project/
├── .ml-ralph/
│   ├── prd.json       # Your project requirements
│   ├── kanban.json    # Working plan and tasks
│   └── log.jsonl      # Event log (Ralph's memory)
├── data/
├── notebooks/
└── src/
```

The `.ml-ralph/` folder is Ralph's workspace. You can:
- Edit `prd.json` to change goals
- Read `log.jsonl` to see all events
- View `kanban.json` to see the current plan

---

## Next Steps

1. **Try it on a Kaggle competition** - Great for bounded ML problems
2. **Read the log** - `cat .ml-ralph/log.jsonl | jq` to see Ralph's thinking
3. **Customize the PRD** - Add specific constraints for your domain

---

## Troubleshooting

### "No kanban.json found"

Run `mlr init` to initialize the project, or start the agent - it will create the files automatically.

### Agent seems stuck

Check the terminal pane for errors. You can stop (`x`) and restart (`s`) the agent.

### Colors look wrong

Ensure your terminal supports 256 colors. Try iTerm2 or Kitty for best results.

---

## Getting Help

- **GitHub Issues**: [Report bugs or request features](https://github.com/your-org/ml-ralph/issues)
- **Discussions**: [Ask questions](https://github.com/your-org/ml-ralph/discussions)

---

*Happy experimenting!* 🧪
