/**
 * Tests for `ml-ralph tune` with the Optuna process and the train command stubbed
 * (a scripted optimizer, shell one-liners for training, a fake evaluate.py)
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeRunId } from "./budget.ts";
import { lockEvalContract } from "./eval-lock.ts";
import {
  runTuneCommand,
  type StartOptimizer,
  startOptuna,
  type TuneOptimizer,
} from "./tune-command.ts";

const EVALUATE = `import argparse, json
ap = argparse.ArgumentParser()
ap.add_argument("--candidate")
ap.add_argument("--split")
ap.add_argument("--seed", type=int)
a = ap.parse_args()
print(json.dumps({"score": float(open(a.candidate).read())}))
`;

const CONTRACT = {
  primary_metric: "auc",
  direction: "max",
  search_split: "cv",
  seeds: [0],
  protocol: "cv",
  success_threshold: 0.95,
  holdout_gap_threshold: 0.02,
  eval_timeout_seconds: 30,
  baseline_score: 0.1,
};
const SPACE = { lr: { type: "float", low: 0.01, high: 1 } };
const TRAIN = "echo {lr} > cand.txt";

let dir: string;
let saved: Record<string, string | undefined>;

const git = async (...args: string[]) => {
  const proc = Bun.spawn(
    ["git", "-c", "user.email=t@t", "-c", "user.name=t", ...args],
    { cwd: dir, stdout: "pipe", stderr: "pipe" },
  );
  const out = await new Response(proc.stdout).text();
  await proc.exited;
  return out.trim();
};

async function setup(contract: object = CONTRACT) {
  await mkdir(join(dir, ".ml-ralph/eval"), { recursive: true });
  await Bun.write(
    join(dir, ".ml-ralph/prd.json"),
    JSON.stringify({ project: "p", status: "approved" }),
  );
  await Bun.write(
    join(dir, ".ml-ralph/eval/contract.json"),
    JSON.stringify(contract),
  );
  await Bun.write(join(dir, ".ml-ralph/eval/evaluate.py"), EVALUATE);
  expect((await lockEvalContract(dir)).ok).toBe(true);
  await Bun.write(join(dir, "space.json"), JSON.stringify(SPACE));
  await Bun.write(join(dir, "train.py"), "print('train')\n");
  await git("init", "-q");
  await git("add", "train.py", "space.json");
  await git("commit", "-q", "-m", "init");
  await git("tag", "ralph/best");
}

/** An optimizer that proposes the given lr values in order and records what it was told */
function scripted(lrs: number[]) {
  const told: Array<[number, number | null]> = [];
  let asked = 0;
  const optimizer: TuneOptimizer = {
    async ask() {
      const id = asked++;
      return { id, params: { lr: lrs[id] as number } };
    },
    async tell(id, value) {
      told.push([id, value]);
    },
    async close() {},
  };
  const starts: unknown[] = [];
  const startOptimizer: StartOptimizer = async (o) => {
    starts.push(o);
    return { ok: true, optimizer };
  };
  return { startOptimizer, told, starts, asked: () => asked };
}

const logEvents = async () => {
  const file = Bun.file(join(dir, ".ml-ralph/log.jsonl"));
  if (!(await file.exists())) return [];
  return (await file.text())
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l) as Record<string, unknown>);
};

const tune = (extra: string[], opts: Parameters<typeof runTuneCommand>[1]) =>
  runTuneCommand(
    [
      "--space",
      "space.json",
      "--command",
      TRAIN,
      "--candidate",
      "cand.txt",
      ...extra,
    ],
    { cwd: dir, ...opts },
  );

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "ml-ralph-tune-"));
  saved = {
    ML_RALPH_ITERATION: process.env.ML_RALPH_ITERATION,
    ML_RALPH_MAX_EXPERIMENTS: process.env.ML_RALPH_MAX_EXPERIMENTS,
  };
  delete process.env.ML_RALPH_ITERATION;
  delete process.env.ML_RALPH_MAX_EXPERIMENTS;
});

afterEach(async () => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  await rm(dir, { recursive: true, force: true });
});

describe("a sweep", () => {
  test("logs one eval event per trial with its params, then a tune_result, and prints the best", async () => {
    await setup();
    const opt = scripted([0.2, 0.9, 0.5]);
    const r = await tune(["--trials", "3", "--seed", "7"], opt);

    expect(r.code).toBe(0);
    const events = await logEvents();
    const evals = events.filter((e) => e.type === "eval");
    expect(evals.map((e) => [e.trial, e.params, e.status, e.mean])).toEqual([
      [0, { lr: 0.2 }, "ok", 0.2],
      [1, { lr: 0.9 }, "ok", 0.9],
      [2, { lr: 0.5 }, "ok", 0.5],
    ]);
    const result = events.find((e) => e.type === "tune_result");
    expect(result).toMatchObject({
      sampler: "tpe",
      trials_requested: 3,
      trials_run: 3,
      trials_ok: 3,
      trials_failed: 0,
      best_eval_id: evals[1]?.eval_id,
      best_params: { lr: 0.9 },
      best_mean: 0.9,
    });
    expect(result?.stopped).toBeUndefined();
    expect(r.stdout).toContain(`best eval_id: ${evals[1]?.eval_id}`);
    expect(r.stdout).toContain('best params: {"lr":0.9}');
    expect(opt.told).toEqual([
      [0, 0.2],
      [1, 0.9],
      [2, 0.5],
    ]);
    expect(opt.starts[0]).toMatchObject({
      sampler: "tpe",
      direction: "max",
      seed: 7,
    });
  });

  test("minimizes when the contract's direction is min", async () => {
    await setup({ ...CONTRACT, direction: "min" });
    const opt = scripted([0.2, 0.9, 0.5]);
    const r = await tune(["--trials", "3"], opt);
    expect(r.stdout).toContain('best params: {"lr":0.2}');
    expect(opt.starts[0]).toMatchObject({ direction: "min" });
  });

  test("never promotes: ralph/best, incumbent.json and the commit stay as they were", async () => {
    await setup();
    const before = await git("rev-parse", "ralph/best");
    const head = await git("rev-parse", "HEAD");
    await tune(["--trials", "2"], scripted([0.3, 0.8]));
    expect(await git("rev-parse", "ralph/best")).toBe(before);
    expect(await git("rev-parse", "HEAD")).toBe(head);
    expect(await Bun.file(join(dir, ".ml-ralph/incumbent.json")).exists()).toBe(
      false,
    );
    expect((await logEvents()).some((e) => e.type === "promotion")).toBe(false);
  });

  test("a train command that exits non-zero is a failed trial and the sweep goes on", async () => {
    await setup();
    const opt = scripted([0.3, 0.6]);
    const r = await runTuneCommand(
      [
        "--space",
        "space.json",
        "--trials",
        "2",
        "--candidate",
        "cand.txt",
        "--command",
        "if [ {lr} = 0.3 ]; then echo oom >&2; exit 3; fi; echo {lr} > cand.txt",
      ],
      { cwd: dir, startOptimizer: opt.startOptimizer },
    );
    expect(r.code).toBe(0);
    const evals = (await logEvents()).filter((e) => e.type === "eval");
    expect(evals[0]).toMatchObject({
      status: "failed",
      trial: 0,
      params: { lr: 0.3 },
    });
    expect(evals[0]?.reason).toContain("exited with code 3: oom");
    expect(evals[1]).toMatchObject({ status: "ok", mean: 0.6 });
    expect(opt.told).toEqual([
      [0, null],
      [1, 0.6],
    ]);
    const result = (await logEvents()).find((e) => e.type === "tune_result");
    expect(result).toMatchObject({ trials_ok: 1, trials_failed: 1 });
  });

  test("quotes categorical values so they cannot break out of the command", async () => {
    await setup();
    await Bun.write(
      join(dir, "space.json"),
      JSON.stringify({
        name: { type: "categorical", choices: ["a b; touch pwned"] },
      }),
    );
    await git("add", "space.json");
    await git("commit", "-q", "-m", "space");
    const optimizer: TuneOptimizer = {
      ask: async () => ({ id: 0, params: { name: "a b; touch pwned" } }),
      tell: async () => {},
      close: async () => {},
    };
    await runTuneCommand(
      [
        "--space",
        "space.json",
        "--trials",
        "1",
        "--candidate",
        "cand.txt",
        "--command",
        "echo 0.5 > cand.txt; echo {name} > name.txt",
      ],
      { cwd: dir, startOptimizer: async () => ({ ok: true, optimizer }) },
    );
    expect(await Bun.file(join(dir, "name.txt")).text()).toBe(
      "a b; touch pwned\n",
    );
    expect(await Bun.file(join(dir, "pwned")).exists()).toBe(false);
  });
});

describe("limits", () => {
  test("stops at max_experiments_per_iteration, names it and keeps the completed trials", async () => {
    await setup();
    process.env.ML_RALPH_ITERATION = "it1";
    await Bun.write(
      join(dir, ".ml-ralph/config.json"),
      JSON.stringify({ max_experiments_per_iteration: 2 }),
    );
    const opt = scripted([0.1, 0.2, 0.3, 0.4]);
    const r = await tune(["--trials", "4"], opt);

    expect(r.code).toBe(1);
    expect(r.stderr).toContain("max_experiments_per_iteration (2)");
    expect(opt.asked()).toBe(2);
    const events = await logEvents();
    expect(events.filter((e) => e.type === "eval")).toHaveLength(2);
    expect(events.find((e) => e.type === "tune_result")).toMatchObject({
      trials_run: 2,
      stopped: "max_experiments_per_iteration",
    });
  });

  test("trials share the iteration's slots with ml-ralph eval calls", async () => {
    await setup();
    process.env.ML_RALPH_ITERATION = "it2";
    process.env.ML_RALPH_MAX_EXPERIMENTS = "3";
    const first = await tune(["--trials", "2"], scripted([0.1, 0.2]));
    expect(first.code).toBe(0);
    const second = await tune(["--trials", "2"], scripted([0.3, 0.4]));
    expect(second.code).toBe(1);
    expect(second.stderr).toContain("max_experiments_per_iteration (3)");
    expect((await logEvents()).filter((e) => e.type === "eval")).toHaveLength(
      3,
    );
  });

  test("stops before the first trial when the USD cap is already spent", async () => {
    await setup();
    await Bun.write(
      join(dir, ".ml-ralph/config.json"),
      JSON.stringify({ max_usd: 1 }),
    );
    await writeRunId(dir, "run-1");
    await Bun.write(
      join(dir, ".ml-ralph/log.jsonl"),
      `${JSON.stringify({ ts: "t", type: "budget_status", run_id: "run-1", iteration: 1, usd_spent: 1.5, elapsed_minutes: 1 })}\n`,
    );
    const opt = scripted([0.1]);
    const r = await tune(["--trials", "2"], opt);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("max_usd ($1)");
    expect(opt.asked()).toBe(0);
    expect(
      (await logEvents()).find((e) => e.type === "tune_result"),
    ).toMatchObject({
      trials_run: 0,
      stopped: "max_usd",
    });
  });

  test("stops when the wall-clock cap runs out between trials", async () => {
    await setup();
    await Bun.write(
      join(dir, ".ml-ralph/config.json"),
      JSON.stringify({ max_wall_clock_minutes: 0.01 }),
    );
    const opt = scripted([0.1, 0.2, 0.3]);
    // The first trial takes ~1s of the 0.6s allowed, so the second never starts
    const r = await runTuneCommand(
      [
        "--space",
        "space.json",
        "--trials",
        "3",
        "--candidate",
        "cand.txt",
        "--command",
        "sleep 1; echo {lr} > cand.txt",
      ],
      { cwd: dir, startOptimizer: opt.startOptimizer },
    );
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("max_wall_clock_minutes (0.01)");
    expect(opt.asked()).toBe(1);
    expect(
      (await logEvents()).find((e) => e.type === "tune_result")?.stopped,
    ).toBe("max_wall_clock_minutes");
  });
});

describe("refusals before any trial", () => {
  const expectNothingRan = async (opt: ReturnType<typeof scripted>) => {
    expect(opt.starts).toHaveLength(0);
    expect(await Bun.file(join(dir, "cand.txt")).exists()).toBe(false);
    expect(await logEvents()).toEqual([]);
  };

  test("an invalid space.json", async () => {
    await setup();
    await Bun.write(
      join(dir, "space.json"),
      JSON.stringify({ lr: { type: "float", low: 1, high: 0 } }),
    );
    const opt = scripted([0.1]);
    const r = await tune(["--trials", "2"], opt);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("lr.high");
    await expectNothingRan(opt);
  });

  test("a space.json that is not JSON", async () => {
    await setup();
    await Bun.write(join(dir, "space.json"), "{nope");
    const opt = scripted([0.1]);
    const r = await tune(["--trials", "2"], opt);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("space.json");
    await expectNothingRan(opt);
  });

  test("a {param} in --command with no key in space.json", async () => {
    await setup();
    const opt = scripted([0.1]);
    const r = await runTuneCommand(
      [
        "--space",
        "space.json",
        "--trials",
        "2",
        "--command",
        "echo {lr} {momentum} > cand.txt",
      ],
      { cwd: dir, startOptimizer: opt.startOptimizer },
    );
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("{momentum}");
    await expectNothingRan(opt);
  });

  test("missing or bad flags", async () => {
    await setup();
    const opt = scripted([0.1]);
    expect((await tune([], opt)).code).toBe(2);
    expect((await tune(["--trials", "0"], opt)).code).toBe(2);
    expect((await tune(["--trials", "2", "--sampler", "grid"], opt)).code).toBe(
      2,
    );
    await expectNothingRan(opt);
  });

  test("an unlocked eval", async () => {
    await setup();
    await rm(join(dir, ".ml-ralph/eval/lock.json"), { force: true });
    await rm(join(dir, ".ml-ralph/eval-lock.created"), { force: true });
    await Bun.write(join(dir, ".ml-ralph/eval/evaluate.py"), "print('x')\n");
    const opt = scripted([0.1]);
    const r = await tune(["--trials", "1"], opt);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("No trial was run");
    expect(opt.starts).toHaveLength(0);
  });

  test("uncommitted tracked changes", async () => {
    await setup();
    await Bun.write(join(dir, "train.py"), "print('edited')\n");
    const opt = scripted([0.1]);
    const r = await tune(["--trials", "1"], opt);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("commit your changes before tune");
    await expectNothingRan(opt);
  });

  test("no Python: an install hint, nothing run", async () => {
    await setup();
    const r = await tune(["--trials", "2"], {
      python: join(dir, "no-such-python"),
    });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("pip install optuna");
    expect(await Bun.file(join(dir, "cand.txt")).exists()).toBe(false);
    expect(await logEvents()).toEqual([]);
  });

  test("Python without Optuna: an install hint, nothing run", async () => {
    await setup();
    const fake = join(dir, "py-no-optuna");
    await Bun.write(
      fake,
      `#!/bin/sh\nread cfg\necho '{"error": "missing", "message": "the optuna package is not installed"}'\n`,
    );
    await chmod(fake, 0o755);
    const r = await tune(["--trials", "2"], { python: fake });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("the optuna package is not installed");
    expect(r.stderr).toContain("pip install optuna");
    expect(await logEvents()).toEqual([]);
  });
});

describe("the Optuna process protocol", () => {
  test("asks and tells over stdin/stdout lines", async () => {
    await setup();
    // A stand-in for the Python driver: proposes lr = 0.1 * (trial + 1) and logs each tell
    const fake = join(dir, "py-stub");
    await Bun.write(
      join(dir, "stub.py"),
      `import json, sys
cfg = json.loads(sys.stdin.readline())
open(${JSON.stringify(join(dir, "stub-cfg.json"))}, "w").write(json.dumps(cfg))
print(json.dumps({"ready": True}), flush=True)
n = 0
for line in sys.stdin:
    msg = json.loads(line)
    if msg["op"] == "ask":
        print(json.dumps({"id": n, "params": {"lr": 0.1 * (n + 1)}}), flush=True)
        n += 1
    else:
        open(${JSON.stringify(join(dir, "stub-told.txt"))}, "a").write(json.dumps([msg["id"], msg["value"]]) + "\\n")
        print(json.dumps({"ok": True}), flush=True)
`,
    );
    await Bun.write(
      fake,
      `#!/bin/sh\n# The Optuna driver is started with -u; everything else (evaluate.py) runs on real python\nif [ "$1" = "-u" ]; then exec python3 ${join(dir, "stub.py")}; fi\nexec python3 "$@"\n`,
    );
    await chmod(fake, 0o755);

    const r = await tune(["--trials", "2", "--sampler", "cmaes"], {
      python: fake,
    });
    expect(r.code).toBe(0);
    const cfg = JSON.parse(await Bun.file(join(dir, "stub-cfg.json")).text());
    expect(cfg).toMatchObject({
      sampler: "cmaes",
      direction: "max",
      space: SPACE,
    });
    const told = (await Bun.file(join(dir, "stub-told.txt")).text())
      .trim()
      .split("\n");
    expect(told.map((l) => JSON.parse(l))).toEqual([
      [0, 0.1],
      [1, 0.2],
    ]);
    expect(
      (await logEvents()).find((e) => e.type === "tune_result"),
    ).toMatchObject({
      sampler: "cmaes",
      best_params: { lr: 0.2 },
    });
  });

  test("startOptuna reports a missing interpreter with the install hint", async () => {
    const r = await startOptuna({
      python: join(dir, "nope"),
      space: {},
      sampler: "tpe",
      direction: "max",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("pip install optuna");
  });
});
