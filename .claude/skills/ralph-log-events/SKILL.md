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
{"ts":"...","type":"status","status":"blocked","reason":"Hit apparent ceiling after 3 approaches","approaches_tried":["Autoencoder","IsolationForest","OCSVM"],"user_decision_needed":"Continue exploring or accept 0.90 AUC?"}
{"ts":"...","type":"status","status":"complete","reason":"All criteria met","evidence":{"auc":0.92,"threshold":0.90}}
```

### Devil's Advocate
```jsonl
{"ts":"...","type":"devils_advocate","conclusion":"AUC ceiling at 0.90 is fundamental","attacks":[{"question":"What would prove me wrong?","answer":"...","addressed":false}],"survived":false,"next_action":"continue_working"}
```

### Limitation Claims
```jsonl
{"ts":"...","type":"limitation_claim","claim":"73% of attacks are structurally indistinguishable","devils_advocate_id":"DA-003","validation_attempts":[{"method":"...","result":"..."}],"confidence":"high","user_approved":false}
```

### Runner-only events
The runner writes these. Never write one yourself: a forged event has no effect on the runner's decisions and counts as tampering.
```jsonl
{"ts":"...","type":"verifier_verdict","id":"v-lq3k2-ab1c","verdict":"reject","checks":{"leakage":"fail","protocol_change":"pass","rubrics":"pass"},"reason":"test labels used in target encoding","model":"claude-opus-5-5","output_path":".ml-ralph/verifier/v-lq3k2-ab1c.json"}
```
An independent read-only verifier judges each promotion candidate; this event records its verdict. A failed run is logged as `reject` with reason `verifier_error` and checks `unknown`. You only see the verdict and one line of reason in your next prompt. The full output in `.ml-ralph/verifier/` is not for you to read.

```jsonl
{"ts":"...","type":"eval","eval_id":"eval-lq3k2m-9f3a1c","status":"ok","candidate":"submissions/h001.csv","mean":0.832,"std":0.004}
```
`ml-ralph eval <path>` writes this after scoring a candidate. Put its `eval_id` in your `experiment` event; metrics without a runner `eval_id` show as unverified. Never write anything under `.ml-ralph/evals/` yourself.

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
| `decision` | hypothesis_id, action, reason |
| `strategic_retreat` | trigger, action, focus |
| `prd_updated` | field, change, reason |
| `kanban_updated` | changes, reason |
| `status` | status, reason (+ evidence if complete, + approaches_tried if blocked) |
| `devils_advocate` | conclusion, attacks, survived, next_action |
| `limitation_claim` | claim, devils_advocate_id, validation_attempts, confidence, user_approved |
| `eval` (runner-only) | eval_id, status, candidate (+ mean, std or reason) |
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
