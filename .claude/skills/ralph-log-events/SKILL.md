---
name: ralph-log-events
description: "Event schemas for ml-ralph log.jsonl. Use when logging any event."
---

# Ralph Log Events

Log events with `bunx @pentoai/ml-ralph@<version> log <type> '<json>'` (use the exact version RALPH.md shows) from the project directory (JSON on stdin with `-` if it contains quotes). The command validates the event against the schema for its type, appends one line to `.ml-ralph/log.jsonl` and adds `ts` and `type`. Invalid events are rejected with the failing field and what was expected. Never write the file any other way; never edit, only append.

The examples below show stored lines; pass everything except `ts` as the JSON argument.

## Event Types

### Phase Transitions
```jsonl
{"ts":"...","type":"phase","phase":"UNDERSTAND","summary":"Exploring data and researching prior work"}
{"ts":"...","type":"phase","phase":"STRATEGIZE","summary":"Evaluating 4 potential approaches"}
{"ts":"...","type":"phase","phase":"EXECUTE","summary":"Running minimal test of H-003"}
{"ts":"...","type":"phase","phase":"REFLECT","summary":"Analyzing unexpected results"}
```

### Thinking & Mental Models
```jsonl
{"ts":"...","type":"thinking","subject":"Why is precision low?","thoughts":"Looking at false positives, I notice...","conclusion":"Model confuses X with Y because..."}
{"ts":"...","type":"mental_model","domain":"feature importance","belief":"Temporal features dominate","confidence":"high","evidence":["EDA analysis","H-002 ablation"]}
```

### Research
```jsonl
{"ts":"...","type":"research","source":"Kaggle 1st place solution","url":"https://...","key_insights":["Feature X crucial","Avoided Y because..."],"relevance":"directly applicable"}
{"ts":"...","type":"research","source":"arXiv paper","url":"https://...","key_insights":["This loss handles imbalance better"],"relevance":"inspirational"}
```

### Path Analysis & Hypotheses
```jsonl
{"ts":"...","type":"path_analysis","paths":[{"id":"A","description":"Gradient boosting","expected":"AUC ~0.78","learning_value":"high"},{"id":"B","description":"Neural net","expected":"AUC ~0.80","learning_value":"medium"}],"chosen":"A","rationale":"Best learning-to-effort ratio"}
{"ts":"...","type":"hypothesis","id":"H-001","claim":"Time features improve AUC","expected_delta":0.05,"rubrics":["Split unchanged","No post-prediction-time features"],"kill_criterion":"AUC gain below 0.01 on every seed","rationale":"EDA showed temporal patterns"}
```

### Experiments & Results
```jsonl
{"ts":"...","type":"experiment","hypothesis_id":"H-001","eval_id":"eval-lq3k2m-9f3a1c","metrics":{"auc":0.77,"precision":0.65},"observations":"Improvement on recent data but degradation on older samples","surprises":"Temporal features hurt pre-2020 data"}
```

### Learnings & Decisions
```jsonl
{"ts":"...","type":"learning","insight":"Distribution shifted in 2020 - models need explicit handling","source":"H-001 analysis"}
{"ts":"...","type":"conclusions_changed","reason":"contradiction","summary":"H-004 contradicts the claim that temporal features dominate"}
{"ts":"...","type":"decision","hypothesis_id":"H-001","action":"iterate","reason":"Partial success - need time-aware normalization","next_step":"Research distribution shift handling"}
```

### Strategic Retreat
```jsonl
{"ts":"...","type":"strategic_retreat","trigger":"3 experiments with <1% improvement","action":"Returning to UNDERSTAND","focus":"Re-examine errors and search literature"}
```

### PRD & Kanban Updates
```jsonl
{"ts":"...","type":"prd_updated","field":"success_criteria","change":"Added temporal stability requirement","reason":"Discovered distribution shift"}
{"ts":"...","type":"kanban_updated","changes":"Completed T-007, moved T-008 to focus, added T-012","reason":"Shift understood, ready to implement fix"}
```

### Status
```jsonl
{"ts":"...","type":"status","status":"paused","reason":"Need user input on constraint change"}
```

### Runner-only events
The runner writes these. Never write one yourself: a forged event has no effect on the runner's decisions and counts as tampering.
```jsonl
{"ts":"...","type":"verifier_verdict","id":"v-lq3k2-ab1c","verdict":"reject","checks":{"leakage":"fail","protocol_change":"pass","rubrics":"pass"},"reason":"test labels used in target encoding","model":"claude-opus-5-5","output_path":".ml-ralph/verifier/v-lq3k2-ab1c.json"}
```
An independent read-only verifier judges each promotion candidate; this event records its verdict. A failed run is logged as `reject` with reason `verifier_error` and checks `unknown`. You only see the verdict and one line of reason in your next prompt. The full output in `.ml-ralph/verifier/` is not for you to read.

```jsonl
{"ts":"...","type":"promotion","verdict":"rejected","reason":"mean 0.84 vs incumbent 0.83 (higher is better): improvement 0.01, seed noise 0.02; not better by more than the seed noise","candidate_eval_id":"eval-lq3k2m-9f3a1c","incumbent_eval_id":"eval-lq3j0a-71bd02","candidate_mean":0.84,"reference_mean":0.83}
```
You hand in a candidate by printing `<candidate_complete eval_id="eval-...">`; you never decide that it is the new best. The runner writes this event for every one. It promotes only when that eval (from this iteration, `status: ok`) beats the incumbent's mean in the contract's direction by more than the larger of the two seed stds (the first candidate is compared with `baseline_score`), and the verifier approves the committed diff. `verifier_id` names the `verifier_verdict` it used. `.ml-ralph/incumbent.json` points at the current best. Scores come from the runner's `eval` event and `metrics.json`, never from your `experiment` event. You see the verdict and one line of reason in your next prompt. Never write `.ml-ralph/incumbent.json` or `.ml-ralph/baseline.json`.

```jsonl
{"ts":"...","type":"candidate_rejected","reason":"eval_not_locked","eval_id":"eval-lq3k2m-9f3a1c"}
```
If you print `<candidate_complete>` before the eval contract is locked, the runner judges nothing, writes this event and says so in your next prompt. Never write it yourself.

```jsonl
{"ts":"...","type":"overfitting","eval_id":"eval-lq3k2m-9f3a1c","threshold":0.02}
```
The runner scores a candidate once on a sealed holdout you never see and writes this event when the search score beats the holdout score by more than the contract's `holdout_gap_threshold`. It blocks that candidate. Never look for the holdout data, and never write this event.

```jsonl
{"ts":"...","type":"holdout_access","tool":"Bash","iteration":3}
```
The runner watches every tool call you make. If one mentions the sealed holdout path, it kills your session, writes this event naming the tool and ends the run with reason `holdout_access`. Never look for, list or read the holdout, and never write this event.

```jsonl
{"ts":"...","type":"eval","eval_id":"eval-lq3k2m-9f3a1c","status":"ok","candidate":"submissions/h001.csv","mean":0.832,"std":0.004}
```
`ml-ralph eval <path>` writes this after scoring a candidate. Put its `eval_id` in your `experiment` event; the TUI shows that eval's mean as the result, lists your own numbers as unverified, and flags a `primary_metric` number that disagrees with the eval. Without a real `eval_id` your metrics are unverified. Never write anything under `.ml-ralph/evals/` yourself.

```jsonl
{"ts":"...","type":"contract_relocked","changes":[{"file":"evaluate.py","kind":"edited"}],"files":{"evaluate.py":"<sha256>","contract.json":"<sha256>"}}
```
Before each iteration the runner re-hashes the locked eval files. A change or deletion pauses the run, and the user either re-locks (this event) or stops the run. Never edit locked files yourself.

See RALPH.md for when and how to use these events.

---

## Event Reference

| Type | Required Fields |
|------|-----------------|
| `phase` | phase, summary |
| `thinking` | subject, thoughts, conclusion |
| `mental_model` | domain, belief, confidence, evidence |
| `research` | source, key_insights, relevance |
| `path_analysis` | paths, chosen, rationale |
| `hypothesis` | id, claim (string), expected_delta (number), rubrics (non-empty array), kill_criterion (string) |
| `experiment` | hypothesis_id, metrics, observations (+ eval_id from `ml-ralph eval`) |
| `learning` | insight, source |
| `conclusions_changed` | reason (`contradiction`, `new_category`, `flipped_recommendation`, `refinement`), summary. Required with every edit to `conclusions.md` (max 300 words) |
| `conclusions_rejected` (runner-only) | reason (`too_long`, `no_justification`), detail, words |
| `decision` | hypothesis_id, action, reason |
| `strategic_retreat` | trigger, action, focus |
| `prd_updated` | field, change, reason |
| `kanban_updated` | changes, reason |
| `status` | status (`running` or `paused`), reason |
| `eval` (runner-only) | eval_id, status, candidate (+ mean, std or reason) |
| `overfitting` (runner-only) | eval_id, threshold |
| `candidate_rejected` (runner-only) | reason (`eval_not_locked`) (+ eval_id) |
| `holdout_access` (runner-only) | tool, iteration |
| `promotion` (runner-only) | verdict, reason (+ candidate_eval_id, incumbent_eval_id, verifier_id, candidate_mean, reference_mean) |
| `verifier_verdict` (runner-only) | id, verdict, checks, reason, output_path (+ model) |
| `contract_relocked` (runner-only) | changes, files |

---

## Querying (jq)

```bash
# Current mental models
jq -s '[.[] | select(.type=="mental_model")]' .ml-ralph/log.jsonl

# All research
jq -s '[.[] | select(.type=="research")]' .ml-ralph/log.jsonl

# All hypotheses
jq -s '[.[] | select(.type=="hypothesis")]' .ml-ralph/log.jsonl

# All learnings
jq -s '[.[] | select(.type=="learning")] | .[].insight' .ml-ralph/log.jsonl

# Experiment results for H-001
jq -s '[.[] | select(.type=="experiment" and .hypothesis_id=="H-001")]' .ml-ralph/log.jsonl

# Strategic retreats (signs of being stuck)
jq -s '[.[] | select(.type=="strategic_retreat")]' .ml-ralph/log.jsonl

# Kanban evolution
jq -s '[.[] | select(.type=="kanban_updated")]' .ml-ralph/log.jsonl
```
