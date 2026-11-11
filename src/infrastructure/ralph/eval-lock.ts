/**
 * Eval contract lock - hashes .ml-ralph/eval/ files once the PRD is approved
 */

import { createHash } from "node:crypto";
import { rm } from "node:fs/promises";
import { validateEvalContract } from "../../domain/validation/index.ts";
import {
  clearStoredLock,
  lockStoreFile,
  readStoredLock,
  writeStoredLock,
} from "./lock-store.ts";
import { readPrdFile } from "./log-parser.ts";

export interface EvalLock {
  locked_at: string;
  /** Set when the runner also wrote the hashes to the user-level store (absent in locks made before it existed) */
  user_store?: true;
  files: {
    "evaluate.py": string;
    "contract.json": string;
  };
}

export type EvalFileName = keyof EvalLock["files"];

/** A locked file whose current content no longer matches the locked hash */
export interface EvalChange {
  file: EvalFileName;
  kind: "edited" | "deleted";
}

export type EvalLockResult =
  | { ok: true; lock: EvalLock }
  | { ok: false; error: string };

export const sha256 = (data: Uint8Array) =>
  createHash("sha256").update(data).digest("hex");

const CONTRACT_PATH = ".ml-ralph/eval/contract.json";
const EVALUATE_PATH = ".ml-ralph/eval/evaluate.py";
const LOCK_PATH = ".ml-ralph/eval/lock.json";
const LOCK_MARKER_PATH = ".ml-ralph/eval-lock.created";
const HEX_SHA256 = /^[0-9a-f]{64}$/;
const LOCKED_FILES: Record<EvalFileName, string> = {
  "evaluate.py": EVALUATE_PATH,
  "contract.json": CONTRACT_PATH,
};

/**
 * Check that contract.json validates and evaluate.py exists, collecting every
 * problem so the user can fix them in one round. Returns the raw bytes on success.
 */
async function checkEvalFiles(
  projectPath: string,
): Promise<
  | { ok: true; contractBytes: Uint8Array; evaluateBytes: Uint8Array }
  | { ok: false; errors: string[] }
> {
  const errors: string[] = [];

  const contractFile = Bun.file(`${projectPath}/${CONTRACT_PATH}`);
  let contractBytes: Uint8Array | null = null;
  if (!(await contractFile.exists())) {
    errors.push(`${CONTRACT_PATH} does not exist`);
  } else {
    const bytes = new Uint8Array(await contractFile.arrayBuffer());
    let parsed: unknown;
    let parseable = true;
    try {
      parsed = JSON.parse(new TextDecoder().decode(bytes));
    } catch {
      parseable = false;
      errors.push(`${CONTRACT_PATH} is not valid JSON`);
    }
    if (parseable) {
      const validation = validateEvalContract(parsed);
      if (validation.valid) {
        contractBytes = bytes;
      } else {
        const detail = validation.errors
          .map((e) => `${e.field} ${e.message}`)
          .join("; ");
        errors.push(`${CONTRACT_PATH} is invalid: ${detail}`);
      }
    }
  }

  const evaluateFile = Bun.file(`${projectPath}/${EVALUATE_PATH}`);
  let evaluateBytes: Uint8Array | null = null;
  if (await evaluateFile.exists()) {
    evaluateBytes = new Uint8Array(await evaluateFile.arrayBuffer());
  } else {
    errors.push(`${EVALUATE_PATH} does not exist`);
  }

  if (!contractBytes || !evaluateBytes) return { ok: false, errors };
  return { ok: true, contractBytes, evaluateBytes };
}

/** Hash the validated eval files; write the user-level store entry, then lock.json and the creation marker */
async function writeLock(projectPath: string): Promise<EvalLockResult> {
  const files = await checkEvalFiles(projectPath);
  if (!files.ok) return { ok: false, error: files.errors.join("; ") };

  const lock: EvalLock = {
    locked_at: new Date().toISOString(),
    user_store: true,
    files: {
      "evaluate.py": sha256(files.evaluateBytes),
      "contract.json": sha256(files.contractBytes),
    },
  };
  // The user-level copy is the one the gate trusts: if it cannot be written, nothing is locked
  const stored = await writeStoredLock(projectPath, lock);
  if (!stored.ok) return { ok: false, error: stored.error };
  await Bun.write(
    `${projectPath}/${LOCK_PATH}`,
    `${JSON.stringify(lock, null, 2)}\n`,
  );
  await Bun.write(`${projectPath}/${LOCK_MARKER_PATH}`, `${lock.locked_at}\n`);
  return { ok: true, lock };
}

/**
 * Validate the eval contract and write .ml-ralph/eval/lock.json.
 * Fails with a message naming every field or file at fault.
 */
export async function lockEvalContract(
  projectPath: string,
): Promise<EvalLockResult> {
  const prd = await readPrdFile(projectPath);
  if (prd?.status !== "approved") {
    return { ok: false, error: 'prd.json: status must be "approved" to lock' };
  }
  return writeLock(projectPath);
}

/**
 * Lock the files as they are now, after the user accepted a change. Unlike
 * lockEvalContract it does not look at the PRD status: the decision is the
 * user's. The files must still validate.
 */
export async function relockEvalContract(
  projectPath: string,
): Promise<EvalLockResult> {
  return writeLock(projectPath);
}

/** Return the lock if it has the lock shape (locked_at and two SHA-256 hashes) */
function parseLock(lock: unknown): EvalLock | null {
  const l = lock as {
    locked_at?: unknown;
    files?: Record<string, unknown> | null;
  } | null;
  const hashes = l?.files;
  const wellFormed =
    typeof l === "object" &&
    l !== null &&
    typeof l.locked_at === "string" &&
    !Number.isNaN(Date.parse(l.locked_at)) &&
    typeof hashes === "object" &&
    hashes !== null &&
    Object.keys(LOCKED_FILES).every((name) => {
      const hash = hashes[name];
      return typeof hash === "string" && HEX_SHA256.test(hash);
    });
  return wellFormed ? (lock as EvalLock) : null;
}

/** Read lock.json; null when it is missing, unparseable or malformed */
export async function readEvalLock(
  projectPath: string,
): Promise<EvalLock | null> {
  try {
    return parseLock(await Bun.file(`${projectPath}/${LOCK_PATH}`).json());
  } catch {
    return null;
  }
}

/**
 * The hashes to check the eval files against: the user-level store entry when
 * there is one, else the project's lock.json (a project locked before the store).
 */
export async function readLockHashes(
  projectPath: string,
): Promise<EvalLock["files"] | null> {
  return (
    (await readStoredLock(projectPath))?.files ??
    (await readEvalLock(projectPath))?.files ??
    null
  );
}

/**
 * Re-hash the locked files and list those that no longer match `expected`.
 * A missing file is "deleted"; any other difference is "edited".
 */
export async function findEvalChanges(
  projectPath: string,
  expected: EvalLock["files"],
): Promise<EvalChange[]> {
  const changes: EvalChange[] = [];
  for (const file of Object.keys(LOCKED_FILES) as EvalFileName[]) {
    const handle = Bun.file(`${projectPath}/${LOCKED_FILES[file]}`);
    if (!(await handle.exists())) {
      changes.push({ file, kind: "deleted" });
    } else if (
      sha256(new Uint8Array(await handle.arrayBuffer())) !== expected[file]
    ) {
      changes.push({ file, kind: "edited" });
    }
  }
  return changes;
}

/** One line naming each changed file, e.g. "evaluate.py was edited" */
export function describeEvalChanges(changes: EvalChange[]): string {
  return changes.map((c) => `${c.file} was ${c.kind}`).join("; ");
}

/**
 * Check an existing lock.json: it must have the lock shape and the files it
 * covers must still exist and validate. Hash drift is not checked here.
 */
async function checkExistingLock(projectPath: string): Promise<string | null> {
  try {
    await Bun.file(`${projectPath}/${LOCK_PATH}`).json();
  } catch {
    return `${LOCK_PATH} is not valid JSON`;
  }
  if (!(await readEvalLock(projectPath))) {
    return `${LOCK_PATH} is malformed (needs locked_at and SHA-256 hashes of evaluate.py and contract.json)`;
  }

  const files = await checkEvalFiles(projectPath);
  return files.ok ? null : files.errors.join("; ");
}

export type EvalGateResult =
  | {
      ok: true;
      /** Set when this call copied a project lock made before the store into it */
      migrated?: EvalLock["files"];
    }
  | { ok: false; error: string };

const sameHashes = (a: EvalLock["files"], b: EvalLock["files"]) =>
  a["evaluate.py"] === b["evaluate.py"] &&
  a["contract.json"] === b["contract.json"];

/**
 * Decide whether an iteration may start. The user-level store decides whether
 * the project is locked: once it has an entry, a missing or different
 * lock.json or marker refuses (`ml-ralph resume` restores them) and a draft
 * PRD does not matter. Without an entry:
 * - a project lock made before the store is copied into it once (`migrated`);
 * - a lock written with the store but no entry means the project directory moved: refuse;
 * - a draft or missing PRD with no lock or marker is SETUP and may start;
 * - an approved PRD is locked once; a marker without lock.json refuses, as does any other status.
 * The returned error is the reason to refuse.
 */
export async function checkEvalGate(
  projectPath: string,
): Promise<EvalGateResult> {
  const stored = await readStoredLock(projectPath);
  const lockExists = await Bun.file(`${projectPath}/${LOCK_PATH}`).exists();
  const markerExists = await Bun.file(
    `${projectPath}/${LOCK_MARKER_PATH}`,
  ).exists();

  if (stored) {
    const missing = [
      ...(lockExists ? [] : [LOCK_PATH]),
      ...(markerExists ? [] : [LOCK_MARKER_PATH]),
    ];
    if (missing.length > 0) {
      return {
        ok: false,
        error: `Refusing to run: ${missing.join(" and ")} ${missing.length > 1 ? "are" : "is"} missing from the project, but the eval is locked in the user-level store. Run \`ml-ralph resume\` to restore ${missing.length > 1 ? "them" : "it"} from the store.`,
      };
    }
    const projectLock = await readEvalLock(projectPath);
    if (!projectLock || !sameHashes(projectLock.files, stored.files)) {
      return {
        ok: false,
        error: `Refusing to run: ${LOCK_PATH} does not match the lock in the user-level store. Run \`ml-ralph resume\` to restore it from the store.`,
      };
    }
    const problem = await checkExistingLock(projectPath);
    if (problem === null) return { ok: true };
    return {
      ok: false,
      error: `Refusing to run: invalid eval lock: ${problem}`,
    };
  }

  const prd = await readPrdFile(projectPath);

  if (lockExists) {
    const problem = await checkExistingLock(projectPath);
    if (problem !== null) {
      return {
        ok: false,
        error: `Refusing to run: invalid eval lock: ${problem}`,
      };
    }
    const lock = (await readEvalLock(projectPath)) as EvalLock;
    if (lock.user_store) {
      return {
        ok: false,
        error: `Refusing to run: this project has an eval lock but the user-level store (${await lockStoreFile(projectPath)}) has no entry for ${projectPath}; the project directory was probably moved. Run \`ml-ralph rekey <old-project-path>\` to move the old entry here, or \`ml-ralph unlock\` to clear the lock and lock the eval again on purpose.`,
      };
    }
    // Locked before the store existed: copy it over once
    const migrated = await writeStoredLock(projectPath, lock);
    if (!migrated.ok) {
      return { ok: false, error: `Refusing to run: ${migrated.error}` };
    }
    if (!markerExists) {
      await Bun.write(
        `${projectPath}/${LOCK_MARKER_PATH}`,
        `${lock.locked_at}\n`,
      );
    }
    return { ok: true, migrated: lock.files };
  }

  if (!prd || prd.status === "draft") {
    if (!markerExists) return { ok: true };
  }

  if (markerExists) {
    return {
      ok: false,
      error: `Refusing to run: ${LOCK_PATH} was removed after the eval contract was locked. Restore it, or if the eval files were changed on purpose, remove ${LOCK_MARKER_PATH} to lock them again.`,
    };
  }

  const locked =
    prd?.status === "approved"
      ? await lockEvalContract(projectPath)
      : {
          ok: false as const,
          error: `prd.json: status is "${prd?.status}", not "approved"`,
        };
  if (locked.ok) return { ok: true };

  return {
    ok: false,
    error: `Refusing to run: no eval lock (${LOCK_PATH}): ${locked.error}`,
  };
}

/**
 * Restore lock.json and the creation marker in the project from the user-level
 * store. Hash drift in the eval files is not touched: the runner pauses on it.
 */
export async function restoreEvalLock(
  projectPath: string,
): Promise<{ ok: true; restored: string[] } | { ok: false; error: string }> {
  const stored = await readStoredLock(projectPath);
  if (!stored) {
    return {
      ok: false,
      error: `No eval lock in the user-level store for ${projectPath} (${await lockStoreFile(projectPath)}). If the project directory moved, run \`ml-ralph rekey <old-project-path>\`.`,
    };
  }
  const lock: EvalLock = {
    locked_at: stored.locked_at,
    user_store: true,
    files: stored.files,
  };
  await Bun.write(
    `${projectPath}/${LOCK_PATH}`,
    `${JSON.stringify(lock, null, 2)}\n`,
  );
  await Bun.write(`${projectPath}/${LOCK_MARKER_PATH}`, `${lock.locked_at}\n`);
  return { ok: true, restored: [LOCK_PATH, LOCK_MARKER_PATH] };
}

/**
 * Clear the project's store entry and its project copies (lock.json and the
 * marker) so the eval can be locked again on purpose. Eval files are untouched.
 */
export async function unlockEval(
  projectPath: string,
): Promise<{ cleared: boolean; storeFile: string }> {
  const storeFile = await lockStoreFile(projectPath);
  const cleared = await clearStoredLock(projectPath);
  await rm(`${projectPath}/${LOCK_PATH}`, { force: true });
  await rm(`${projectPath}/${LOCK_MARKER_PATH}`, { force: true });
  return { cleared, storeFile };
}
