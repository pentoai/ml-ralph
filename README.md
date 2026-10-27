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

## When a run completes

Only the runner ends a run; the agent's `<project_complete>` is ignored. After a promotion whose search score (from the runner's own eval and `metrics.json`) meets the contract's `success_threshold` in the contract's direction, the runner:

1. checks that a `holdout_path` is configured for the project in `~/.config/ml-ralph/config.json` (it is read again at every promotion, so one added mid-run is used next time);
2. runs the independent verifier on the whole diff since the baseline commit;
3. scores the sealed holdout once for that `eval_id`.

The run ends with a `run_complete` event (eval id, search score, holdout score, verifier verdict) only if the verifier approves, the holdout score meets `success_threshold` and the search-holdout gap is within `holdout_gap_threshold`.

Otherwise the run continues. A failed check logs `completion_rejected` with reason `verifier_rejected`, `holdout_failed` or `overfitting_gap`; the agent's next prompt gets the verdict and one line of reason, with no scores. A check that could not run (verifier error or timeout, unreadable holdout, no `holdout_path`) logs `completion_blocked` with the error or reason `holdout_not_configured`, and the TUI shows it in the agent output (`Completion blocked for <eval_id>: holdout_not_configured (...)`; the `completion gate` tests in `src/infrastructure/ralph/runner.test.ts` assert that line). The check runs again only on a later promotion.

## Run budgets

By default a run is limited only by the iteration count. Add any of these optional keys to `.ml-ralph/config.json` to cap it further; an unset key is not enforced.

```json
{
  "max_wall_clock_minutes": 240,
  "max_usd": 25,
  "max_experiments_per_iteration": 3
}
```

- `max_wall_clock_minutes` — minutes of wall-clock time for the run. A timer checks it during the iteration and stops the claude process when it is reached.
- `max_usd` — dollars spent, summed from `total_cost_usd` in claude's `result` events (an API-equivalent estimate, not a subscription bill). Checked at each result event, so one iteration's overshoot is possible.
- `max_experiments_per_iteration` — `ml-ralph eval` calls per iteration. Once reached, further calls exit non-zero with `experiment cap reached for this iteration (<n>)`.

When `max_wall_clock_minutes` or `max_usd` is reached the run ends with reason `budget_exhausted`, logged in `log.jsonl`. After each iteration the runner logs a `budget_status` event (`usd_spent`, `elapsed_minutes` and the caps); an iteration with no `total_cost_usd` counts as $0 and logs `budget_warning`. Each iteration's prompt states the remaining USD and minutes and the experiment cap, and the TUI shows spend and elapsed time against the caps (or `no cap`).

A restarted run keeps its `run_id` (in `.ml-ralph/budget/run.json`) and starts from the spend and elapsed time in its earlier `budget_status` events, so a restart does not reset the budget; the id is dropped when the run ends with `max_iterations`. Raise a cap in `config.json` to continue after `budget_exhausted`. A negative, zero or non-numeric cap stops the run at start with an error naming the key. GPU-hours are not capped yet.

## License

MIT
