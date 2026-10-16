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

export type EvalLockResult =
  | { ok: true; lock: EvalLock }
  | { ok: false; error: string };

const sha256 = (data: Uint8Array) =>
  createHash("sha256").update(data).digest("hex");

const CONTRACT_PATH = ".ml-ralph/eval/contract.json";
const EVALUATE_PATH = ".ml-ralph/eval/evaluate.py";
const LOCK_PATH = ".ml-ralph/eval/lock.json";
const HEX_SHA256 = /^[0-9a-f]{64}$/;

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
  return { ok: true, lock };
}

/**
 * Check an existing lock.json: it must have the lock shape and the files it
 * covers must still exist and validate. Hash drift is not checked here.
 */
async function checkExistingLock(projectPath: string): Promise<string | null> {
  let lock: unknown;
  try {
    lock = await Bun.file(`${projectPath}/${LOCK_PATH}`).json();
  } catch {
    return `${LOCK_PATH} is not valid JSON`;
  }

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
    ["evaluate.py", "contract.json"].every((name) => {
      const hash = hashes[name];
      return typeof hash === "string" && HEX_SHA256.test(hash);
    });
  if (!wellFormed) {
    return `${LOCK_PATH} is malformed (needs locked_at and SHA-256 hashes of evaluate.py and contract.json)`;
  }

  const files = await checkEvalFiles(projectPath);
  return files.ok ? null : files.errors.join("; ");
}

/**
 * Decide whether an iteration may start. During SETUP (no approved PRD) it
 * always may. Once the PRD is approved, a missing lock.json is created from
 * the eval files and an existing one must be well-formed and still cover
 * valid files; otherwise the returned error is the reason to refuse.
 */
export async function checkEvalGate(
  projectPath: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const prd = await readPrdFile(projectPath);
  if (prd?.status !== "approved" && prd?.status !== "complete") {
    return { ok: true };
  }

  if (await Bun.file(`${projectPath}/${LOCK_PATH}`).exists()) {
    const problem = await checkExistingLock(projectPath);
    if (problem === null) return { ok: true };
    return {
      ok: false,
      error: `Refusing to run: invalid eval lock: ${problem}`,
    };
  }

  const locked =
    prd.status === "approved"
      ? await lockEvalContract(projectPath)
      : { ok: false as const, error: "" };
  if (locked.ok) return { ok: true };

  const reason = locked.error ? `: ${locked.error}` : "";
  return {
    ok: false,
    error: `Refusing to run: no eval lock (${LOCK_PATH})${reason}`,
  };
}
