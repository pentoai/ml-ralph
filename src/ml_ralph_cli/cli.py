"""
Ralph v2 - CLI

Commands:
- ralph chat: Start SETUP mode conversation
- ralph run: Run EXECUTION mode loop
- ralph status: Show current state
- ralph log: Show thinking log
- ralph hint: Send a hint to Ralph
- ralph pause/resume: Control execution
"""

import json
import subprocess
from datetime import datetime
from pathlib import Path
from typing import Optional

import typer
from rich.console import Console
from rich.panel import Panel
from rich.table import Table

from ml_ralph_cli.schemas import (
    Backlog,
    ChatMessage,
    ChatRole,
    CommandType,
    CurrentState,
    Inbox,
    Phase,
    PRD,
    ProjectStatus,
    RalphState,
    Stats,
)

app = typer.Typer(help="Ralph v2 - Autonomous ML Agent")
console = Console()

# File paths
PRD_JSON = Path("prd.json")
RALPH_JSON = Path("ralph.json")
BACKLOG_JSON = Path("backlog.json")
LOG_JSONL = Path("log.jsonl")
CHAT_JSONL = Path("chat.jsonl")
INBOX_JSON = Path("inbox.json")
RALPH_MD = Path(__file__).parent / "templates" / "RALPH.md"
SKILL_MD = Path(__file__).parent / "templates" / "skills" / "ralph" / "SKILL.md"


# =============================================================================
# File Operations
# =============================================================================


def load_prd() -> Optional[PRD]:
    """Load prd.json if it exists."""
    if PRD_JSON.exists():
        return PRD.model_validate_json(PRD_JSON.read_text())
    return None


def save_prd(prd: PRD) -> None:
    """Save prd.json."""
    PRD_JSON.write_text(prd.model_dump_json(indent=2))


def load_state() -> Optional[RalphState]:
    """Load ralph.json if it exists."""
    if RALPH_JSON.exists():
        return RalphState.model_validate_json(RALPH_JSON.read_text())
    return None


def save_state(state: RalphState) -> None:
    """Save ralph.json."""
    RALPH_JSON.write_text(state.model_dump_json(indent=2))


def load_backlog() -> Backlog:
    """Load backlog.json."""
    if BACKLOG_JSON.exists():
        return Backlog.model_validate_json(BACKLOG_JSON.read_text())
    return Backlog()


def save_backlog(backlog: Backlog) -> None:
    """Save backlog.json."""
    BACKLOG_JSON.write_text(backlog.model_dump_json(indent=2))


def load_inbox() -> Inbox:
    """Load inbox.json."""
    if INBOX_JSON.exists():
        return Inbox.model_validate_json(INBOX_JSON.read_text())
    return Inbox()


def save_inbox(inbox: Inbox) -> None:
    """Save inbox.json."""
    INBOX_JSON.write_text(inbox.model_dump_json(indent=2))


def append_chat(role: ChatRole, content: str) -> None:
    """Append a message to chat.jsonl."""
    msg = ChatMessage(role=role, content=content)
    with open(CHAT_JSONL, "a") as f:
        f.write(msg.model_dump_json() + "\n")


def get_mode() -> str:
    """Determine current mode: setup or execution."""
    prd = load_prd()
    if prd is None:
        return "setup"
    if prd.status in [ProjectStatus.APPROVED, ProjectStatus.RUNNING]:
        return "execution"
    return "setup"


# =============================================================================
# Commands
# =============================================================================


@app.command()
def chat(
    tool: str = typer.Option("claude", help="Tool to use: claude or codex"),
):
    """
    Start a conversation with Ralph (SETUP mode).

    This begins the PRD creation process through interactive conversation.
    """
    mode = get_mode()

    if mode == "execution":
        console.print("[yellow]PRD already exists and is approved.[/yellow]")
        console.print("Use 'ralph run' to continue execution.")
        console.print("Use 'ralph reset' to start over.")
        raise typer.Exit(1)

    console.print(
        Panel.fit(
            "[cyan]Ralph SETUP Mode[/cyan]\n\n"
            "Let's create a PRD together through conversation.\n"
            "I'll ask questions to understand your problem.\n\n"
            "When the PRD is ready, say '/start' to begin execution.",
            title="Ralph v2",
        )
    )

    # Ensure chat.jsonl exists
    CHAT_JSONL.touch()

    # Copy RALPH.md and SKILL.md to project if not exists
    if not Path("RALPH.md").exists() and RALPH_MD.exists():
        Path("RALPH.md").write_text(RALPH_MD.read_text())

    # Run interactive chat
    prompt = """Read RALPH.md for your instructions. You are in SETUP mode.

Start a conversation with the user to understand their ML problem and create a PRD.
Ask clarifying questions one at a time. When you have enough information, propose a PRD.
When the user says /start, create the necessary files and begin execution.

Check chat.jsonl for conversation history."""

    run_agent(tool, prompt, interactive=True)


@app.command()
def run(
    tool: str = typer.Option("claude", help="Tool to use: claude or codex"),
    max_iterations: int = typer.Option(100, help="Maximum iterations"),
):
    """
    Run Ralph in EXECUTION mode.

    This runs the autonomous cognitive loop until completion or max iterations.
    """
    prd = load_prd()
    if prd is None:
        console.print("[red]No PRD found. Run 'ralph chat' first to create one.[/red]")
        raise typer.Exit(1)

    if prd.status == ProjectStatus.DRAFT:
        console.print("[yellow]PRD is still in draft. Complete SETUP first.[/yellow]")
        console.print("Run 'ralph chat' to continue the conversation.")
        raise typer.Exit(1)

    # Initialize state if needed
    state = load_state()
    if state is None:
        state = RalphState(
            status=ProjectStatus.RUNNING,
            current=CurrentState(phase=Phase.ORIENT, iteration=0),
            stats=Stats(),
            started_at=datetime.utcnow(),
        )
        save_state(state)

    # Ensure other files exist
    if not BACKLOG_JSON.exists():
        save_backlog(Backlog())
    LOG_JSONL.touch()
    if not INBOX_JSON.exists():
        save_inbox(Inbox())

    console.print(
        Panel.fit(
            f"[cyan]Ralph EXECUTION Mode[/cyan]\n\n"
            f"Project: {prd.project}\n"
            f"Goal: {prd.goal}\n"
            f"Tool: {tool}\n"
            f"Max iterations: {max_iterations}\n"
            f"Current phase: {state.current.phase.value}\n"
            f"Current iteration: {state.current.iteration}",
            title="Ralph v2 Run",
        )
    )

    for i in range(max_iterations):
        # Reload state each iteration
        state = load_state()
        if state is None:
            console.print("[red]State file missing![/red]")
            raise typer.Exit(1)

        # Check if paused
        if state.status == ProjectStatus.PAUSED:
            console.print(
                "\n[yellow]Ralph is paused. Use 'ralph resume' to continue.[/yellow]"
            )
            break

        # Check if complete
        if state.status == ProjectStatus.COMPLETE:
            console.print("\n[green]Ralph has completed the project![/green]")
            break

        iteration = state.current.iteration + 1
        console.print(
            f"\n[yellow]═══ Iteration {iteration} | Phase: {state.current.phase.value} ═══[/yellow]"
        )

        # Update state
        state.current.iteration = iteration
        state.current.started_at = datetime.utcnow()
        save_state(state)

        # Run the agent
        prompt = """Read RALPH.md for your instructions. You are in EXECUTION mode.

Read the state files:
- prd.json (the contract)
- ralph.json (current state)
- backlog.json (hypotheses)
- log.jsonl (thinking log)
- inbox.json (user commands)

Execute the current phase of the cognitive loop. Log your work to log.jsonl.
Update state files as needed. Commit code changes."""

        result = run_agent(tool, prompt, interactive=False)

        # Check for completion signal
        if "<promise>COMPLETE</promise>" in result:
            console.print("\n[green]═══ COMPLETE ═══[/green]")
            console.print(f"Ralph finished in {iteration} iterations.")
            break

    else:
        console.print(f"\n[yellow]Reached max iterations ({max_iterations})[/yellow]")


@app.command()
def status():
    """Show current Ralph state."""
    prd = load_prd()
    state = load_state()
    backlog = load_backlog()

    if prd is None:
        console.print("[yellow]No PRD found. Run 'ralph chat' to start.[/yellow]")
        return

    # PRD info
    console.print(
        Panel.fit(
            f"[cyan]{prd.project}[/cyan]\n\n"
            f"Goal: {prd.goal}\n"
            f"Status: {prd.status.value}\n\n"
            f"Success Criteria:\n"
            + "\n".join(f"  - {c}" for c in prd.success_criteria),
            title="PRD",
        )
    )

    if state:
        # State table
        table = Table(title="Execution State")
        table.add_column("Field", style="cyan")
        table.add_column("Value", style="white")

        table.add_row("Status", state.status.value)
        table.add_row("Phase", state.current.phase.value)
        table.add_row("Iteration", str(state.current.iteration))
        table.add_row("Current Hypothesis", state.current.hypothesis_id or "-")
        table.add_row("Current Experiment", state.current.experiment_id or "-")

        console.print(table)

        # Stats table
        stats_table = Table(title="Stats")
        stats_table.add_column("Metric", style="cyan")
        stats_table.add_column("Value", style="green")

        stats_table.add_row("Iterations", str(state.stats.iterations))
        stats_table.add_row("Hypotheses Tested", str(state.stats.hypotheses_tested))
        stats_table.add_row("Validated", str(state.stats.hypotheses_validated))
        stats_table.add_row("Rejected", str(state.stats.hypotheses_rejected))
        if state.stats.best_score is not None:
            stats_table.add_row("Best Score", f"{state.stats.best_score:.4f}")

        console.print(stats_table)

    # Backlog summary
    if backlog.hypotheses:
        backlog_table = Table(title="Recent Hypotheses")
        backlog_table.add_column("ID", style="cyan")
        backlog_table.add_column("Status", style="yellow")
        backlog_table.add_column("Hypothesis")

        for h in backlog.hypotheses[-5:]:
            status_color = {
                "pending": "white",
                "testing": "yellow",
                "validated": "green",
                "rejected": "red",
            }.get(h.status.value, "white")
            backlog_table.add_row(
                h.id,
                f"[{status_color}]{h.status.value}[/{status_color}]",
                h.hypothesis[:50] + ("..." if len(h.hypothesis) > 50 else ""),
            )

        console.print(backlog_table)


@app.command()
def log(
    tail: int = typer.Option(10, help="Number of entries to show"),
    phase: Optional[str] = typer.Option(None, help="Filter by phase"),
):
    """Show recent thinking log entries."""
    if not LOG_JSONL.exists():
        console.print("[yellow]No log entries yet.[/yellow]")
        return

    entries = []
    for line in LOG_JSONL.read_text().strip().split("\n"):
        if line:
            entry = json.loads(line)
            if phase is None or entry.get("phase") == phase.upper():
                entries.append(entry)

    if not entries:
        console.print("[yellow]No matching log entries.[/yellow]")
        return

    for entry in entries[-tail:]:
        phase_name = entry.get("phase", "?")
        iteration = entry.get("iteration", "?")
        ts = entry.get("ts", "?")

        phase_colors = {
            "ORIENT": "blue",
            "RESEARCH": "magenta",
            "HYPOTHESIZE": "cyan",
            "EXECUTE": "yellow",
            "ANALYZE": "green",
            "VALIDATE": "red",
            "DECIDE": "white",
        }
        color = phase_colors.get(phase_name, "white")

        console.print(
            f"\n[{color}]─── {phase_name} (iteration {iteration}) ───[/{color}]"
        )
        console.print(f"[dim]{ts}[/dim]")

        output = entry.get("output", {})
        for key, value in output.items():
            if isinstance(value, list):
                console.print(f"  [yellow]{key}:[/yellow]")
                for item in value[:3]:
                    console.print(f"    - {item}")
                if len(value) > 3:
                    console.print(f"    [dim]... and {len(value) - 3} more[/dim]")
            elif isinstance(value, dict):
                console.print(f"  [yellow]{key}:[/yellow]")
                for k, v in list(value.items())[:3]:
                    console.print(f"    {k}: {v}")
            else:
                console.print(f"  [yellow]{key}:[/yellow] {value}")


@app.command()
def hint(message: str = typer.Argument(..., help="Hint message for Ralph")):
    """Send a hint to Ralph for the next hypothesis."""
    inbox = load_inbox()
    inbox.add(CommandType.HINT, message)
    save_inbox(inbox)
    console.print(f"[green]Hint added:[/green] {message}")
    console.print("[dim]Ralph will consider this in the next iteration.[/dim]")


@app.command()
def pause(message: str = typer.Option("User requested pause", help="Pause reason")):
    """Pause Ralph execution."""
    state = load_state()
    if state is None:
        console.print("[yellow]No active execution to pause.[/yellow]")
        return

    inbox = load_inbox()
    inbox.add(CommandType.PAUSE, message)
    save_inbox(inbox)

    state.status = ProjectStatus.PAUSED
    state.paused_at = datetime.utcnow()
    save_state(state)

    console.print("[yellow]Ralph paused.[/yellow]")
    console.print(f"Reason: {message}")
    console.print("Use 'ralph resume' to continue.")


@app.command()
def resume(message: str = typer.Option("User resumed", help="Resume message")):
    """Resume Ralph execution."""
    state = load_state()
    if state is None:
        console.print("[yellow]No execution to resume.[/yellow]")
        return

    if state.status != ProjectStatus.PAUSED:
        console.print("[yellow]Ralph is not paused.[/yellow]")
        return

    inbox = load_inbox()
    inbox.add(CommandType.RESUME, message)
    save_inbox(inbox)

    state.status = ProjectStatus.RUNNING
    state.paused_at = None
    save_state(state)

    console.print("[green]Ralph resumed.[/green]")
    console.print("Use 'ralph run' to continue execution.")


@app.command()
def reset(force: bool = typer.Option(False, "--force", "-f", help="Skip confirmation")):
    """Reset Ralph state (keeps code, removes Ralph files)."""
    if not force:
        if not typer.confirm("This will remove all Ralph state files. Continue?"):
            raise typer.Abort()

    files_to_remove = [
        PRD_JSON,
        RALPH_JSON,
        BACKLOG_JSON,
        LOG_JSONL,
        CHAT_JSONL,
        INBOX_JSON,
    ]

    for f in files_to_remove:
        if f.exists():
            f.unlink()
            console.print(f"[dim]Removed {f}[/dim]")

    console.print("[green]Ralph state reset.[/green]")
    console.print("Use 'ralph chat' to start fresh.")


# =============================================================================
# Agent Runner
# =============================================================================


def run_agent(tool: str, prompt: str, interactive: bool = False) -> str:
    """Run the agent with the given prompt."""
    if tool == "claude":
        return run_claude(prompt, interactive)
    elif tool == "codex":
        return run_codex(prompt, interactive)
    else:
        console.print(f"[red]Unknown tool: {tool}[/red]")
        raise typer.Exit(1)


def run_claude(prompt: str, interactive: bool) -> str:
    """Run Claude Code."""
    cmd = ["claude"]

    if interactive:
        # Interactive mode - let user chat
        cmd.extend(["-p", prompt])
    else:
        # Non-interactive mode
        cmd.extend(
            [
                "-p",
                prompt,
                "--allowedTools",
                "Bash,Read,Write,Edit,Glob,Grep",
            ]
        )

    try:
        if interactive:
            # Run interactively
            subprocess.run(cmd)
            return ""
        else:
            result = subprocess.run(
                cmd,
                capture_output=True,
                text=True,
                timeout=600,
            )
            return result.stdout
    except subprocess.TimeoutExpired:
        console.print("[yellow]Iteration timed out[/yellow]")
        return ""
    except FileNotFoundError:
        console.print("[red]Claude CLI not found.[/red]")
        console.print("Install with: npm install -g @anthropic-ai/claude-code")
        raise typer.Exit(1)


def run_codex(prompt: str, interactive: bool) -> str:
    """Run Codex CLI."""
    cmd = ["codex", "-p", prompt]

    try:
        if interactive:
            subprocess.run(cmd)
            return ""
        else:
            result = subprocess.run(
                cmd,
                capture_output=True,
                text=True,
                timeout=600,
            )
            return result.stdout
    except subprocess.TimeoutExpired:
        console.print("[yellow]Iteration timed out[/yellow]")
        return ""
    except FileNotFoundError:
        console.print("[red]Codex CLI not found.[/red]")
        raise typer.Exit(1)


# =============================================================================
# Entry Point
# =============================================================================


if __name__ == "__main__":
    app()
