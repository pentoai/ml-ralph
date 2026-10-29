/**
 * Small git helpers shared by `ml-ralph eval` and the promotion gate
 */

export async function runGit(
  projectPath: string,
  args: string[],
): Promise<{ code: number; out: string; err: string }> {
  try {
    const proc = Bun.spawn(["git", ...args], {
      cwd: projectPath,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [out, err, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return { code, out, err };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { code: 1, out: "", err: message };
  }
}

/** Tracked files outside .ml-ralph/ with uncommitted changes make a commit SHA meaningless */
export const trackedChanges = async (projectPath: string) =>
  runGit(projectPath, [
    "status",
    "--porcelain",
    "--untracked-files=no",
    "--",
    ".",
    ":(exclude).ml-ralph",
  ]);

export type EvalCommit =
  | { state: "ok"; sha: string }
  | { state: "not_git" }
  | { state: "dirty" };

/** The commit an eval would score: HEAD when the tree is clean, otherwise why there is none */
export async function evalCommit(projectPath: string): Promise<EvalCommit> {
  const inside = await runGit(projectPath, [
    "rev-parse",
    "--is-inside-work-tree",
  ]);
  if (inside.code !== 0) return { state: "not_git" };
  const head = await runGit(projectPath, ["rev-parse", "--verify", "HEAD"]);
  // A repository with no commit yet has nothing to tie a score to
  if (head.code !== 0) return { state: "dirty" };
  const status = await trackedChanges(projectPath);
  if (status.code !== 0 || status.out.trim()) return { state: "dirty" };
  return { state: "ok", sha: head.out.trim() };
}
