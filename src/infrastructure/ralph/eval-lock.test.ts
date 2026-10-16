/**
 * Tests for the eval contract lock and the runner's refusal without one
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkEvalGate, lockEvalContract } from "./eval-lock.ts";
import { RalphRunner } from "./runner.ts";

const CONTRACT = {
  primary_metric: "auc",
  direction: "max",
  search_split: "cv_5fold",
  seeds: [0, 1],
  protocol: "5-fold CV",
  success_threshold: 0.9,
  holdout_gap_threshold: 0.02,
  eval_timeout_seconds: 600,
  baseline_score: 0.8,
};
const EVALUATE_PY = "print('score')\n";

let dir: string;
const evalPath = (name: string) => join(dir, ".ml-ralph/eval", name);
const sha = (text: string) => createHash("sha256").update(text).digest("hex");

async function setup(opts: {
  status?: string;
  contract?: unknown;
  evaluate?: boolean;
}) {
  await mkdir(join(dir, ".ml-ralph/eval"), { recursive: true });
  await Bun.write(join(dir, ".ml-ralph/RALPH.md"), "# ralph");
  await Bun.write(
    join(dir, ".ml-ralph/prd.json"),
    JSON.stringify({ project: "p", status: opts.status ?? "approved" }),
  );
  if (opts.contract !== undefined) {
    await Bun.write(evalPath("contract.json"), JSON.stringify(opts.contract));
  }
  if (opts.evaluate !== false)
    await Bun.write(evalPath("evaluate.py"), EVALUATE_PY);
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "ml-ralph-lock-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("lockEvalContract", () => {
  test("writes lock.json with hashes and lock time", async () => {
    await setup({ contract: CONTRACT });
    const result = await lockEvalContract(dir);
    expect(result.ok).toBe(true);

    const lock = await Bun.file(evalPath("lock.json")).json();
    expect(lock.files["evaluate.py"]).toBe(sha(EVALUATE_PY));
    expect(lock.files["contract.json"]).toBe(sha(JSON.stringify(CONTRACT)));
    expect(Number.isNaN(Date.parse(lock.locked_at))).toBe(false);
  });

  test("fails when the PRD is not approved", async () => {
    await setup({ status: "draft", contract: CONTRACT });
    const result = await lockEvalContract(dir);
    expect(result).toMatchObject({ ok: false });
    expect(await Bun.file(evalPath("lock.json")).exists()).toBe(false);
  });

  test("fails naming contract.json when it is missing", async () => {
    await setup({});
    const result = await lockEvalContract(dir);
    expect(result).toEqual({
      ok: false,
      error: ".ml-ralph/eval/contract.json does not exist",
    });
  });

  test("fails when contract.json is not JSON", async () => {
    await setup({});
    await Bun.write(evalPath("contract.json"), "{nope");
    const result = await lockEvalContract(dir);
    expect(result.ok === false && result.error).toContain("not valid JSON");
  });

  test("fails naming the invalid field", async () => {
    await setup({ contract: { ...CONTRACT, direction: "up", seeds: [] } });
    const result = await lockEvalContract(dir);
    expect(result.ok).toBe(false);
    const error = result.ok ? "" : result.error;
    expect(error).toContain("contract.json");
    expect(error).toContain("direction");
    expect(error).toContain("seeds");
    expect(await Bun.file(evalPath("lock.json")).exists()).toBe(false);
  });

  test("fails naming baseline_score when it is missing", async () => {
    const { baseline_score: _omit, ...noBaseline } = CONTRACT;
    await setup({ contract: noBaseline });
    const result = await lockEvalContract(dir);
    expect(result.ok === false && result.error).toContain("baseline_score");
  });

  test("reports both the contract and evaluate.py problems", async () => {
    const { baseline_score: _omit, ...noBaseline } = CONTRACT;
    await setup({ contract: noBaseline, evaluate: false });
    const result = await lockEvalContract(dir);
    const error = result.ok ? "" : result.error;
    expect(error).toContain("baseline_score");
    expect(error).toContain("evaluate.py does not exist");
  });

  test("fails naming evaluate.py when it does not exist", async () => {
    await setup({ contract: CONTRACT, evaluate: false });
    const result = await lockEvalContract(dir);
    expect(result).toEqual({
      ok: false,
      error: ".ml-ralph/eval/evaluate.py does not exist",
    });
  });
});

describe("checkEvalGate", () => {
  test("allows SETUP without a lock", async () => {
    await setup({ status: "draft" });
    expect(await checkEvalGate(dir)).toEqual({ ok: true });
  });

  test("allows SETUP when there is no PRD at all", async () => {
    expect(await checkEvalGate(dir)).toEqual({ ok: true });
  });

  test("locks a valid contract on approval", async () => {
    await setup({ contract: CONTRACT });
    expect(await checkEvalGate(dir)).toEqual({ ok: true });
    expect(await Bun.file(evalPath("lock.json")).exists()).toBe(true);
  });

  test("refuses after SETUP when the lock cannot be made", async () => {
    await setup({});
    const gate = await checkEvalGate(dir);
    expect(gate.ok).toBe(false);
    expect(gate.ok === false && gate.error).toContain("lock.json");
    expect(gate.ok === false && gate.error).toContain("contract.json");
  });

  test("passes when an existing lock is well-formed and files are valid", async () => {
    await setup({ contract: CONTRACT });
    await lockEvalContract(dir);
    expect(await checkEvalGate(dir)).toEqual({ ok: true });
  });

  test.each([
    ["empty", ""],
    ["not JSON", "{nope"],
    ["JSON null", "null"],
    ["empty object", "{}"],
    [
      "missing a hash",
      JSON.stringify({ locked_at: new Date().toISOString(), files: {} }),
    ],
    [
      "non-hex hash",
      JSON.stringify({
        locked_at: new Date().toISOString(),
        files: { "evaluate.py": "x", "contract.json": "y" },
      }),
    ],
    [
      "bad lock time",
      JSON.stringify({
        locked_at: "never",
        files: { "evaluate.py": sha("a"), "contract.json": sha("b") },
      }),
    ],
  ])("refuses a malformed lock.json (%s)", async (_name, content) => {
    await setup({ contract: CONTRACT });
    await Bun.write(evalPath("lock.json"), content);
    const gate = await checkEvalGate(dir);
    expect(gate.ok).toBe(false);
    expect(gate.ok === false && gate.error).toContain("lock.json");
  });

  test("refuses a well-formed lock whose files are gone or invalid", async () => {
    await setup({ contract: CONTRACT });
    await lockEvalContract(dir);
    await rm(evalPath("evaluate.py"));
    await Bun.write(evalPath("contract.json"), JSON.stringify({}));
    const gate = await checkEvalGate(dir);
    expect(gate.ok).toBe(false);
    const error = gate.ok ? "" : gate.error;
    expect(error).toContain("evaluate.py does not exist");
    expect(error).toContain("contract.json is invalid");
  });

  test("refuses to re-lock when lock.json disappears after being created", async () => {
    await setup({ contract: CONTRACT });
    expect(await checkEvalGate(dir)).toEqual({ ok: true });

    await Bun.write(evalPath("evaluate.py"), "print('cheat')\n");
    await rm(evalPath("lock.json"));

    const gate = await checkEvalGate(dir);
    expect(gate.ok).toBe(false);
    expect(gate.ok === false && gate.error).toContain("removed");
    expect(await Bun.file(evalPath("lock.json")).exists()).toBe(false);
  });

  test.each([
    "blocked",
    "complete",
    "weird",
  ])("treats a %s PRD as past SETUP and refuses without a lock", async (status) => {
    await setup({ status, contract: CONTRACT });
    const gate = await checkEvalGate(dir);
    expect(gate.ok).toBe(false);
    expect(gate.ok === false && gate.error).toContain(status);
    expect(await Bun.file(evalPath("lock.json")).exists()).toBe(false);
  });

  test("lets a blocked PRD run when its lock is valid", async () => {
    await setup({ contract: CONTRACT });
    await lockEvalContract(dir);
    await Bun.write(
      join(dir, ".ml-ralph/prd.json"),
      JSON.stringify({ project: "p", status: "blocked" }),
    );
    expect(await checkEvalGate(dir)).toEqual({ ok: true });
  });

  test("refuses a completed PRD that has no lock", async () => {
    await setup({ status: "complete", contract: CONTRACT });
    expect((await checkEvalGate(dir)).ok).toBe(false);
  });
});

describe("RalphRunner without a lock", () => {
  test("reports the reason and starts no iteration", async () => {
    await setup({});
    const errors: Error[] = [];
    const iterations: number[] = [];
    const runner = new RalphRunner({
      projectPath: dir,
      onError: (e) => errors.push(e),
      onIterationStart: (i) => iterations.push(i),
    });

    await runner.start();

    expect(iterations).toEqual([]);
    expect(errors).toHaveLength(1);
    expect(errors[0]?.message).toContain("no eval lock");
    expect(errors[0]?.message).toContain("contract.json");
    expect(runner.isRunning()).toBe(false);
  });
});
