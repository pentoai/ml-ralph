/**
 * Tests for `ml-ralph eval` with a fake evaluate.py (no real training, no claude)
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runEvalCommand } from "./eval-command.ts";
import { lockEvalContract } from "./eval-lock.ts";
import {
  EVALS_DIR,
  type EvalMetricsFailed,
  type EvalMetricsOk,
  readEvalMetrics,
} from "./eval-metrics.ts";

/** The candidate file's content picks the behaviour; every call is recorded in calls.jsonl */
const FAKE_EVALUATE = `import argparse, json, os, subprocess, sys, time

ap = argparse.ArgumentParser()
ap.add_argument("--candidate")
ap.add_argument("--split")
ap.add_argument("--seed", type=int)
a = ap.parse_args()
with open(os.path.join(os.path.dirname(__file__), "calls.jsonl"), "a") as f:
    f.write(json.dumps({"argv": sys.argv[1:], "cwd": os.getcwd()}) + "\\n")
mode = open(a.candidate).read().strip()
if mode == "ok":
    print("training noise")
    print(json.dumps({"score": 0.5 + a.seed / 10}))
elif mode == "crash":
    sys.stderr.write("boom: bad shape\\n")
    sys.exit(3)
elif mode == "garbage":
    print("not json")
elif mode == "no-score":
    print(json.dumps({"auc": 0.9}))
elif mode == "string-score":
    print(json.dumps({"score": "0.9"}))
elif mode == "fail-second-seed":
    if a.seed == 1:
        sys.exit(1)
    print(json.dumps({"score": 0.7}))
elif mode == "hang":
    child = subprocess.Popen(["sleep", "60"])
    with open(os.path.join(os.path.dirname(__file__), "child.pid"), "w") as f:
        f.write(str(child.pid))
    time.sleep(60)
`;

const CONTRACT = {
  primary_metric: "auc",
  direction: "max",
  search_split: "cv_5fold",
  seeds: [0, 1, 2],
  protocol: "5-fold CV",
  success_threshold: 0.9,
  holdout_gap_threshold: 0.02,
  eval_timeout_seconds: 30,
  baseline_score: 0.5,
};

let dir: string;
const evalFile = (name: string) => join(dir, ".ml-ralph/eval", name);

async function setup(contract: object = CONTRACT, lock = true) {
  await mkdir(join(dir, ".ml-ralph/eval"), { recursive: true });
  await Bun.write(
    join(dir, ".ml-ralph/prd.json"),
    JSON.stringify({ project: "p", status: "approved" }),
  );
  await Bun.write(evalFile("contract.json"), JSON.stringify(contract));
  await Bun.write(evalFile("evaluate.py"), FAKE_EVALUATE);
  if (lock) expect((await lockEvalContract(dir)).ok).toBe(true);
}

/** Write a candidate whose content selects the fake evaluator's behaviour */
async function candidate(mode: string, name = "cand.txt") {
  await Bun.write(join(dir, name), mode);
  return name;
}

const calls = async () => {
  const file = Bun.file(evalFile("calls.jsonl"));
  if (!(await file.exists())) return [];
  return (await file.text())
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l) as { argv: string[]; cwd: string });
};

const logEvents = async () => {
  const file = Bun.file(join(dir, ".ml-ralph/log.jsonl"));
  if (!(await file.exists())) return [];
  return (await file.text())
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l) as Record<string, unknown>);
};

const evalDirs = () =>
  readdir(join(dir, EVALS_DIR)).catch(() => [] as string[]);

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "ml-ralph-eval-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("success", () => {
  test("runs evaluate.py once per seed and writes metrics.json", async () => {
    await setup();
    const result = await runEvalCommand([await candidate("ok")], { cwd: dir });

    expect(result.code).toBe(0);
    const metrics = result.metrics as EvalMetricsOk;
    expect(metrics.status).toBe("ok");
    expect(result.stdout).toContain(metrics.eval_id);

    expect(await calls()).toEqual([
      ...[0, 1, 2].map((seed) => ({
        argv: [
          "--candidate",
          join(dir, "cand.txt"),
          "--split",
          "cv_5fold",
          "--seed",
          String(seed),
        ],
        cwd: dir,
      })),
    ]);

    const onDisk = (await Bun.file(
      join(dir, EVALS_DIR, metrics.eval_id, "metrics.json"),
    ).json()) as EvalMetricsOk;
    const lock = (await Bun.file(evalFile("lock.json")).json()) as {
      files: Record<string, string>;
    };
    expect(onDisk.eval_id).toBe(metrics.eval_id);
    expect(onDisk.contract_hash).toBe(lock.files["contract.json"] as string);
    expect(onDisk.evaluate_hash).toBe(lock.files["evaluate.py"] as string);
    expect(onDisk.candidate).toBe("cand.txt");
    expect(onDisk.split).toBe("cv_5fold");
    expect(onDisk.status).toBe("ok");
    expect(onDisk.scores).toEqual([
      { seed: 0, score: 0.5 },
      { seed: 1, score: 0.6 },
      { seed: 2, score: 0.7 },
    ]);
    expect(onDisk.mean).toBeCloseTo(0.6, 10);
    expect(onDisk.std).toBeCloseTo(0.1, 10);
    expect(await readEvalMetrics(dir, metrics.eval_id)).toEqual(onDisk);
  });

  test("logs an eval event carrying the eval_id", async () => {
    await setup();
    const result = await runEvalCommand([await candidate("ok")], { cwd: dir });
    const metrics = result.metrics as EvalMetricsOk;

    expect(await logEvents()).toEqual([
      expect.objectContaining({
        type: "eval",
        eval_id: metrics.eval_id,
        status: "ok",
        candidate: "cand.txt",
        mean: metrics.mean,
        std: metrics.std,
      }),
    ]);
  });

  test("works from a subdirectory with a relative candidate", async () => {
    await setup();
    await mkdir(join(dir, "sub"));
    await candidate("ok", "sub/c.txt");
    const result = await runEvalCommand(["c.txt"], { cwd: join(dir, "sub") });

    expect(result.code).toBe(0);
    expect((result.metrics as EvalMetricsOk).candidate).toBe("sub/c.txt");
    expect((await calls())[0]?.cwd).toBe(dir);
  });

  test("std is 0 with a single seed", async () => {
    await setup({ ...CONTRACT, seeds: [7] });
    const result = await runEvalCommand([await candidate("ok")], { cwd: dir });
    const metrics = result.metrics as EvalMetricsOk;
    expect(metrics.mean).toBeCloseTo(1.2, 10);
    expect(metrics.std).toBe(0);
  });
});

describe("failure", () => {
  const failed = (result: { metrics?: unknown }) =>
    result.metrics as EvalMetricsFailed;

  test("non-zero exit writes status failed with a reason and no score", async () => {
    await setup();
    const result = await runEvalCommand([await candidate("crash")], {
      cwd: dir,
    });

    expect(result.code).not.toBe(0);
    const metrics = failed(result);
    expect(metrics.status).toBe("failed");
    expect(metrics.reason).toContain("exited with code 3");
    expect(metrics.reason).toContain("boom: bad shape");
    const raw = (await Bun.file(
      join(dir, EVALS_DIR, metrics.eval_id, "metrics.json"),
    ).json()) as Record<string, unknown>;
    expect(raw.status).toBe("failed");
    for (const key of ["scores", "mean", "std", "score"]) {
      expect(raw).not.toHaveProperty(key);
    }
    expect(await calls()).toHaveLength(1);
  });

  test.each([
    "garbage",
    "no-score",
    "string-score",
  ])("unparseable output (%s)", async (mode) => {
    await setup();
    const result = await runEvalCommand([await candidate(mode)], { cwd: dir });
    expect(result.code).not.toBe(0);
    expect(failed(result).status).toBe("failed");
    expect(failed(result).reason).toContain('numeric "score"');
  });

  test("a failing later seed discards the earlier scores", async () => {
    await setup();
    const result = await runEvalCommand([await candidate("fail-second-seed")], {
      cwd: dir,
    });
    expect(result.code).not.toBe(0);
    expect(failed(result).reason).toContain("seed 1");
    expect(failed(result)).not.toHaveProperty("scores");
    expect(await calls()).toHaveLength(2);
  });

  test("logs a failed eval event and the failed eval is not verified", async () => {
    await setup();
    const result = await runEvalCommand([await candidate("crash")], {
      cwd: dir,
    });
    const events = await logEvents();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "eval",
      eval_id: failed(result).eval_id,
      status: "failed",
    });
    expect(events[0]).not.toHaveProperty("mean");
  });

  test("timeout kills the run, including children, and records a failure", async () => {
    await setup({ ...CONTRACT, eval_timeout_seconds: 1 });
    const started = Date.now();
    const result = await runEvalCommand([await candidate("hang")], {
      cwd: dir,
    });

    expect(Date.now() - started).toBeLessThan(15_000);
    expect(result.code).not.toBe(0);
    expect(failed(result).status).toBe("failed");
    expect(failed(result).reason).toContain("timed out after 1s");
    expect(await calls()).toHaveLength(1);

    const childPid = Number(await Bun.file(evalFile("child.pid")).text());
    // SIGKILL of the group is delivered by now; signal 0 only probes for existence
    await Bun.sleep(100);
    expect(() => process.kill(childPid, 0)).toThrow();
  });
});

describe("refusal", () => {
  const expectNothingRan = async (
    result: { code: number; stderr: string },
    text: string,
  ) => {
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain(text);
    expect(await calls()).toEqual([]);
    expect(await evalDirs()).toEqual([]);
    expect(await logEvents()).toEqual([]);
  };

  test("no lock.json", async () => {
    await setup(CONTRACT, false);
    const result = await runEvalCommand([await candidate("ok")], { cwd: dir });
    await expectNothingRan(result, "lock.json");
  });

  test("a malformed lock.json", async () => {
    await setup();
    await Bun.write(evalFile("lock.json"), "{}");
    const result = await runEvalCommand([await candidate("ok")], { cwd: dir });
    await expectNothingRan(result, "lock.json");
  });

  test("evaluate.py edited after the lock", async () => {
    await setup();
    await Bun.write(evalFile("evaluate.py"), `${FAKE_EVALUATE}\n# cheat\n`);
    const result = await runEvalCommand([await candidate("ok")], { cwd: dir });
    await expectNothingRan(result, "evaluate.py was edited");
  });

  test("contract.json edited or deleted after the lock", async () => {
    await setup();
    await Bun.write(
      evalFile("contract.json"),
      JSON.stringify({ ...CONTRACT, seeds: [0] }),
    );
    const edited = await runEvalCommand([await candidate("ok")], { cwd: dir });
    await expectNothingRan(edited, "contract.json was edited");

    await rm(evalFile("contract.json"));
    const deleted = await runEvalCommand([await candidate("ok")], { cwd: dir });
    await expectNothingRan(deleted, "contract.json was deleted");
  });

  test("no .ml-ralph directory", async () => {
    const result = await runEvalCommand(["x"], { cwd: dir });
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain(".ml-ralph");
  });

  test("usage errors", async () => {
    await setup();
    expect((await runEvalCommand([], { cwd: dir })).code).toBe(2);
    expect((await runEvalCommand(["a", "b"], { cwd: dir })).code).toBe(2);
    expect(await calls()).toEqual([]);
  });
});
