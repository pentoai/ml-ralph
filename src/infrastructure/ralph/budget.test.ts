/**
 * Tests for run budgets: caps, spend and time tracking, stop rules, the prompt,
 * and the per-iteration eval cap. A stub `claude` on PATH stands in for the CLI.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type BudgetStatus,
  budgetPrompt,
  claimExperiment,
  formatBudget,
  headerBudget,
  parseBudgetCaps,
  priorBudget,
  readRecordedBudget,
} from "./budget.ts";
import { runEvalCommand } from "./eval-command.ts";
import { lockEvalContract } from "./eval-lock.ts";
import { RalphRunner, type RunCompleteReason } from "./runner.ts";

/** Prints a result event with the cost in ./cost.txt (none when the file is absent), after ./sleep.txt seconds; saves the prompt */
const STUB_CLAUDE = `#!/bin/sh
printf '%s' "$4" > prompt-$ML_RALPH_ITERATION.txt
echo "$ML_RALPH_ITERATION" >> iterations.txt
echo "$ML_RALPH_MAX_EXPERIMENTS" > maxexp-$ML_RALPH_ITERATION.txt
[ -f sleep.txt ] && sleep "$(cat sleep.txt)"
if [ -f cost.txt ]; then
  echo "{\\"type\\":\\"result\\",\\"subtype\\":\\"success\\",\\"result\\":\\"done <iteration_complete>\\",\\"total_cost_usd\\":$(cat cost.txt)}"
elif [ -f nocost.txt ]; then
  echo '{"type":"result","subtype":"success","result":"done"}'
fi
`;

let dir: string;
let binDir: string;
let oldPath: string | undefined;

const logEvents = async (): Promise<Array<Record<string, unknown>>> => {
  const text = await Bun.file(join(dir, ".ml-ralph/log.jsonl")).text();
  return text
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));
};
const ofType = async (type: string) =>
  (await logEvents()).filter((e) => e.type === type);

async function writeConfig(extra: Record<string, unknown>) {
  await Bun.write(
    join(dir, ".ml-ralph/config.json"),
    JSON.stringify({ name: "p", ...extra }),
  );
}

function run(maxIterations = 3) {
  const completions: RunCompleteReason[] = [];
  const errors: string[] = [];
  const statuses: BudgetStatus[] = [];
  const runner = new RalphRunner({
    projectPath: dir,
    maxIterations,
    onComplete: (r) => completions.push(r),
    onError: (e) => errors.push(e.message),
    onBudget: (s) => statuses.push(s),
  });
  return { runner, completions, errors, statuses };
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "ml-ralph-budget-"));
  binDir = await mkdtemp(join(tmpdir(), "ml-ralph-bin-"));
  await mkdir(join(dir, ".ml-ralph"), { recursive: true });
  await Bun.write(join(dir, ".ml-ralph/RALPH.md"), "# ralph");
  await Bun.write(join(binDir, "claude"), STUB_CLAUDE);
  await chmod(join(binDir, "claude"), 0o755);
  oldPath = process.env.PATH;
  process.env.PATH = `${binDir}:${oldPath}`;
});

afterEach(async () => {
  process.env.PATH = oldPath;
  await rm(dir, { recursive: true, force: true });
  await rm(binDir, { recursive: true, force: true });
});

describe("parseBudgetCaps", () => {
  test("unset caps stay unset", () => {
    expect(parseBudgetCaps({ name: "p" })).toEqual({ ok: true, caps: {} });
    expect(parseBudgetCaps({ max_usd: null })).toEqual({ ok: true, caps: {} });
  });

  test("valid caps pass through", () => {
    expect(
      parseBudgetCaps({
        max_usd: 5.5,
        max_wall_clock_minutes: 90,
        max_experiments_per_iteration: 3,
      }),
    ).toEqual({
      ok: true,
      caps: {
        max_usd: 5.5,
        max_wall_clock_minutes: 90,
        max_experiments_per_iteration: 3,
      },
    });
  });

  test.each([
    ["max_usd", -1],
    ["max_usd", "ten"],
    ["max_wall_clock_minutes", -30],
    ["max_wall_clock_minutes", "1h"],
    ["max_experiments_per_iteration", -2],
    ["max_experiments_per_iteration", 1.5],
    ["max_experiments_per_iteration", "3"],
  ])("rejects %s = %p and names the key", (key, value) => {
    const result = parseBudgetCaps({ [key]: value });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain(key);
  });
});

describe("priorBudget", () => {
  test("takes the latest totals of the same run only", () => {
    const log = [
      { type: "budget_status", run_id: "a", usd_spent: 1, elapsed_minutes: 2 },
      { type: "budget_status", run_id: "a", usd_spent: 3, elapsed_minutes: 5 },
      {
        type: "budget_status",
        run_id: "b",
        usd_spent: 99,
        elapsed_minutes: 99,
      },
      { type: "phase", run_id: "a", usd_spent: 50 },
    ]
      .map((e) => JSON.stringify(e))
      .join("\n");
    expect(priorBudget(`${log}\n{torn`, "a")).toEqual({
      usd_spent: 3,
      elapsed_minutes: 5,
    });
    expect(priorBudget("", "a")).toEqual({ usd_spent: 0, elapsed_minutes: 0 });
  });
});

describe("prompt and TUI text", () => {
  test("the prompt states what is left", () => {
    const text = budgetPrompt({
      usd_spent: 1.5,
      elapsed_minutes: 10,
      max_usd: 5,
      max_wall_clock_minutes: 60,
      max_experiments_per_iteration: 2,
    });
    expect(text).toContain("USD remaining: $3.50");
    expect(text).toContain("Minutes remaining: 50.0");
    expect(text).toContain("at most 2 `ml-ralph eval`");
  });

  test("no caps, no budget section", () => {
    expect(budgetPrompt({ usd_spent: 1, elapsed_minutes: 1 })).toBe("");
  });

  test("the TUI shows spend and time against the caps, or no cap", () => {
    expect(
      formatBudget({
        usd_spent: 1,
        elapsed_minutes: 2,
        max_usd: 5,
        max_wall_clock_minutes: 60,
      }),
    ).toEqual({ usd: "$1.00 / $5.00", time: "2.0 min / 60 min" });
    const open = formatBudget({ usd_spent: 1, elapsed_minutes: 2 });
    expect(open.usd).toContain("no cap");
    expect(open.time).toContain("no cap");
  });
});

describe("headerBudget", () => {
  const none = { usd_spent: 0, elapsed_minutes: 0 };

  test("an invalid cap never reaches formatBudget as a cap and is named", () => {
    const shown = headerBudget(
      { max_usd: "abc", max_wall_clock_minutes: 30 },
      none,
    );
    expect(shown.error).toContain("max_usd");
    expect(shown.status.max_usd).toBeUndefined();
    expect(() => formatBudget(shown.status)).not.toThrow();
    expect(formatBudget(shown.status).usd).toContain("no cap");
  });

  test("shows the recorded totals with the valid caps", () => {
    const shown = headerBudget(
      { max_usd: 10 },
      { usd_spent: 2.5, elapsed_minutes: 12 },
    );
    expect(shown.error).toBeUndefined();
    expect(formatBudget(shown.status)).toEqual({
      usd: "$2.50 / $10.00",
      time: "12.0 min, no cap",
    });
  });
});

describe("recorded budget after a restart", () => {
  test("readRecordedBudget reads the run's budget_status events", async () => {
    await writeConfig({ max_usd: 5 });
    await Bun.write(join(dir, "cost.txt"), "0.7");
    const first = run(2);
    await first.runner.start();
    await Bun.write(
      join(dir, ".ml-ralph/budget/run.json"),
      JSON.stringify({
        run_id: (await ofType("budget_status"))[0]?.run_id,
      }),
    );
    expect((await readRecordedBudget(dir)).usd_spent).toBe(1.4);
  });
});

describe("runner budget", () => {
  test("a negative cap stops the run at start with a named error", async () => {
    await writeConfig({ max_usd: -5 });
    const { runner, errors } = run();
    await runner.start();
    expect(errors[0]).toContain("max_usd");
    expect(await Bun.file(join(dir, "iterations.txt")).exists()).toBe(false);
  });

  test("logs budget_status after each iteration; the USD cap ends the run", async () => {
    await writeConfig({ max_usd: 1 });
    await Bun.write(join(dir, "cost.txt"), "0.4");
    const { runner, completions } = run(10);
    await runner.start();
    // 0.4, 0.8, 1.2 >= 1
    expect(completions).toEqual(["budget_exhausted"]);
    const statuses = await ofType("budget_status");
    expect(statuses.map((s) => s.usd_spent)).toEqual([0.4, 0.8, 1.2]);
    expect(statuses[0]).toMatchObject({ max_usd: 1, iteration: 1 });
    expect(typeof statuses[0]?.elapsed_minutes).toBe("number");
    expect(await ofType("budget_exhausted")).toHaveLength(1);
    expect((await ofType("budget_exhausted"))[0]?.cap).toBe("usd");
    expect(await ofType("budget_warning")).toHaveLength(0);
  });

  test("the prompt carries the remaining budget", async () => {
    await writeConfig({
      max_usd: 10,
      max_wall_clock_minutes: 60,
      max_experiments_per_iteration: 2,
    });
    await Bun.write(join(dir, "cost.txt"), "1");
    const { runner } = run(2);
    await runner.start();
    expect(await Bun.file(join(dir, "prompt-1.txt")).text()).toContain(
      "USD remaining: $10.00",
    );
    const second = await Bun.file(join(dir, "prompt-2.txt")).text();
    expect(second).toContain("USD remaining: $9.00");
    expect(second).toContain("Minutes remaining:");
    expect(second).toContain("at most 2");
  });

  test("a missing result event or cost adds 0 and logs budget_warning", async () => {
    await writeConfig({ max_usd: 1 });
    await Bun.write(join(dir, "nocost.txt"), "");
    const { runner, completions } = run(2);
    await runner.start();
    expect(completions).toEqual(["max_iterations"]);
    expect(await ofType("budget_warning")).toHaveLength(2);
    expect((await ofType("budget_status")).map((s) => s.usd_spent)).toEqual([
      0, 0,
    ]);
  });

  test("the wall-clock timer stops a running iteration", async () => {
    await writeConfig({ max_wall_clock_minutes: 0.01 });
    await Bun.write(join(dir, "sleep.txt"), "30");
    const { runner, completions } = run(5);
    const started = Date.now();
    await runner.start();
    expect(Date.now() - started).toBeLessThan(15_000);
    expect(completions).toEqual(["budget_exhausted"]);
    expect((await ofType("budget_exhausted"))[0]?.cap).toBe("wall_clock");
    expect(await ofType("budget_status")).toHaveLength(1);
  });

  test("a restarted run counts the spend and time already recorded", async () => {
    await writeConfig({ max_usd: 1 });
    await Bun.write(join(dir, "cost.txt"), "0.3");
    const first = run(1);
    await first.runner.start();
    expect(first.completions).toEqual(["max_iterations"]);
    // A stopped run (not one that finished) keeps its id: simulate by restoring it
    const before = (await ofType("budget_status"))[0] as Record<
      string,
      unknown
    >;
    await Bun.write(
      join(dir, ".ml-ralph/budget/run.json"),
      JSON.stringify({ run_id: before.run_id }),
    );
    // Pretend the earlier start had also spent time
    const log = await Bun.file(join(dir, ".ml-ralph/log.jsonl")).text();
    await Bun.write(
      join(dir, ".ml-ralph/log.jsonl"),
      log.replace('"elapsed_minutes":', '"elapsed_minutes":0.5,"x":'),
    );

    const second = run(1);
    await second.runner.start();
    const statuses = await ofType("budget_status");
    expect(statuses[1]?.usd_spent).toBe(0.6);
    expect(statuses[1]?.run_id).toBe(before.run_id);
    expect(Number(statuses[1]?.elapsed_minutes)).toBeGreaterThanOrEqual(0.5);
    // The first status of the restart already reflected the earlier spend
    expect(second.statuses[0]?.usd_spent).toBe(0.3);
  });

  test("a restart with the budget already spent ends without running claude", async () => {
    await writeConfig({ max_usd: 1 });
    await Bun.write(join(dir, "cost.txt"), "1.5");
    const first = run(5);
    await first.runner.start();
    expect(first.completions).toEqual(["budget_exhausted"]);
    const second = run(5);
    await second.runner.start();
    expect(second.completions).toEqual(["budget_exhausted"]);
    expect((await Bun.file(join(dir, "iterations.txt")).text()).trim()).toBe(
      "1",
    );
  });

  test("without caps, behaviour is unchanged", async () => {
    await Bun.write(join(dir, "cost.txt"), "100");
    const { runner, completions } = run(2);
    await runner.start();
    expect(completions).toEqual(["max_iterations"]);
    expect(await Bun.file(join(dir, "prompt-1.txt")).text()).not.toContain(
      "Run budget",
    );
  });
});

describe("experiment cap", () => {
  const CONTRACT = {
    primary_metric: "auc",
    direction: "max",
    search_split: "cv",
    seeds: [0],
    protocol: "cv",
    success_threshold: 0.9,
    holdout_gap_threshold: 0.02,
    eval_timeout_seconds: 30,
    baseline_score: 0.5,
  };

  async function setupEval() {
    await mkdir(join(dir, ".ml-ralph/eval"), { recursive: true });
    await Bun.write(
      join(dir, ".ml-ralph/prd.json"),
      JSON.stringify({ project: "p", status: "approved" }),
    );
    await Bun.write(
      join(dir, ".ml-ralph/eval/contract.json"),
      JSON.stringify(CONTRACT),
    );
    await Bun.write(
      join(dir, ".ml-ralph/eval/evaluate.py"),
      'import json\nprint(json.dumps({"score": 0.7}))\n',
    );
    expect((await lockEvalContract(dir)).ok).toBe(true);
    await Bun.write(join(dir, "cand.txt"), "x");
  }

  test("calls past the cap exit non-zero with the cap message", async () => {
    await writeConfig({ max_experiments_per_iteration: 2 });
    await setupEval();
    const prev = process.env.ML_RALPH_ITERATION;
    process.env.ML_RALPH_ITERATION = "7";
    try {
      const codes: number[] = [];
      let last = "";
      for (let i = 0; i < 3; i++) {
        const r = await runEvalCommand(["cand.txt"], { cwd: dir });
        codes.push(r.code);
        last = r.stderr;
      }
      expect(codes).toEqual([0, 0, 1]);
      expect(last).toContain("experiment cap reached for this iteration (2)");

      // Another iteration has its own count
      process.env.ML_RALPH_ITERATION = "8";
      expect((await runEvalCommand(["cand.txt"], { cwd: dir })).code).toBe(0);
    } finally {
      if (prev === undefined) delete process.env.ML_RALPH_ITERATION;
      else process.env.ML_RALPH_ITERATION = prev;
    }
  });

  const withEnv = async (
    env: Record<string, string | undefined>,
    body: () => Promise<void>,
  ) => {
    const saved: Record<string, string | undefined> = {};
    for (const [k, v] of Object.entries(env)) {
      saved[k] = process.env[k];
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    try {
      await body();
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  };

  test("a cap with no iteration id fails closed", async () => {
    await setupEval();
    await writeConfig({ max_experiments_per_iteration: 1 });
    await withEnv(
      { ML_RALPH_ITERATION: undefined, ML_RALPH_MAX_EXPERIMENTS: undefined },
      async () => {
        const r = await runEvalCommand(["cand.txt"], { cwd: dir });
        expect(r.code).toBe(1);
        expect(r.stderr).toContain("ML_RALPH_ITERATION");
      },
    );
    await withEnv({ ML_RALPH_ITERATION: "../x" }, async () => {
      expect((await runEvalCommand(["cand.txt"], { cwd: dir })).code).toBe(1);
    });
  });

  test("the runner's pinned cap holds when config.json is raised or the cap removed", async () => {
    await setupEval();
    await writeConfig({ max_experiments_per_iteration: 50 });
    await withEnv(
      { ML_RALPH_ITERATION: "3", ML_RALPH_MAX_EXPERIMENTS: "1" },
      async () => {
        expect((await runEvalCommand(["cand.txt"], { cwd: dir })).code).toBe(0);
        const r = await runEvalCommand(["cand.txt"], { cwd: dir });
        expect(r.code).toBe(1);
        expect(r.stderr).toContain(
          "experiment cap reached for this iteration (1)",
        );
        await writeConfig({});
        expect((await runEvalCommand(["cand.txt"], { cwd: dir })).code).toBe(1);
      },
    );
  });

  test("a garbage pinned cap fails closed", async () => {
    await setupEval();
    await withEnv(
      { ML_RALPH_ITERATION: "3", ML_RALPH_MAX_EXPERIMENTS: "lots" },
      async () => {
        expect((await runEvalCommand(["cand.txt"], { cwd: dir })).code).toBe(1);
      },
    );
  });

  test("with no cap anywhere, eval is not limited", async () => {
    await setupEval();
    await withEnv(
      { ML_RALPH_ITERATION: undefined, ML_RALPH_MAX_EXPERIMENTS: undefined },
      async () => {
        expect((await runEvalCommand(["cand.txt"], { cwd: dir })).code).toBe(0);
        expect((await runEvalCommand(["cand.txt"], { cwd: dir })).code).toBe(0);
      },
    );
  });

  test("the runner pins the cap in the claude environment", async () => {
    await writeConfig({ max_experiments_per_iteration: 4 });
    const { runner } = run(1);
    await runner.start();
    expect((await Bun.file(join(dir, "maxexp-1.txt")).text()).trim()).toBe("4");
  });

  test("parallel claims never exceed the cap", async () => {
    const claims = await Promise.all(
      Array.from({ length: 10 }, () => claimExperiment(dir, "p", 3)),
    );
    expect(claims.filter(Boolean)).toHaveLength(3);
  });
});
