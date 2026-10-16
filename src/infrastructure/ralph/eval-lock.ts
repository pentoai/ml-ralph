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

/**
 * Validate the eval contract and write .ml-ralph/eval/lock.json.
 * Fails with a message naming the field or file at fault.
 */
export async function lockEvalContract(
  projectPath: string,
): Promise<EvalLockResult> {
  const evalDir = `${projectPath}/.ml-ralph/eval`;

  const prd = await readPrdFile(projectPath);
  if (prd?.status !== "approved") {
    return { ok: false, error: 'prd.json: status must be "approved" to lock' };
  }

  const contractFile = Bun.file(`${evalDir}/contract.json`);
  if (!(await contractFile.exists())) {
    return { ok: false, error: ".ml-ralph/eval/contract.json does not exist" };
  }
  const contractBytes = new Uint8Array(await contractFile.arrayBuffer());

  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(contractBytes));
  } catch {
    return {
      ok: false,
      error: ".ml-ralph/eval/contract.json is not valid JSON",
    };
  }

  const validation = validateEvalContract(parsed);
  if (!validation.valid) {
    const detail = validation.errors
      .map((e) => `${e.field} ${e.message}`)
      .join("; ");
    return {
      ok: false,
      error: `.ml-ralph/eval/contract.json is invalid: ${detail}`,
    };
  }

  const evaluateFile = Bun.file(`${evalDir}/evaluate.py`);
  if (!(await evaluateFile.exists())) {
    return { ok: false, error: ".ml-ralph/eval/evaluate.py does not exist" };
  }

  const lock: EvalLock = {
    locked_at: new Date().toISOString(),
    files: {
      "evaluate.py": sha256(new Uint8Array(await evaluateFile.arrayBuffer())),
      "contract.json": sha256(contractBytes),
    },
  };
  await Bun.write(`${evalDir}/lock.json`, `${JSON.stringify(lock, null, 2)}\n`);
  return { ok: true, lock };
}

/**
 * Decide whether an iteration may start. During SETUP (no approved PRD) it
 * always may. Once the PRD is approved, a missing lock.json is created from
 * the eval files; if that fails the returned error is the reason to refuse.
 */
export async function checkEvalGate(
  projectPath: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const prd = await readPrdFile(projectPath);
  if (prd?.status !== "approved" && prd?.status !== "complete") {
    return { ok: true };
  }

  const lockFile = Bun.file(`${projectPath}/.ml-ralph/eval/lock.json`);
  if (await lockFile.exists()) return { ok: true };

  const locked =
    prd.status === "approved"
      ? await lockEvalContract(projectPath)
      : { ok: false as const, error: "" };
  if (locked.ok) return { ok: true };

  const reason = locked.error ? `: ${locked.error}` : "";
  return {
    ok: false,
    error: `Refusing to run: no eval lock (.ml-ralph/eval/lock.json)${reason}`,
  };
}
