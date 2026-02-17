# ml-ralph

[![npm version](https://img.shields.io/npm/v/@pentoai/ml-ralph.svg)](https://www.npmjs.com/package/@pentoai/ml-ralph)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

An autonomous ML engineering agent with a terminal user interface. ml-ralph automates the experiment loop — planning, execution, analysis, and learning extraction — so you can iterate on ML projects faster.

You define your goals through a PRD. The agent works through stories autonomously, runs experiments, tracks metrics, and accumulates structured learnings across iterations.

## Getting started

```bash
bunx @pentoai/ml-ralph
```

That's it. Run it inside any ML project directory and the TUI will launch in tmux.

### Requirements

- [Bun](https://bun.sh/) v1.0+
- [tmux](https://github.com/tmux/tmux) (`brew install tmux`)
- [Claude Code](https://docs.anthropic.com/en/docs/claude-code) CLI, installed and authenticated

## The cognitive framework

ml-ralph operates as a paranoid scientist. Its core assumption: results are probably misleading, data is probably corrupted, and conclusions should be broken before they're trusted. It allocates roughly 70% of effort to understanding and verification, 20% to strategy, and 10% to execution.

The agent works through a 4-phase cognitive cycle:

```
UNDERSTAND → STRATEGIZE → EXECUTE → REFLECT
     ↑                                  │
     └──────────────────────────────────┘
```

**Understand** — Verify data integrity (row counts, label distributions, sample inspection). Run exploratory analysis. Research prior art. Build a mental model and explicitly list all assumptions. Nothing happens until this is done.

**Strategize** — Generate 3–5 competing hypotheses. For each: what's expected, why, and what will be learned. Think 5–6 steps ahead. Pick the path with the best learning-to-effort ratio. Run the smallest experiment that tests the hypothesis.

**Execute** — Run the experiment. Log metrics and observations as work happens, not after. Surprises are more valuable than confirmations.

**Reflect** — Verify results are real, not artifacts of bugs, leakage, or evaluation errors. Try to break your own result before trusting it. Then decide:

- Too good? → Verify harder
- Verified and promising? → Strategize next step
- Surprised or confused? → Go back to Understand
- Stuck after 2–3 experiments? → Strategic retreat to Understand
- All success criteria met and verified? → Complete

Strategic retreat — going back to understand when stuck — is a first-class concept, not a failure. Understanding is progress.

## License

MIT
