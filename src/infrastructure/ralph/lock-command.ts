/**
 * `ml-ralph resume | unlock | rekey` - manage the eval lock kept in the user-level store
 */

import { resolve } from "node:path";
import { restoreEvalLock, unlockEval } from "./eval-lock.ts";
import { rekeyStoredLock } from "./lock-store.ts";
import { findProjectDir } from "./log-command.ts";

export interface LockCommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

const fail = (message: string): LockCommandResult => ({
  code: 1,
  stdout: "",
  stderr: `${message}\n`,
});
const ok = (message: string): LockCommandResult => ({
  code: 0,
  stdout: `${message}\n`,
  stderr: "",
});

/**
 * Run one of the lock commands. `args` is what follows the command name: an
 * optional project path (default: the project containing the current directory),
 * or for `rekey` the old project path.
 */
export async function runLockCommand(
  command: string,
  args: string[],
  cwd: string = process.cwd(),
): Promise<LockCommandResult> {
  const path = args.find((a) => !a.startsWith("--"));

  if (command === "rekey") {
    if (!path) return fail("Usage: ml-ralph rekey <old-project-path>");
    const project = await findProjectDir(cwd);
    if (!project) return fail(`No .ml-ralph directory found from ${cwd}`);
    const moved = await rekeyStoredLock(resolve(cwd, path), project);
    return moved.ok
      ? ok(`Moved the eval lock for ${resolve(cwd, path)} to ${project}.`)
      : fail(moved.error);
  }

  const project = path ? resolve(cwd, path) : await findProjectDir(cwd);
  if (!project) return fail(`No .ml-ralph directory found from ${cwd}`);

  if (command === "resume") {
    const restored = await restoreEvalLock(project);
    return restored.ok
      ? ok(
          `Restored ${restored.restored.join(" and ")} from the user-level store. Start the run again; edits to the locked eval files will still pause it.`,
        )
      : fail(restored.error);
  }

  const result = await unlockEval(project);
  return ok(
    result.cleared
      ? `Cleared the eval lock for ${project} (removed ${result.storeFile}, lock.json and the marker). It is locked again when the PRD is approved and a run starts.`
      : `No store entry for ${project}; removed any lock.json and marker in the project.`,
  );
}
