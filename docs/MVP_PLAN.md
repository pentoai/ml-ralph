# MVP Development Plan

Phased approach to building ml-ralph with vertical slices.

## Principles

1. **Types first**: Define all interfaces before implementation
2. **Vertical slices**: Build complete features end-to-end
3. **Clean boundaries**: Interfaces between layers are sacred
4. **Ship early**: Each phase produces a working (if limited) product

---

## Phase 0: Foundation

**Goal**: All types defined, project structure in place, no implementation.

### Deliverables

- [ ] Project setup (package.json, tsconfig, bun)
- [ ] All domain types (see DATA_MODELS.md)
- [ ] All infrastructure interfaces (not implementations)
- [ ] File layout created (empty files with exports)
- [ ] Basic test setup

### Types to Define

```
src/domain/types/
├── prd.ts           # PRD, Story, SuccessCriterion, DataSource
├── learning.ts      # Learning
├── research.ts      # ResearchItem, CodeSnippet
├── progress.ts      # ProgressEntry, Evidence, BacklogChange
├── job.ts           # TrainingJob
├── config.ts        # ProjectConfig
├── chat.ts          # ChatSession, ChatMessage, ToolCall
├── enums.ts         # All enums
└── index.ts         # Re-exports
```

### Interfaces to Define

```
src/infrastructure/
├── file-store/types.ts      # FileStore interface
├── claude/types.ts          # ClaudeCodeClient, StreamEvent
├── wandb/types.ts           # WandBClient interface
└── process/types.ts         # JobManager interface
```

### Exit Criteria

- `bun run typecheck` passes
- All types importable from `src/domain/types`
- All interfaces importable from respective `src/infrastructure/*/types`

---

## Phase 1: Agent Runs One Story

**Goal**: Can execute a single story and see output in TUI.

### Slice

```
┌─────────────────────────────────────────────────────────────┐
│                     Monitor Screen                          │
│  ┌─────────────────────────────────────────────────────┐    │
│  │                                                     │    │
│  │              Agent Output (streaming)               │    │
│  │                                                     │    │
│  └─────────────────────────────────────────────────────┘    │
│  ┌─────────────────────────────────────────────────────┐    │
│  │  Current: US-001 - Data Exploration                 │    │
│  └─────────────────────────────────────────────────────┘    │
│  [ Stop ]                                                   │
└─────────────────────────────────────────────────────────────┘
```

### Implementation

1. **Infrastructure**:
   - `claude/client.ts`: Spawn CC, stream output
   - `claude/stream-parser.ts`: Parse JSON stream
   - `file-store/json-file-store.ts`: Read prd.json only

2. **Application**:
   - `orchestrator/orchestrator.ts`: Run single story
   - `state/store.ts`: Minimal state (agentOutput, currentStory)

3. **UI**:
   - `screens/monitor.tsx`: Basic monitor screen
   - `widgets/agent-output.tsx`: Streaming output display
   - `widgets/current-task.tsx`: Show current story

### Test Data

Create a sample `.ml-ralph/prd.json` with one story for testing.

### Exit Criteria

- Can start TUI with `bun run dev`
- Loads PRD from `.ml-ralph/prd.json`
- Executes first story via Claude Code
- Shows streaming output in TUI
- Can stop execution

---

## Phase 2: PRD Creation

**Goal**: Can create PRD via chat in Planning mode.

### Slice

```
┌─────────────────────────────────────────────────────────────┐
│  [Planning] [Monitor]                                       │
├─────────────────────────────────────────────────────────────┤
│                     Planning Screen                         │
│  ┌───────────────────────────────────────────────────────┐  │
│  │                                                       │  │
│  │                 Claude Code Chat                      │  │
│  │                                                       │  │
│  │  User: I want to build a churn prediction model      │  │
│  │                                                       │  │
│  │  Assistant: Great! Let me ask a few questions...     │  │
│  │                                                       │  │
│  └───────────────────────────────────────────────────────┘  │
│  ┌───────────────────────────────────────────────────────┐  │
│  │  > Type your message...                              │  │
│  └───────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────┘
```

### Implementation

1. **Infrastructure**:
   - `prompts/prd-creation.ts`: PRD creation system prompt
   - `file-store`: Add chat session read/write

2. **Application**:
   - `commands/create-prd.ts`: Handle PRD creation flow
   - `state/store.ts`: Add chatMessages, mode

3. **UI**:
   - `app.tsx`: Add mode switching (Planning/Monitor tabs)
   - `screens/planning.tsx`: Planning screen
   - `widgets/chat-panel.tsx`: Chat interface with input

### Exit Criteria

- Can switch between Planning and Monitor modes
- Can chat with Claude Code in Planning mode
- Claude Code outputs PRD as JSON
- PRD is saved to `.ml-ralph/prd.json`
- Chat history persists

---

## Phase 3: Learnings

**Goal**: Agent extracts learnings, visible in UI.

### Slice

Add to Planning screen:

```
┌─────────────────────────────────────────────────────────────┐
│                     Planning Screen                         │
│  ┌─────────────────────┬───────────────────────────────────┐│
│  │                     │  [Learnings] [Research] [Stories] ││
│  │   Claude Code       │  ┌─────────────────────────────┐  ││
│  │   Chat              │  │ 🔴 HIGH  L-001  data        │  ││
│  │                     │  │ Target has 23% label noise  │  ││
│  │                     │  │ → Clean labels before train │  ││
│  │                     │  │                             │  ││
│  │                     │  │ 🟡 MED   L-002  model       │  ││
│  │                     │  │ XGBoost beats NN on small   │  ││
│  │                     │  └─────────────────────────────┘  ││
│  └─────────────────────┴───────────────────────────────────┘│
└─────────────────────────────────────────────────────────────┘
```

### Implementation

1. **Infrastructure**:
   - `file-store`: Add learnings read/write
   - `prompts/story-execution.ts`: Update to extract learnings

2. **Application**:
   - `state/store.ts`: Add learnings array
   - Parse agent output for learnings JSON

3. **UI**:
   - `widgets/learnings-panel.tsx`: Display learnings
   - `widgets/tabs.tsx`: Tab navigation component
   - Update `screens/planning.tsx`: Add tabbed panel

### Exit Criteria

- Agent outputs learnings in structured format
- Learnings saved to `.ml-ralph/learnings.jsonl`
- Learnings visible in Planning mode
- Can filter by category

---

## Phase 4: Research

**Goal**: Agent researches and logs findings, visible in UI.

### Slice

Add Research tab to Planning screen:

```
┌───────────────────────────────────────────────────────────────┐
│  [Learnings] [Research] [Stories]                             │
│  ┌─────────────────────────────────────────────────────────┐  │
│  │ 📄 R-001  documentation                                 │  │
│  │ XGBoost: Handling Imbalanced Datasets                   │  │
│  │ • Use scale_pos_weight for class imbalance              │  │
│  │ • eval_metric should be AUC, not accuracy               │  │
│  │                                                         │  │
│  │ 📄 R-002  stackoverflow                                 │  │
│  │ How to prevent target leakage in time series            │  │
│  │ • Use purged cross-validation                           │  │
│  │ • Add embargo period between train/val                  │  │
│  └─────────────────────────────────────────────────────────┘  │
└───────────────────────────────────────────────────────────────┘
```

### Implementation

1. **Infrastructure**:
   - `file-store`: Add research read/write
   - `prompts/story-execution.ts`: Update to log research

2. **Application**:
   - `state/store.ts`: Add research array
   - Parse agent output for research JSON

3. **UI**:
   - `widgets/research-panel.tsx`: Display research items
   - Update tabs to include Research

### Exit Criteria

- Agent uses WebSearch and logs findings
- Research saved to `.ml-ralph/research.jsonl`
- Research visible in Planning mode
- Shows key takeaways for each item

---

## Phase 5: Training Monitoring

**Goal**: Long-running training jobs tracked, metrics visible.

### Slice

Add to Monitor screen:

```
┌─────────────────────────────────────────────────────────────┐
│                     Monitor Screen                          │
│  ┌─────────────────────┬───────────────────────────────────┐│
│  │                     │  Experiments          [loss ▼]    ││
│  │   Agent Output      │  ┌─────────────────────────────┐  ││
│  │                     │  │  loss: 0.42 → 0.18          │  ││
│  │                     │  │  ████████░░░░ epoch 8/20    │  ││
│  │                     │  └─────────────────────────────┘  ││
│  │                     ├───────────────────────────────────┤│
│  │                     │  Current: US-003                  ││
│  │                     │  Hypothesis: Temporal features    ││
│  │                     │  will improve AUC by 5%           ││
│  └─────────────────────┴───────────────────────────────────┘│
│  [Stop Agent] [Stop Training] [Open W&B]                    │
└─────────────────────────────────────────────────────────────┘
```

### Implementation

1. **Infrastructure**:
   - `process/job-manager.ts`: Spawn/track detached processes
   - `wandb/client.ts`: Fetch run metrics
   - `file-store`: Add jobs read/write

2. **Application**:
   - `state/store.ts`: Add activeJobs, latestMetrics
   - Poll W&B for metrics updates

3. **UI**:
   - `widgets/metrics-chart.tsx`: Display metrics (ASCII sparkline or progress)
   - `widgets/current-task.tsx`: Show hypothesis
   - Update `screens/monitor.tsx`: Add experiments panel

### Exit Criteria

- Agent can launch detached training jobs
- Jobs tracked in `.ml-ralph/runs/active.json`
- TUI shows running jobs with metrics
- Metrics update via W&B polling
- Can stop training jobs from TUI

---

## Phase 6: Polish & Stories View

**Goal**: Complete MVP with all views polished.

### Additions

1. **Stories tab** in Planning mode:
   - Show all stories with status
   - Visual indication of current story

2. **Status bar** across all screens:
   - Show: mode, current story, agent status, active jobs

3. **Keyboard shortcuts**:
   - `Tab`: Switch modes
   - `1/2/3`: Switch tabs in Planning
   - `s`: Start/stop agent
   - `q`: Quit

4. **Error handling**:
   - Display errors gracefully
   - Recovery from common failures

5. **Init command**:
   - `ml-ralph init` creates `.ml-ralph/` structure

### Exit Criteria

- All screens polished and functional
- Keyboard navigation works
- Errors displayed gracefully
- Can init new project
- README has accurate quick start

---

## Timeline Estimate

| Phase | Scope               | Dependencies |
| ----- | ------------------- | ------------ |
| 0     | Foundation          | None         |
| 1     | Agent execution     | Phase 0      |
| 2     | PRD creation        | Phase 1      |
| 3     | Learnings           | Phase 2      |
| 4     | Research            | Phase 3      |
| 5     | Training monitoring | Phase 3      |
| 6     | Polish              | Phase 4, 5   |

Phases 4 and 5 can be done in parallel after Phase 3.

---

## Definition of Done (for each phase)

- [ ] All code passes `bun run typecheck`
- [ ] All code passes `bun run lint`
- [ ] Key paths have tests
- [ ] Feature works end-to-end
- [ ] No console errors/warnings
- [ ] Documentation updated if needed

---

## Risk Mitigation

| Risk                        | Mitigation                                        |
| --------------------------- | ------------------------------------------------- |
| Claude Code API changes     | Abstract behind interface, easy to update         |
| OpenTUI limitations         | Research alternatives early (fallback renderers)  |
| W&B API issues              | Graceful degradation (show "metrics unavailable") |
| Performance with large logs | Virtual scrolling, pagination                     |
| State corruption            | Validation on read, atomic writes                 |
