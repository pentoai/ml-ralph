/**
 * User-level lock store - the runner's copy of the eval lock hashes, kept outside the project
 *
 * Lives next to the holdout config (~/.config/ml-ralph/locks/<id>.json), keyed by
 * project path, so deleting or editing files inside the project cannot unlock
 * the eval. In host mode an agent with full permissions could still write
 * ~/.config; the Docker sandbox, which never mounts it, closes that.
 */

import { createHash } from "node:crypto";
import { mkdir, realpath, rename, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { holdoutConfigFile } from "./holdout.ts";

type Env = Record<string, string | undefined>;

/** What the store keeps for one project */
export interface StoredLock {
  project_path: string;
  locked_at: string;
  files: { "evaluate.py": string; "contract.json": string };
}

const HEX_SHA256 = /^[0-9a-f]{64}$/;

async function canonicalPath(projectPath: string): Promise<string> {
  try {
    return await realpath(projectPath);
  } catch {
    return resolve(projectPath);
  }
}

/** Path of the store entry for a project directory (the directory need not exist) */
export async function lockStoreFile(
  projectPath: string,
  env: Env = process.env,
): Promise<string> {
  const id = createHash("sha256")
    .update(await canonicalPath(projectPath))
    .digest("hex")
    .slice(0, 16);
  return join(dirname(holdoutConfigFile(env)), "locks", `${id}.json`);
}

function parseStored(value: unknown): StoredLock | null {
  const v = value as Partial<StoredLock> | null;
  const files = v?.files as Record<string, unknown> | undefined;
  if (
    typeof v !== "object" ||
    v === null ||
    typeof v.project_path !== "string" ||
    typeof v.locked_at !== "string" ||
    typeof files !== "object" ||
    files === null
  ) {
    return null;
  }
  for (const name of ["evaluate.py", "contract.json"]) {
    const hash = files[name];
    if (typeof hash !== "string" || !HEX_SHA256.test(hash)) return null;
  }
  return v as StoredLock;
}

/** The project's store entry; null when there is none (or it is unreadable) */
export async function readStoredLock(
  projectPath: string,
  env: Env = process.env,
): Promise<StoredLock | null> {
  try {
    return parseStored(
      await Bun.file(await lockStoreFile(projectPath, env)).json(),
    );
  } catch {
    return null;
  }
}

/** Write the project's store entry atomically. The error names the path that failed. */
export async function writeStoredLock(
  projectPath: string,
  lock: Pick<StoredLock, "locked_at" | "files">,
  env: Env = process.env,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const file = await lockStoreFile(projectPath, env);
  const entry: StoredLock = {
    project_path: await canonicalPath(projectPath),
    locked_at: lock.locked_at,
    files: lock.files,
  };
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    await mkdir(dirname(file), { recursive: true });
    await Bun.write(tmp, `${JSON.stringify(entry, null, 2)}\n`);
    await rename(tmp, file);
    return { ok: true };
  } catch (error) {
    await rm(tmp, { force: true }).catch(() => {});
    return {
      ok: false,
      error: `Cannot write the eval lock to the user-level store ${file}: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

/** Remove the project's store entry. Returns whether there was one. */
export async function clearStoredLock(
  projectPath: string,
  env: Env = process.env,
): Promise<boolean> {
  const file = await lockStoreFile(projectPath, env);
  const existed = await Bun.file(file).exists();
  await rm(file, { force: true });
  return existed;
}

/**
 * Move the store entry of a project that used to live at `oldPath` to
 * `projectPath`, after the directory was moved.
 */
export async function rekeyStoredLock(
  oldPath: string,
  projectPath: string,
  env: Env = process.env,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const old = await readStoredLock(oldPath, env);
  if (!old) {
    return {
      ok: false,
      error: `No lock in the user-level store for ${resolve(oldPath)} (looked in ${await lockStoreFile(oldPath, env)})`,
    };
  }
  const written = await writeStoredLock(projectPath, old, env);
  if (!written.ok) return written;
  await clearStoredLock(oldPath, env);
  return { ok: true };
}
