import shutil
import subprocess
from pathlib import Path
import typer
from importlib import resources

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


def _find_script(cwd: Path) -> Path:
    direct = cwd / "ml-ralph.sh"
    if direct.exists():
        return direct
    nested = cwd / "scripts" / "ml-ralph" / "ml-ralph.sh"
    if nested.exists():
        return nested
    raise FileNotFoundError(
        "ml-ralph.sh not found in project root or scripts/ml-ralph/"
    )


@app.command()
def init(
    path: Path = typer.Argument(Path("."), help="Project root to initialize."),
    force: bool = typer.Option(False, "--force", help="Overwrite existing files."),
) -> None:
    """Initialize ML-Ralph in a project (copies scripts, prompts, and skills)."""
    path = path.resolve()
    templates_root = resources.files("ml_ralph_cli").joinpath("templates")
    _copy_tree(templates_root, path, force=force)

    script_path = path / "ml-ralph.sh"
    if script_path.exists():
        script_path.chmod(script_path.stat().st_mode | 0o111)

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
    script_path = _find_script(cwd)

    cmd = [str(script_path), "--tool", tool]
    if codex_safe:
        cmd.append("--codex-safe")
    if max_iterations is not None:
        cmd.append(str(max_iterations))

    typer.echo(f"Running: {' '.join(cmd)}")
    subprocess.run(cmd, check=True)


if __name__ == "__main__":
    app()
