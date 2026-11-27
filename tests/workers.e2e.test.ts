/**
 * End-to-end check of `--workers 2`: the real runner and the real CLI
 * (`ml-ralph log`, `eval`) in a throwaway git project, with a stub `claude`
 * script on PATH that does what an agent would (commit, eval, hand in a
 * candidate). Only the independent verifier is stubbed; git is real.
 *
 * Run: bun test tests/workers.e2e.test.ts   (needs git and python on PATH)
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { lockEvalContract } from "../src/infrastructure/ralph/eval-lock.ts";
import { runGit } from "../src/infrastructure/ralph/git.ts";
import type { PromotionDeps } from "../src/infrastructure/ralph/promotion.ts";
import {
  RalphRunner,
  type RunCompleteReason,
  type StreamEvent,
} from "../src/infrastructure/ralph/runner.ts";
import { createWorktree } from "../src/infrastructure/ralph/workers.ts";

const CLI = join(import.meta.dir, "../src/index.tsx");
const CONTRACT = {
  primary_metric: "auc",
  direction: "max",
  search_split: "cv",
  holdout_split: "holdout",
  seeds: [0],
  protocol: "cv",
  success_threshold: 0.99,
  holdout_gap_threshold: 0.02,
  eval_timeout_seconds: 30,
  baseline_score: 0.5,
};
const EVALUATE = `import argparse, json
p = argparse.ArgumentParser()
p.add_argument("--candidate")
p.add_argument("--split")
p.add_argument("--seed")
a = p.parse_args()
print(json.dumps({"score": float(open(a.candidate).read())}))
`;

/** What the agent does in its cwd, steered by STUB_* variables */
const STUB_CLAUDE = `#!/bin/sh
W="$ML_RALPH_WORKER"
now() { date +%s%N; }
echo "start $W $ML_RALPH_ITERATION $(pwd -P) $(now)" >> "$STUB_LOG"
printf '%s' "$4" > "$STUB_LOG.prompt-$W-$ML_RALPH_ITERATION"
if [ "$STUB_CRASH_ALL" = "1" ] || { [ -n "$STUB_CRASH_WORKER" ] && [ "$W" = "$STUB_CRASH_WORKER" ]; }; then
  echo "boom" >&2
  exit 3
fi
if [ -n "$STUB_SLEEP_WORKER" ] && [ "$W" = "$STUB_SLEEP_WORKER" ]; then sleep 1; fi
RESULT="<iteration_complete>"
if [ -n "$STUB_SCORES" ]; then
  SCORE=$(echo "$STUB_SCORES" | cut -d, -f"$W")
  "$STUB_BUN" "$STUB_CLI" log hypothesis "{\\"id\\":\\"H-$W\\",\\"claim\\":\\"c\\",\\"expected_delta\\":0.1,\\"rubrics\\":[\\"r\\"],\\"kill_criterion\\":\\"k\\"}" >/dev/null
  echo "$SCORE" > cand.txt
  echo "v$W-$ML_RALPH_ITERATION" > model.py
  git add cand.txt model.py
  git -c user.email=t@t -c user.name=t -c commit.gpgsign=false commit -q -m "worker $W"
  OUT=$("$STUB_BUN" "$STUB_CLI" eval cand.txt)
  ID=$(echo "$OUT" | sed -n 's/^eval_id: //p')
  # The cap is one eval per iteration and worker: a second call must be refused
  if ! "$STUB_BUN" "$STUB_CLI" eval cand.txt >/dev/null 2>&1; then echo "capped $W" >> "$STUB_LOG"; fi
  RESULT="<iteration_complete> <candidate_complete eval_id=\\\\\\"$ID\\\\\\">"
fi
if [ -n "$STUB_CONCLUSION" ]; then
  echo "claim from worker $W" > .ml-ralph/conclusions.md
  "$STUB_BUN" "$STUB_CLI" log conclusions_changed '{"reason":"new_category","summary":"s"}' >/dev/null
fi
echo "end $W $ML_RALPH_ITERATION $(now)" >> "$STUB_LOG"
printf '{"type":"result","result":"%s","total_cost_usd":0.25}\\n' "$RESULT"
`;

let dir: string;
let stubDir: string;
let configHome: string;
const saved: Record<string, string | undefined> = {};
const ENV_KEYS = [
  "PATH",
  "XDG_CONFIG_HOME",
  "STUB_LOG",
  "STUB_BUN",
  "STUB_CLI",
  "STUB_SCORES",
  "STUB_CRASH_ALL",
  "STUB_CRASH_WORKER",
  "STUB_SLEEP_WORKER",
  "STUB_CONCLUSION",
];

const git = async (cwd: string, ...args: string[]) => {
  const r = await runGit(cwd, [
    "-c",
    "user.email=t@t",
    "-c",
    "user.name=t",
    "-c",
    "commit.gpgsign=false",
    ...args,
  ]);
  expect(r.code).toBe(0);
  return r.out.trim();
};

beforeEach(async () => {
  for (const key of ENV_KEYS) saved[key] = process.env[key];
  dir = await realpath(await mkdtemp(join(tmpdir(), "ml-ralph-workers-e2e-")));
  stubDir = await mkdtemp(join(tmpdir(), "ml-ralph-stub-"));
  configHome = await mkdtemp(join(tmpdir(), "ml-ralph-config-"));
  await writeFile(join(stubDir, "claude"), STUB_CLAUDE);
  await chmod(join(stubDir, "claude"), 0o755);
  process.env.PATH = `${stubDir}:${process.env.PATH}`;
  process.env.XDG_CONFIG_HOME = configHome;
  process.env.STUB_LOG = join(stubDir, "stub.log");
  process.env.STUB_BUN = process.execPath;
  process.env.STUB_CLI = CLI;
  for (const key of ENV_KEYS.filter(
    (k) =>
      k.startsWith("STUB_") &&
      !["STUB_LOG", "STUB_BUN", "STUB_CLI"].includes(k),
  )) {
    delete process.env[key];
  }

  await git(dir, "init", "-q");
  await mkdir(join(dir, ".ml-ralph/eval"), { recursive: true });
  await writeFile(join(dir, ".ml-ralph/RALPH.md"), "# ralph\n");
  await writeFile(
    join(dir, ".ml-ralph/prd.json"),
    JSON.stringify({ project: "p", status: "approved" }),
  );
  await writeFile(
    join(dir, ".ml-ralph/config.json"),
    JSON.stringify({ max_experiments_per_iteration: 1 }),
  );
  await writeFile(
    join(dir, ".ml-ralph/eval/contract.json"),
    JSON.stringify(CONTRACT),
  );
  await writeFile(join(dir, ".ml-ralph/eval/evaluate.py"), EVALUATE);
  expect((await lockEvalContract(dir)).ok).toBe(true);
  await writeFile(join(dir, "cand.txt"), "0.0\n");
  await writeFile(join(dir, "model.py"), "v0\n");
  await git(dir, "add", "cand.txt", "model.py");
  await git(dir, "commit", "-q", "-m", "v0");
});

afterEach(async () => {
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
  await Promise.all(
    [dir, stubDir, configHome].map((d) =>
      rm(d, { recursive: true, force: true }),
    ),
  );
});

const verifierCalls = { active: 0, max: 0, total: 0 };
const promotionDeps = (): Partial<PromotionDeps> => ({
  verify: async (options) => {
    verifierCalls.active++;
    verifierCalls.total++;
    verifierCalls.max = Math.max(verifierCalls.max, verifierCalls.active);
    await new Promise((resolve) => setTimeout(resolve, 30));
    verifierCalls.active--;
    const id = `v-${verifierCalls.total}`;
    return {
      id,
      verdict: "approve",
      reason: "fine",
      checks: { leakage: "pass", protocol_change: "pass", rubrics: "pass" },
      outputPath: `.ml-ralph/verifier/${id}.json`,
      feedback: "Verifier verdict: approve",
      ...(options.worker ? {} : {}),
    };
  },
});

async function runWorkers(maxIterations: number, workers: number | null = 2) {
  const completions: RunCompleteReason[] = [];
  const errors: string[] = [];
  const output: StreamEvent[] = [];
  verifierCalls.active = 0;
  verifierCalls.max = 0;
  verifierCalls.total = 0;
  const runner = new RalphRunner({
    projectPath: dir,
    maxIterations,
    ...(workers === null ? {} : { workers }),
    promotionDeps: promotionDeps(),
    onComplete: (r) => completions.push(r),
    onError: (e) => errors.push(e.message),
    onOutput: (e) => output.push(e),
  });
  await runner.start().catch(() => {});
  return { completions, errors, output };
}

const logEvents = async (type?: string) =>
  (await readFile(join(dir, ".ml-ralph/log.jsonl"), "utf8"))
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Record<string, unknown>)
    .filter((e) => type === undefined || e.type === type);
const stubLines = async () =>
  (await readFile(process.env.STUB_LOG as string, "utf8").catch(() => ""))
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((l) => l.split(" "));
const worktreeCount = async () =>
  (await git(dir, "worktree", "list", "--porcelain"))
    .split("\n")
    .filter((l) => l.startsWith("worktree ")).length;

describe("--workers 2", () => {
  test("two loops run in separate worktrees, each with its own claude process, and the worktrees are gone afterwards", async () => {
    const { completions, errors } = await runWorkers(2);
    expect(errors).toEqual([]);
    expect(completions).toEqual(["max_iterations"]);

    const starts = (await stubLines()).filter((l) => l[0] === "start");
    expect(starts.map((l) => `${l[1]} ${l[2]}`).sort()).toEqual([
      "1 1-w1",
      "1 2-w1",
      "2 1-w2",
      "2 2-w2",
    ]);
    const cwds = (worker: string) => [
      ...new Set(starts.filter((l) => l[1] === worker).map((l) => l[3])),
    ];
    expect(cwds("1")).toEqual([join(dir, ".ml-ralph/worktrees/worker-1")]);
    expect(cwds("2")).toEqual([join(dir, ".ml-ralph/worktrees/worker-2")]);

    expect(await worktreeCount()).toBe(1);
    expect(await readdir(join(dir, ".ml-ralph/worktrees"))).toEqual([]);
    // The project itself is untouched
    expect(await readFile(join(dir, "model.py"), "utf8")).toBe("v0\n");
  });

  test("the budget is shared and the log is shared, each event tagged by worker", async () => {
    await runWorkers(2);
    const status = (await logEvents("budget_status")).at(-1);
    // Four claude sessions of $0.25: one run-wide total, not one per worker
    expect(status?.usd_spent).toBeCloseTo(1.0, 5);
    const phases = await logEvents("phase");
    expect(phases.filter((e) => e.worker === 1)).toHaveLength(2);
    expect(phases.filter((e) => e.worker === 2)).toHaveLength(2);
    expect(
      (await logEvents("budget_status")).every(
        (e) => e.worker === 1 || e.worker === 2,
      ),
    ).toBe(true);
  });

  test("the faster worker waits for the other at the iteration boundary", async () => {
    process.env.STUB_SLEEP_WORKER = "2";
    const { output } = await runWorkers(2);
    const lines = await stubLines();
    const ns = (kind: string, iteration: string) =>
      lines
        .filter((l) => l[0] === kind && l[2]?.startsWith(`${iteration}-`))
        .map((l) => BigInt(l[l.length - 1] as string));
    // Both iteration-1 sessions end before either iteration-2 session starts
    const lastEnd = ns("end", "1")
      .sort((a, b) => (a < b ? -1 : 1))
      .at(-1)!;
    const firstStart = ns("start", "2").sort((a, b) => (a < b ? -1 : 1))[0]!;
    expect(lastEnd <= firstStart).toBe(true);
    expect(
      output.some((e) =>
        e.content.includes("Worker 1 finished iteration 1; waiting"),
      ),
    ).toBe(true);
  });

  test("each worker has its own experiment cap per iteration", async () => {
    process.env.STUB_SCORES = "0.9,0.95";
    await runWorkers(1);
    // With a cap of 1 and one shared counter, one worker's eval would have been refused
    const evals = await logEvents("eval");
    expect(evals.map((e) => e.worker).sort()).toEqual([1, 2]);
    const capped = (await stubLines()).filter((l) => l[0] === "capped");
    expect(capped.map((l) => l[1]).sort()).toEqual(["1", "2"]);
  });

  test("candidates are judged one at a time and the second must beat the new best; ralph/best stays one tag", async () => {
    process.env.STUB_SCORES = "0.9,0.95";
    await runWorkers(1);
    expect(verifierCalls.max).toBe(1);
    const promotions = await logEvents("promotion");
    expect(promotions.map((p) => [p.worker, p.verdict])).toEqual([
      [1, "promoted"],
      [2, "promoted"],
    ]);
    const runId = String((await logEvents("budget_status"))[0]?.run_id).slice(
      0,
      8,
    );
    const tags = (await git(dir, "tag", "--list", "ralph/*")).split("\n");
    expect(tags).toEqual(["ralph/best"]);
    expect(await git(dir, "rev-parse", "ralph/best")).toBe(
      await git(dir, "rev-parse", `ralph/${runId}-worker-2`),
    );
    const incumbent = JSON.parse(
      await readFile(join(dir, ".ml-ralph/incumbent.json"), "utf8"),
    );
    expect(incumbent.ref).toBe(await git(dir, "rev-parse", "ralph/best"));
  });

  test("a second candidate that does not beat the new best is rejected and the tag stays", async () => {
    process.env.STUB_SCORES = "0.95,0.9";
    await runWorkers(1);
    const promotions = await logEvents("promotion");
    expect(promotions.map((p) => [p.worker, p.verdict])).toEqual([
      [1, "promoted"],
      [2, "rejected"],
    ]);
    expect(String(promotions[1]?.reason)).toContain("not better");
    const runId = String((await logEvents("budget_status"))[0]?.run_id).slice(
      0,
      8,
    );
    expect(await git(dir, "rev-parse", "ralph/best")).toBe(
      await git(dir, "rev-parse", `ralph/${runId}-worker-1`),
    );
    // The rejection reaches worker 2 only
  });

  test("a worker's crash is logged and the other worker carries on", async () => {
    process.env.STUB_CRASH_WORKER = "2";
    const { completions, errors, output } = await runWorkers(3);
    expect(errors).toEqual([]);
    expect(completions).toEqual(["max_iterations"]);
    const crashes = await logEvents("worker_crashed");
    expect(crashes).toHaveLength(1);
    expect(crashes[0]).toMatchObject({ worker: 2, iteration: 1 });
    expect(String(crashes[0]?.error)).toContain("boom");
    const starts = (await stubLines()).filter((l) => l[0] === "start");
    expect(starts.filter((l) => l[1] === "1")).toHaveLength(3);
    expect(starts.filter((l) => l[1] === "2")).toHaveLength(1);
    expect(
      output.some((e) => e.isError && e.content.includes("Worker 2")),
    ).toBe(true);
    expect(await worktreeCount()).toBe(1);
  });

  test("the run fails when every worker crashed, and still removes the worktrees", async () => {
    process.env.STUB_CRASH_ALL = "1";
    const { completions, errors } = await runWorkers(2);
    expect(completions).toEqual([]);
    expect(errors).toHaveLength(1);
    expect(await logEvents("worker_crashed")).toHaveLength(2);
    expect(await worktreeCount()).toBe(1);
  });

  test("conclusions are merged by concatenation with worker tags, and both workers read the merge", async () => {
    process.env.STUB_CONCLUSION = "1";
    await runWorkers(2);
    expect(
      (await readFile(join(dir, ".ml-ralph/conclusions.md"), "utf8")).trim(),
    ).toBe(
      "[worker 1]\nclaim from worker 1\n\n[worker 2]\nclaim from worker 2",
    );
    // Each worker's own edit was justified by its own event
    expect(await logEvents("conclusions_rejected")).toEqual([]);
    for (const worker of ["1", "2"]) {
      const first = await readFile(
        `${process.env.STUB_LOG}.prompt-${worker}-1-w${worker}`,
        "utf8",
      ).catch(() => "");
      expect(first).toContain(`You are worker ${worker} of 2`);
      const second = await readFile(
        `${process.env.STUB_LOG}.prompt-${worker}-2-w${worker}`,
        "utf8",
      );
      expect(second).toContain("[worker 1]\nclaim from worker 1");
      expect(second).toContain("[worker 2]\nclaim from worker 2");
    }
  });

  test("without --workers nothing changes: one loop in the project, no worktrees, no tags", async () => {
    process.env.STUB_CONCLUSION = "1";
    const { completions } = await runWorkers(1, null);
    expect(completions).toEqual(["max_iterations"]);
    const starts = (await stubLines()).filter((l) => l[0] === "start");
    expect(starts).toHaveLength(1);
    // The stub's own cwd is the project and its iteration id has no worker suffix
    expect(starts[0]?.slice(2, 4)).toEqual(["1", dir]);
    expect(
      await readdir(join(dir, ".ml-ralph")).then((n) =>
        n.includes("worktrees"),
      ),
    ).toBe(false);
    for (const event of await logEvents()) expect(event.worker).toBeUndefined();
  });

  test("a start cleans worktrees a crashed run left behind", async () => {
    await createWorktree(dir, 1, { runId: "dead", conclusions: "" });
    await mkdir(join(dir, ".ml-ralph/worktrees/worker-7"), { recursive: true });
    expect(await worktreeCount()).toBe(2);
    await runWorkers(1, 1);
    expect(await worktreeCount()).toBe(1);
    expect(await readdir(join(dir, ".ml-ralph/worktrees"))).toEqual([]);
    expect((await logEvents("worktrees_cleaned"))[0]?.removed).toBe(2);
  });

  test("a project that is not a git repository refuses two workers before running anything", async () => {
    const plain = await mkdtemp(join(tmpdir(), "ml-ralph-plain-"));
    try {
      await mkdir(join(plain, ".ml-ralph"), { recursive: true });
      await writeFile(join(plain, ".ml-ralph/RALPH.md"), "# ralph\n");
      const errors: string[] = [];
      await new RalphRunner({
        projectPath: plain,
        maxIterations: 1,
        workers: 2,
        onError: (e) => errors.push(e.message),
      }).start();
      expect(errors).toHaveLength(1);
      expect(errors[0]).toContain("git");
      expect(await stubLines()).toEqual([]);
    } finally {
      await rm(plain, { recursive: true, force: true });
    }
  });

  test("the runner refuses more than two workers", async () => {
    const errors: string[] = [];
    await new RalphRunner({
      projectPath: dir,
      maxIterations: 1,
      workers: 3,
      onError: (e) => errors.push(e.message),
    }).start();
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("at most 2");
    expect(await stubLines()).toEqual([]);
  });
});

describe("--workers on the command line", () => {
  const cli = async (...args: string[]) => {
    const proc = Bun.spawn([process.execPath, CLI, ...args], {
      cwd: dir,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return { stdout, stderr, code };
  };

  test("values above 2, zero and non-numbers are refused", async () => {
    for (const args of [
      ["--workers", "3"],
      ["--workers=3"],
      ["--workers", "0"],
      ["--workers", "many"],
      ["--workers"],
    ]) {
      const r = await cli(...args);
      expect(r.code).toBe(1);
      expect(r.stderr).toContain("--workers");
    }
  });

  test("--help documents the flag", async () => {
    const r = await cli("--help");
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("--workers");
    expect(r.stdout).not.toContain("--teams");
  });
});
