"""
Ralph v2 - Data Schemas

Pydantic models defining all data structures Ralph uses.
"""

from datetime import datetime
from enum import Enum
from typing import Any, Optional, Union

from pydantic import BaseModel, Field


# =============================================================================
# Enums
# =============================================================================


class Phase(str, Enum):
    """The cognitive phases Ralph operates in."""

    ORIENT = "ORIENT"
    RESEARCH = "RESEARCH"
    HYPOTHESIZE = "HYPOTHESIZE"
    EXECUTE = "EXECUTE"
    ANALYZE = "ANALYZE"
    VALIDATE = "VALIDATE"
    DECIDE = "DECIDE"


class HypothesisStatus(str, Enum):
    """Status of a hypothesis in the backlog."""

    PENDING = "pending"
    TESTING = "testing"
    VALIDATED = "validated"
    REJECTED = "rejected"


class Decision(str, Enum):
    """Possible decisions after validation."""

    KEEP = "keep"
    REVERT = "revert"
    PIVOT = "pivot"
    DONE = "done"


class ProjectStatus(str, Enum):
    """Status of the overall project."""

    DRAFT = "draft"
    APPROVED = "approved"
    RUNNING = "running"
    PAUSED = "paused"
    COMPLETE = "complete"


class CommandType(str, Enum):
    """Types of user commands."""

    HINT = "hint"
    PAUSE = "pause"
    RESUME = "resume"
    REDIRECT = "redirect"


class ChatRole(str, Enum):
    """Roles in chat conversation."""

    USER = "user"
    RALPH = "ralph"
    SYSTEM = "system"


# =============================================================================
# prd.json - The Contract
# =============================================================================


class EvaluationConfig(BaseModel):
    """Evaluation configuration."""

    metric: str
    validation_strategy: str
    test_set: Optional[str] = None  # e.g., "kaggle_holdout"


class Scope(BaseModel):
    """Project scope definition."""

    in_scope: list[str] = Field(default_factory=list)
    out_of_scope: list[str] = Field(default_factory=list)


class PRD(BaseModel):
    """
    Product Requirements Document - The contract between user and Ralph.

    File: prd.json
    """

    project: str
    description: str
    created_at: datetime = Field(default_factory=datetime.utcnow)
    status: ProjectStatus = ProjectStatus.DRAFT

    problem: str
    goal: str

    success_criteria: list[str] = Field(default_factory=list)
    constraints: list[str] = Field(default_factory=list)

    evaluation: EvaluationConfig
    scope: Scope = Field(default_factory=Scope)

    # Optional metadata
    data_sources: list[str] = Field(default_factory=list)
    references: list[str] = Field(default_factory=list)


# =============================================================================
# ralph.json - Execution State
# =============================================================================


class CurrentState(BaseModel):
    """Current execution state."""

    phase: Phase = Phase.ORIENT
    iteration: int = 0
    hypothesis_id: Optional[str] = None
    experiment_id: Optional[str] = None
    started_at: Optional[datetime] = None


class Stats(BaseModel):
    """Aggregate statistics."""

    iterations: int = 0
    hypotheses_tested: int = 0
    hypotheses_validated: int = 0
    hypotheses_rejected: int = 0
    experiments_run: int = 0
    best_score: Optional[float] = None
    best_experiment_id: Optional[str] = None


class RalphState(BaseModel):
    """
    Ralph execution state.

    File: ralph.json
    """

    status: ProjectStatus = ProjectStatus.RUNNING
    current: CurrentState = Field(default_factory=CurrentState)
    stats: Stats = Field(default_factory=Stats)

    # Timestamps
    started_at: Optional[datetime] = None
    paused_at: Optional[datetime] = None
    completed_at: Optional[datetime] = None


# =============================================================================
# backlog.json - Hypotheses
# =============================================================================


class Hypothesis(BaseModel):
    """A testable hypothesis."""

    id: str  # H-001, H-002, etc.
    status: HypothesisStatus = HypothesisStatus.PENDING
    priority: int = 1  # Lower = higher priority

    hypothesis: str  # "If X, then Y, because Z"
    rationale: Optional[str] = None  # Why we think this will work
    expected_outcome: str
    actual_outcome: Optional[str] = None

    experiment_ids: list[str] = Field(default_factory=list)

    created_at: datetime = Field(default_factory=datetime.utcnow)
    resolved_at: Optional[datetime] = None

    # Optional metadata
    estimated_impact: Optional[str] = None  # high/medium/low
    tags: list[str] = Field(default_factory=list)


class Backlog(BaseModel):
    """
    Hypotheses backlog.

    File: backlog.json
    """

    hypotheses: list[Hypothesis] = Field(default_factory=list)

    def next_id(self) -> str:
        """Generate next hypothesis ID."""
        return f"H-{len(self.hypotheses) + 1:03d}"

    def add(
        self,
        hypothesis: str,
        expected_outcome: str,
        priority: int = 1,
        estimated_impact: Optional[str] = None,
    ) -> Hypothesis:
        """Add a new hypothesis."""
        h = Hypothesis(
            id=self.next_id(),
            hypothesis=hypothesis,
            expected_outcome=expected_outcome,
            priority=priority,
            estimated_impact=estimated_impact,
        )
        self.hypotheses.append(h)
        return h

    def get_current(self) -> Optional[Hypothesis]:
        """Get the hypothesis currently being tested."""
        for h in self.hypotheses:
            if h.status == HypothesisStatus.TESTING:
                return h
        return None

    def get_pending(self) -> list[Hypothesis]:
        """Get all pending hypotheses, sorted by priority."""
        pending = [h for h in self.hypotheses if h.status == HypothesisStatus.PENDING]
        return sorted(pending, key=lambda h: h.priority)

    def get_next(self) -> Optional[Hypothesis]:
        """Get the next hypothesis to test."""
        pending = self.get_pending()
        return pending[0] if pending else None


# =============================================================================
# log.jsonl - Phase Outputs
# =============================================================================


class OrientOutput(BaseModel):
    """Output from ORIENT phase."""

    problem: str
    success_criteria: list[str]
    constraints: list[str]
    failure_modes: list[str]
    key_questions: list[str] = Field(default_factory=list)


class ResearchOutput(BaseModel):
    """Output from RESEARCH phase."""

    sources: list[str]
    insights: list[str]
    gaps: list[str]
    recommended_approaches: list[str] = Field(default_factory=list)


class HypothesizeOutput(BaseModel):
    """Output from HYPOTHESIZE phase."""

    hypothesis_id: str
    hypothesis: str
    reasoning: str
    minimal_experiment: str
    expected_outcome: str
    success_threshold: Optional[str] = None


class ExecuteOutput(BaseModel):
    """Output from EXECUTE phase."""

    experiment_id: str
    hypothesis_id: str
    changes: list[str]
    config: dict[str, Any] = Field(default_factory=dict)
    wandb_run: Optional[str] = None
    commit_hash: Optional[str] = None

    # For long-running jobs
    pid: Optional[int] = None
    log_path: Optional[str] = None
    is_long_running: bool = False


class AnalyzeOutput(BaseModel):
    """Output from ANALYZE phase."""

    experiment_id: str
    metrics: dict[str, Any]
    comparison_to_baseline: Optional[str] = None
    error_examples: list[str] = Field(default_factory=list)
    patterns: list[str] = Field(default_factory=list)
    data_issues: list[str] = Field(default_factory=list)
    unexpected_findings: list[str] = Field(default_factory=list)


class ValidateOutput(BaseModel):
    """Output from VALIDATE phase."""

    experiment_id: str
    checks: dict[str, bool]  # Check name -> passed
    concerns: list[str]
    confidence: str  # high/medium/low
    recommendation: str  # keep/revert/investigate


class DecideOutput(BaseModel):
    """Output from DECIDE phase."""

    hypothesis_id: str
    decision: Decision
    reasoning: str
    learnings: list[str]
    next_action: str
    backlog_updates: list[str] = Field(default_factory=list)

    # Strategic thinking
    current_best_score: Optional[float] = None
    target_score: Optional[float] = None
    gap_analysis: Optional[str] = None


# Union of all phase outputs
PhaseOutput = Union[
    OrientOutput,
    ResearchOutput,
    HypothesizeOutput,
    ExecuteOutput,
    AnalyzeOutput,
    ValidateOutput,
    DecideOutput,
]


class LogEntry(BaseModel):
    """
    A single entry in log.jsonl.

    Each phase produces one log entry.
    """

    ts: datetime = Field(default_factory=datetime.utcnow)
    iteration: int
    phase: Phase
    output: dict[str, Any]  # Phase-specific output

    # Optional context
    hypothesis_id: Optional[str] = None
    experiment_id: Optional[str] = None
    duration_seconds: Optional[float] = None


# =============================================================================
# chat.jsonl - Conversation History
# =============================================================================


class ChatMessage(BaseModel):
    """A single chat message."""

    ts: datetime = Field(default_factory=datetime.utcnow)
    role: ChatRole
    content: str

    # Optional attachments
    attachment_type: Optional[str] = None  # prd_draft, code, etc.
    attachment_data: Optional[dict[str, Any]] = None


# =============================================================================
# inbox.json - User Commands
# =============================================================================


class UserCommand(BaseModel):
    """A user command for Ralph."""

    ts: datetime = Field(default_factory=datetime.utcnow)
    type: CommandType
    message: str
    processed: bool = False


class Inbox(BaseModel):
    """
    User command inbox.

    File: inbox.json
    """

    commands: list[UserCommand] = Field(default_factory=list)

    def add(self, command_type: CommandType, message: str) -> UserCommand:
        """Add a new command."""
        cmd = UserCommand(type=command_type, message=message)
        self.commands.append(cmd)
        return cmd

    def get_pending(self) -> list[UserCommand]:
        """Get unprocessed commands."""
        return [c for c in self.commands if not c.processed]

    def mark_processed(self, command: UserCommand) -> None:
        """Mark a command as processed."""
        command.processed = True


# =============================================================================
# Active Runs (for long-running training)
# =============================================================================


class ActiveRun(BaseModel):
    """A long-running training job."""

    run_id: str
    experiment_id: str
    hypothesis_id: str
    pid: Optional[int] = None
    log_path: str
    wandb_run: Optional[str] = None
    started_at: datetime
    status: str = "running"  # running/stopped/finished
    last_checked_at: Optional[datetime] = None


class ActiveRuns(BaseModel):
    """
    Registry of active long-running jobs.

    File: outputs/logs/active_runs.json
    """

    runs: list[ActiveRun] = Field(default_factory=list)

    def get_active(self) -> list[ActiveRun]:
        """Get currently running jobs."""
        return [r for r in self.runs if r.status == "running"]

    def add(
        self,
        run_id: str,
        experiment_id: str,
        hypothesis_id: str,
        log_path: str,
        pid: Optional[int] = None,
        wandb_run: Optional[str] = None,
    ) -> ActiveRun:
        """Add a new active run."""
        run = ActiveRun(
            run_id=run_id,
            experiment_id=experiment_id,
            hypothesis_id=hypothesis_id,
            pid=pid,
            log_path=log_path,
            wandb_run=wandb_run,
            started_at=datetime.utcnow(),
        )
        self.runs.append(run)
        return run


# =============================================================================
# Helper Functions
# =============================================================================


def generate_experiment_id(backlog: Backlog) -> str:
    """Generate a unique experiment ID."""
    total_experiments = sum(len(h.experiment_ids) for h in backlog.hypotheses)
    return f"RUN-{total_experiments + 1:03d}"
