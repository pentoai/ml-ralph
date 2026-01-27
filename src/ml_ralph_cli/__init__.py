"""
Ralph v2 - Autonomous ML Agent

An ML agent that thinks like an experienced MLE.
"""

__version__ = "0.1.0"

from .schemas import (
    # Enums
    Phase,
    HypothesisStatus,
    Decision,
    ProjectStatus,
    CommandType,
    ChatRole,
    # PRD
    PRD,
    EvaluationConfig,
    Scope,
    # State
    RalphState,
    CurrentState,
    Stats,
    # Backlog
    Backlog,
    Hypothesis,
    # Log
    LogEntry,
    OrientOutput,
    ResearchOutput,
    HypothesizeOutput,
    ExecuteOutput,
    AnalyzeOutput,
    ValidateOutput,
    DecideOutput,
    # Chat
    ChatMessage,
    # Inbox
    Inbox,
    UserCommand,
    # Active Runs
    ActiveRun,
    ActiveRuns,
    # Helpers
    generate_experiment_id,
)

__all__ = [
    # Version
    "__version__",
    # Enums
    "Phase",
    "HypothesisStatus",
    "Decision",
    "ProjectStatus",
    "CommandType",
    "ChatRole",
    # PRD
    "PRD",
    "EvaluationConfig",
    "Scope",
    # State
    "RalphState",
    "CurrentState",
    "Stats",
    # Backlog
    "Backlog",
    "Hypothesis",
    # Log
    "LogEntry",
    "OrientOutput",
    "ResearchOutput",
    "HypothesizeOutput",
    "ExecuteOutput",
    "AnalyzeOutput",
    "ValidateOutput",
    "DecideOutput",
    # Chat
    "ChatMessage",
    # Inbox
    "Inbox",
    "UserCommand",
    # Active Runs
    "ActiveRun",
    "ActiveRuns",
    # Helpers
    "generate_experiment_id",
]
