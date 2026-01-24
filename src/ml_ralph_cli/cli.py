import json
import shutil
import subprocess
import time
from datetime import datetime
from pathlib import Path

import typer
from importlib import resources

EXPLAIN_TEXT = """
ML-Ralph workflow:

1) ml-ralph init
   - Installs skills into .claude/skills and .codex/skills

2) ml-ralph run --tool codex --max-iterations 250
   - Runs the ML-Ralph loop
   - Writes decisions/metrics to progress.jsonl
   - Uses outputs/logs/active_runs.json to track long-running training
"""


app = typer.Typer(add_completion=False, no_args_is_help=True)


def _copy_tree(
    src_root: resources.abc.Traversable,
    dest_root: Path,
    *,
    force: bool,
    rel: Path | None = None,
) -> None:
    rel = rel or Path()
    if src_root.is_dir():
        for child in src_root.iterdir():
            _copy_tree(child, dest_root, force=force, rel=rel / child.name)
        return

    dest = dest_root / rel
    dest.parent.mkdir(parents=True, exist_ok=True)
    if dest.exists() and not force:
        return
    with src_root.open("rb") as fh, dest.open("wb") as out:
        shutil.copyfileobj(fh, out)


def _read_template(name: str) -> str:
    templates_root = resources.files("ml_ralph_cli").joinpath("templates")
    template = templates_root / name
    if not template.exists():
        raise FileNotFoundError(f"Missing template file: {name}")
    return template.read_text()


def _load_prd(prd_path: Path) -> dict:
    if not prd_path.exists():
        return {}
    return json.loads(prd_path.read_text())


def _count_remaining(prd: dict) -> int:
    if "userStories" in prd:
        stories = prd.get("userStories", [])
    else:
        stories = prd.get("stories", [])
    return sum(1 for story in stories if not story.get("passes", False))


def _ensure_progress(progress_path: Path, note: str) -> None:
    if not progress_path.exists():
        progress_path.parent.mkdir(parents=True, exist_ok=True)
        progress_path.write_text("")
        entry = {
            "timestamp": datetime.now().strftime("%Y-%m-%d %H:%M"),
            "event": "session_start",
            "note": note,
        }
        progress_path.write_text(json.dumps(entry) + "\n")


def _archive_if_branch_changed(
    prd_path: Path, progress_path: Path, archive_dir: Path, last_branch_file: Path
) -> None:
    if not prd_path.exists() or not last_branch_file.exists():
        return
    prd = _load_prd(prd_path)
    current_branch = prd.get("branchName") or ""
    last_branch = last_branch_file.read_text().strip()
    if current_branch and last_branch and current_branch != last_branch:
        date = datetime.now().strftime("%Y-%m-%d")
        folder_name = current_branch.replace("ml-ralph/", "").replace("ralph/", "")
        archive_folder = archive_dir / f"{date}-{folder_name}"
        archive_folder.mkdir(parents=True, exist_ok=True)
        shutil.copy2(prd_path, archive_folder / prd_path.name)
        if progress_path.exists():
            shutil.copy2(progress_path, archive_folder / progress_path.name)
        progress_path.write_text("")
        entry = {
            "timestamp": datetime.now().strftime("%Y-%m-%d %H:%M"),
            "event": "session_start",
            "note": "Branch changed; new run initialized.",
        }
        progress_path.write_text(json.dumps(entry) + "\n")


@app.command()
def init(
    path: Path = typer.Argument(Path("."), help="Project root to initialize."),
    force: bool = typer.Option(False, "--force", help="Overwrite existing files."),
) -> None:
    """Initialize ML-Ralph in a project (installs skills)."""
    path = path.resolve()
    templates_root = resources.files("ml_ralph_cli").joinpath("templates")

    skills_src = templates_root / "skills"
    if skills_src.exists():
        for skill_root in (path / ".claude" / "skills", path / ".codex" / "skills"):
            _copy_tree(skills_src, skill_root, force=force)

    typer.echo(f"Initialized ML-Ralph in {path}")


@app.command()
def run(
    tool: str = typer.Option("codex", "--tool", help="Tool to use: claude or codex."),
    max_iterations: int = typer.Option(10, "--max-iterations", help="Max iterations."),
    codex_safe: bool = typer.Option(
        False, "--codex-safe", help="Run codex with sandboxed mode."
    ),
) -> None:
    """Run ML-Ralph from the current project directory."""
    cwd = Path.cwd()
    prd_path = cwd / "prd.json"
    progress_path = cwd / "progress.jsonl"
    archive_dir = cwd / "archive"
    last_branch_file = cwd / ".last-branch"

    _archive_if_branch_changed(prd_path, progress_path, archive_dir, last_branch_file)

    prd = _load_prd(prd_path)
    current_branch = prd.get("branchName") or ""
    if current_branch:
        last_branch_file.write_text(current_branch + "\n")

    _ensure_progress(progress_path, "New run initialized.")

    claude_prompt = _read_template("CLAUDE.md")
    codex_prompt = _read_template("CODEX.md")

    typer.echo(f"Starting ML-Ralph - Tool: {tool} - Max iterations: {max_iterations}")

    for i in range(1, max_iterations + 1):
        typer.echo("")
        typer.echo("===============================================================")
        typer.echo(f"  ML-Ralph Iteration {i} of {max_iterations}")
        typer.echo("===============================================================")

        if tool == "claude":
            result = subprocess.run(
                ["claude", "--dangerously-skip-permissions", "--print"],
                input=claude_prompt,
                text=True,
                capture_output=True,
            )
        else:
            cmd = ["codex", "exec"]
            cmd.append(
                "--full-auto"
                if codex_safe
                else "--dangerously-bypass-approvals-and-sandbox"
            )
            cmd.extend(["-C", str(cwd), "-"])
            result = subprocess.run(
                cmd,
                input=codex_prompt,
                text=True,
                capture_output=True,
            )

        output = (result.stdout or "") + (result.stderr or "")
        if output:
            print(output, end="")

        if "<promise>COMPLETE</promise>" in output:
            prd = _load_prd(prd_path)
            remaining = _count_remaining(prd)
            if remaining == 0:
                typer.echo("")
                typer.echo("ML-Ralph completed all tasks!")
                typer.echo(f"Completed at iteration {i} of {max_iterations}")
                raise typer.Exit(code=0)
            typer.echo(f"Completion signal ignored: {remaining} stories remaining.")

        typer.echo(f"Iteration {i} complete. Continuing...")
        time.sleep(2)

    typer.echo("")
    typer.echo(
        f"ML-Ralph reached max iterations ({max_iterations}) without completing all tasks."
    )
    typer.echo(f"Check {progress_path} for status.")
    raise typer.Exit(code=1)


@app.command()
def explain() -> None:
    """Explain the ML-Ralph workflow and what init/run do."""
    typer.echo(EXPLAIN_TEXT.strip())


if __name__ == "__main__":
    app()
