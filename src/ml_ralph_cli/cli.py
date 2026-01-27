"""
ML-Ralph CLI

Commands:
- ml-ralph init: Initialize Ralph in project
- ml-ralph run: Run the autonomous loop
"""

import json
import subprocess
from pathlib import Path

import typer
from rich.console import Console

app = typer.Typer(help="ML-Ralph - Autonomous ML Agent")
console = Console()

# Paths
ML_RALPH_DIR = Path(".ml-ralph")
TEMPLATES_DIR = Path(__file__).parent / "templates"


@app.command()
def init(
    force: bool = typer.Option(False, "--force", "-f", help="Overwrite existing files"),
):
    """Initialize Ralph in the current project."""
    import shutil

    # Check for conflicts
    claude_md = Path("CLAUDE.md")
    agents_md = Path("AGENTS.md")

    if not force and (claude_md.exists() or agents_md.exists()):
        console.print(
            "[red]CLAUDE.md or AGENTS.md already exists. Use --force to overwrite.[/red]"
        )
        raise typer.Exit(1)

    # Create .ml-ralph directory
    ML_RALPH_DIR.mkdir(exist_ok=True)

    # Copy templates
    templates = [
        (TEMPLATES_DIR / "RALPH.md", ML_RALPH_DIR / "RALPH.md"),
        (TEMPLATES_DIR / "CLAUDE.md", claude_md),
        (TEMPLATES_DIR / "AGENTS.md", agents_md),
    ]

    for src, dst in templates:
        if src.exists():
            dst.write_text(src.read_text())
            console.print(f"[dim]Created {dst}[/dim]")

    # Install skills
    skills_src = TEMPLATES_DIR / "skills"
    if skills_src.exists():
        for target in [Path(".claude/skills"), Path(".codex/skills")]:
            target.mkdir(parents=True, exist_ok=True)
            for skill in skills_src.iterdir():
                if skill.is_dir():
                    dest = target / skill.name
                    if dest.exists():
                        shutil.rmtree(dest)
                    shutil.copytree(skill, dest)
            console.print(f"[dim]Installed skills to {target}[/dim]")

    console.print("\n[green]Ralph initialized![/green]")
    console.print(
        "Use /ml-ralph in Claude Code to create a PRD, then run: ml-ralph run"
    )


@app.command()
def run(
    tool: str = typer.Option("claude", help="Tool: claude or codex"),
    max_iterations: int = typer.Option(100, help="Max iterations"),
):
    """Run the autonomous loop."""
    ralph_md = ML_RALPH_DIR / "RALPH.md"

    if not ralph_md.exists():
        console.print("[red]Not initialized. Run 'ml-ralph init' first.[/red]")
        raise typer.Exit(1)

    console.print(f"[cyan]Starting Ralph loop ({max_iterations} max iterations)[/cyan]")

    prompt = """Read .ml-ralph/RALPH.md for instructions.

Execute one iteration of the cognitive loop. Update state files as needed.
When done, output exactly: <iteration_complete>

If the project is complete (success criteria met), output: <project_complete>"""

    for i in range(1, max_iterations + 1):
        console.print(f"\n[yellow]{'═' * 50}[/yellow]")
        console.print(f"[yellow]═══ Iteration {i} ═══[/yellow]")
        console.print(f"[yellow]{'═' * 50}[/yellow]\n")

        result = _run_agent_streaming(tool, prompt)

        if "<project_complete>" in result:
            console.print("\n[green]═══ Project complete! ═══[/green]")
            break
    else:
        console.print(f"\n[yellow]Reached max iterations ({max_iterations})[/yellow]")


def _run_agent_streaming(tool: str, prompt: str) -> str:
    """Run the agent with streaming output."""
    if tool == "claude":
        cmd = [
            "claude",
            "-p",
            prompt,
            "--output-format",
            "stream-json",
            "--allowedTools",
            "Bash,Read,Write,Edit,Glob,Grep",
        ]
    elif tool == "codex":
        # Codex doesn't support stream-json, fall back to regular
        cmd = ["codex", "-p", prompt]
        try:
            result = subprocess.run(cmd, capture_output=True, text=True, timeout=600)
            print(result.stdout)
            return result.stdout
        except subprocess.TimeoutExpired:
            console.print("[yellow]Iteration timed out[/yellow]")
            return ""
        except FileNotFoundError:
            console.print(f"[red]{tool} CLI not found.[/red]")
            raise typer.Exit(1)
    else:
        console.print(f"[red]Unknown tool: {tool}[/red]")
        raise typer.Exit(1)

    # Stream Claude output
    full_result = ""
    try:
        process = subprocess.Popen(
            cmd,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            bufsize=1,
        )

        for line in process.stdout:
            line = line.strip()
            if not line:
                continue

            try:
                event = json.loads(line)
                _handle_stream_event(event)

                # Capture final result
                if event.get("type") == "result":
                    full_result = event.get("result", "")

            except json.JSONDecodeError:
                # Not JSON, just print it
                print(line)

        process.wait()
        return full_result

    except FileNotFoundError:
        console.print("[red]Claude CLI not found.[/red]")
        raise typer.Exit(1)


def _handle_stream_event(event: dict):
    """Handle a streaming JSON event from Claude Code."""
    event_type = event.get("type", "")

    if event_type == "assistant":
        # Assistant message - can contain text or tool_use
        message = event.get("message", {})
        content = message.get("content", [])

        for block in content:
            block_type = block.get("type", "")

            if block_type == "text":
                text = block.get("text", "")
                if text:
                    print(text)

            elif block_type == "tool_use":
                tool_name = block.get("name", "unknown")
                tool_input = block.get("input", {})

                # Show tool being called
                if tool_name == "Bash":
                    cmd = tool_input.get("command", "")
                    desc = tool_input.get("description", "")
                    if desc:
                        console.print(f"\n[dim]► {tool_name}: {desc}[/dim]")
                    else:
                        console.print(
                            f"\n[dim]► {tool_name}: {cmd[:50]}...[/dim]"
                            if len(cmd) > 50
                            else f"\n[dim]► {tool_name}: {cmd}[/dim]"
                        )
                elif tool_name in ("Read", "Write", "Edit"):
                    file_path = tool_input.get("file_path", "")
                    console.print(f"\n[dim]► {tool_name}: {file_path}[/dim]")
                elif tool_name == "Glob":
                    pattern = tool_input.get("pattern", "")
                    console.print(f"\n[dim]► {tool_name}: {pattern}[/dim]")
                elif tool_name == "Grep":
                    pattern = tool_input.get("pattern", "")
                    console.print(f"\n[dim]► {tool_name}: {pattern}[/dim]")
                else:
                    console.print(f"\n[dim]► {tool_name}[/dim]")

    elif event_type == "user":
        # Tool result
        message = event.get("message", {})
        content = message.get("content", [])

        for block in content:
            if block.get("type") == "tool_result":
                is_error = block.get("is_error", False)
                if is_error:
                    console.print(" [red]✗[/red]")
                else:
                    console.print(" [green]✓[/green]")

    elif event_type == "result":
        # Final result - nothing to show
        pass


if __name__ == "__main__":
    app()
