/**
 * Eval contract lock - hashes .ml-ralph/eval/ files once the PRD is approved
 */

import { createHash } from "node:crypto";
import { validateEvalContract } from "../../domain/validation/index.ts";
import { readPrdFile } from "./log-parser.ts";

export interface EvalLock {
  locked_at: string;
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

/** Hash the validated eval files and write lock.json plus the creation marker */
async function writeLock(projectPath: string): Promise<EvalLockResult> {
  const files = await checkEvalFiles(projectPath);
  if (!files.ok) return { ok: false, error: files.errors.join("; ") };

  const lock: EvalLock = {
    locked_at: new Date().toISOString(),
    files: {
      "evaluate.py": sha256(files.evaluateBytes),
      "contract.json": sha256(files.contractBytes),
    },
  };
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

/**
 * Decide whether an iteration may start. A draft or missing PRD counts as
 * SETUP and may start, unless a lock or its marker exists: resetting the PRD to
 * draft must not switch the checks off. Past SETUP (approved, complete, blocked, anything
 * else) an existing lock.json must be well-formed and still cover valid files.
 * A missing lock is created once, for an approved PRD; if one was created
 * before and has since disappeared, the gate refuses rather than re-locking
 * whatever the eval files hold now. The returned error is the reason to refuse.
 */
export async function checkEvalGate(
  projectPath: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const prd = await readPrdFile(projectPath);
  const lockExists = await Bun.file(`${projectPath}/${LOCK_PATH}`).exists();
  const markerExists = await Bun.file(
    `${projectPath}/${LOCK_MARKER_PATH}`,
  ).exists();

  if ((!prd || prd.status === "draft") && !lockExists && !markerExists) {
    return { ok: true };
  }

  if (lockExists) {
    const problem = await checkExistingLock(projectPath);
    if (problem === null) return { ok: true };
    return {
      ok: false,
      error: `Refusing to run: invalid eval lock: ${problem}`,
    };
  }

  if (markerExists) {
    return {
      ok: false,
      error: `Refusing to run: ${LOCK_PATH} was removed after the eval contract was locked. Restore it, or if the eval files were changed on purpose, remove ${LOCK_MARKER_PATH} to lock them again.`,
    };
  }

  // Reaching here means a PRD past SETUP: the draft/missing case returned above
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
