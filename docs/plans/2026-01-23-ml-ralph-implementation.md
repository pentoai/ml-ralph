# ML-Ralph Implementation Plan

> **For Codex:** Execute this plan task-by-task. If an `executing-plans` skill is installed, use it; otherwise follow the steps manually.

**Goal:** Create a new ML-centric Ralph repo that keeps the same loop but embeds ML engineer heuristics and a dynamic PRD backlog.

**Architecture:** Copy the original Ralph repo as a base, switch to Claude-only, and rewrite prompts/skills/docs to be ML-centric and stack-agnostic. Add dynamic PRD refinement rules and an ML-specific PRD schema.

**Tech Stack:** Bash, Markdown, JSON, React Flow (Vite/React/TS) for flowchart.

**Files to Understand:**

- None — this is a new repo initialized from a template.

---

### Task 1: Scaffold the repo from Ralph

**Files:**

- Create: repo files copied from `../ralph`
- Remove: `prompt.md`
- Modify: script name and references

**Step 1: Copy base files**

Run:
```bash
rsync -a --delete --exclude '.git' /Users/joaquincamponario/Documents/Personal/ralph/ /tmp/ml-ralph-worktree/
```
Expected: repo tree matches Ralph baseline.

**Step 2: Remove Amp artifacts**

Run:
```bash
rm -f /tmp/ml-ralph-worktree/prompt.md
```
Expected: `prompt.md` no longer exists.

**Step 3: Rename the loop script**

Run:
```bash
mv /tmp/ml-ralph-worktree/ralph.sh /tmp/ml-ralph-worktree/ml-ralph.sh
```
Expected: `ml-ralph.sh` exists at repo root.

**Step 4: Commit**

Run:
```bash
git -C /tmp/ml-ralph-worktree add -A
git -C /tmp/ml-ralph-worktree commit -m "chore: scaffold ml-ralph from ralph"
```
Expected: clean working tree.

---

### Task 2: Update CLAUDE.md and AGENTS.md (ML-centric rules)

**Files:**

- Modify: `CLAUDE.md`
- Modify: `AGENTS.md`

**Step 1: Update CLAUDE.md with ML Engineer Brain + tooling rules**

Edit `CLAUDE.md` to include:
- ML Engineer Brain playbook
- Decision tree
- Dynamic PRD refinement rules
- Toolchain rules (uv, ruff, mypy, pytest, loguru, typer, wandb, pydantic, pydantic-settings)

**Step 2: Update AGENTS.md with ML repo nature**

Edit `AGENTS.md` to summarize:
- ML-centric defaults
- Evidence-first iteration
- CLAUDE.md as source of truth

**Step 3: Commit**

```bash
git -C /tmp/ml-ralph-worktree add CLAUDE.md AGENTS.md
git -C /tmp/ml-ralph-worktree commit -m "docs: add ml-centric agent rules"
```

---

### Task 3: Update README and prd.json.example

**Files:**

- Modify: `README.md`
- Modify: `prd.json.example`

**Step 1: Update README.md**

Include:
- ML-Ralph overview
- Claude-only usage
- Dynamic PRD behavior
- ML-specific rules (stack-agnostic)

**Step 2: Update prd.json.example**

Add ML fields:
- `type`, `hypothesis`, `evidenceRequired`, `supersededBy`

**Step 3: Commit**

```bash
git -C /tmp/ml-ralph-worktree add README.md prd.json.example
git -C /tmp/ml-ralph-worktree commit -m "docs: update ml-ralph docs and prd schema"
```

---

### Task 4: Update skills (ML PRD + converter)

**Files:**

- Modify: `skills/prd/SKILL.md`
- Modify: `skills/ralph/SKILL.md`

**Step 1: Update PRD generator skill**

Add ML-specific guidance:
- story types
- evidence-required criteria
- dynamic backlog language
- stack-agnostic but ML-centric defaults

**Step 2: Update converter skill**

Ensure conversion includes:
- new schema fields
- evidence-required criteria
- no Kaggle-specific language

**Step 3: Commit**

```bash
git -C /tmp/ml-ralph-worktree add skills/prd/SKILL.md skills/ralph/SKILL.md
git -C /tmp/ml-ralph-worktree commit -m "docs: add ml-specific skills"
```

---

### Task 5: Update flowchart for ML-Ralph

**Files:**

- Modify: `flowchart/src/App.tsx`
- Modify: `flowchart/src/App.css` (only if needed)

**Step 1: Update labels for ML-Ralph**

Adjust steps to:
- “Define objective + PRD”
- “Convert to prd.json”
- “Run ml-ralph.sh”
- “Pick next story”
- “Run minimal experiment”
- “Log evidence”
- “Refine prd.json”
- “More stories?”

**Step 2: Commit**

```bash
git -C /tmp/ml-ralph-worktree add flowchart/src/App.tsx flowchart/src/App.css
git -C /tmp/ml-ralph-worktree commit -m "feat: update flowchart for ml-ralph"
```

---

### Task 6: Optional verification

**Step 1: Sanity check tree**

```bash
git -C /tmp/ml-ralph-worktree status --short
```
Expected: clean working tree.

**Step 2: (Optional) build flowchart**

```bash
cd /tmp/ml-ralph-worktree/flowchart
npm install
npm run build
```
Expected: build succeeds.

---
