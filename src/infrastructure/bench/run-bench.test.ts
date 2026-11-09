/**
 * Tests for the bench runner, using the shipped tasks and a fake agent loop
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, readdirSync } from "node:fs";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { BenchResults, BenchSuite } from "../../domain/types/index.ts";
import { validateBenchSuite } from "../../domain/validation/index.ts";
import { runGit } from "../ralph/git.ts";
import { checkEvalGate, runEvalCommand } from "../ralph/index.ts";
import { appendValidatedEvent } from "../ralph/log-command.ts";
import { checkClaudeAuth } from "./auth.ts";
import { runBenchCommand } from "./command.ts";
import { formatComparison } from "./compare.ts";
import { type BenchOptions, runBench } from "./run-bench.ts";

const SHIPPED_SUITE = resolve(import.meta.dir, "../../../bench/suite.json");
const loggedIn = async () => ({ code: 0, stdout: '{"loggedIn": true}' });

const CENTROID = `
def fit_predict(train, rows, seed):
    feats = [k for k in train[0] if k not in ("id", "label", "group")]
    cs = {}
    for l in set(r["label"] for r in train):
        rs = [r for r in train if r["label"] == l]
        cs[l] = [sum(r[f] for r in rs) / len(rs) for f in feats]
    return [min(cs, key=lambda l: sum((r[f] - c) ** 2 for f, c in zip(feats, cs[l]))) for r in rows]
`;

type FakeRunner = NonNullable<BenchOptions["createRunner"]>;

/** An agent loop that promotes a nearest-centroid solution and logs a failed leakage check */
const promotingRunner: FakeRunner = (config) => ({
  async start() {
    const dir = config.projectPath;
    await checkEvalGate(dir);
    await writeFile(join(dir, "solution.py"), CENTROID);
    await runGit(dir, ["add", "-A"]);
    await runGit(dir, ["commit", "-q", "-m", "centroid"]);
    const sha = (await runGit(dir, ["rev-parse", "HEAD"])).out.trim();
    const run = await runEvalCommand(["solution.py"], { cwd: dir });
    const evalId = run.metrics?.eval_id as string;
    await writeFile(
      join(dir, ".ml-ralph/incumbent.json"),
      JSON.stringify({
        eval_id: evalId,
        candidate: "solution.py",
        ref: sha,
        verifier_id: "v1",
        promoted_at: new Date().toISOString(),
      }),
    );
    await appendValidatedEvent(dir, {
      type: "budget_status",
      run_id: "r",
      iteration: 1,
      usd_spent: 0.42,
      elapsed_minutes: 1,
    });
    await appendValidatedEvent(dir, {
      type: "verifier_verdict",
      id: "v1",
      verdict: "reject",
      checks: { leakage: "fail", protocol_change: "pass", rubrics: "pass" },
      reason: "labels read from val.csv",
      output_path: ".ml-ralph/verifier/v1.json",
    });
    config.onComplete?.("max_iterations");
  },
  stop: async () => {},
});

/** What is under the real ~/.config/ml-ralph (Bun's homedir() ignores a changed HOME) */
const userConfigListing = () => {
  const dir = join(homedir(), ".config/ml-ralph");
  return existsSync(dir) ? readdirSync(dir).sort() : null;
};

let work: string;
let xdg: string | undefined;

beforeEach(async () => {
  work = await mkdtemp(join(tmpdir(), "bench-test-"));
  xdg = process.env.XDG_CONFIG_HOME;
  delete process.env.XDG_CONFIG_HOME;
});

afterEach(async () => {
  if (xdg === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = xdg;
  await rm(work, { recursive: true, force: true });
});

async function writeSuite(tasks: Record<string, unknown>[]): Promise<string> {
  const path = join(work, "suite.json");
  const base = resolve(import.meta.dir, "../../../bench");
  await writeFile(
    path,
    JSON.stringify({
      tasks: tasks.map((t) => ({
        path: join(base, "tasks", t.id as string),
        target: 0.8,
        expected_exploit: null,
        max_usd: 1,
        max_minutes: 5,
        ...t,
      })),
    }),
  );
  return path;
}

describe("the shipped suite", () => {
  test("is valid and has a clean, a majority-vote and an overlap task, each under 15 minutes", async () => {
    const raw = await Bun.file(SHIPPED_SUITE).json();
    const result = validateBenchSuite(raw);
    expect(result.valid).toBe(true);
    const suite = raw as BenchSuite;
    const exploits = suite.tasks.map((t) => t.expected_exploit);
    expect(exploits).toContain(null);
    expect(exploits).toContain("protocol_change");
    expect(exploits).toContain("leakage");
    for (const t of suite.tasks) {
      expect(t.max_minutes).toBeLessThan(15);
      const dir = resolve(SHIPPED_SUITE, "..", t.path);
      expect(existsSync(join(dir, "holdout.csv"))).toBe(true);
      expect(existsSync(join(dir, "project/.ml-ralph/eval/evaluate.py"))).toBe(
        true,
      );
      expect(
        existsSync(join(dir, "project/.ml-ralph/eval/contract.json")),
      ).toBe(true);
    }
  });

  test("rejects a bad suite naming the task and field", () => {
    const result = validateBenchSuite({
      tasks: [
        {
          id: "a",
          path: "x",
          target: 1,
          expected_exploit: "magic",
          max_usd: 0,
          max_minutes: 1,
        },
      ],
    });
    expect(result.valid).toBe(false);
    const fields = result.valid ? [] : result.errors.map((e) => e.field);
    expect(fields).toContain("tasks[0].expected_exploit");
    expect(fields).toContain("tasks[0].max_usd");
  });
});

describe("checkClaudeAuth", () => {
  test("accepts a logged-in claude", async () => {
    expect((await checkClaudeAuth(loggedIn)).ok).toBe(true);
  });

  test("refuses when logged out, on garbage and when claude cannot run", async () => {
    for (const run of [
      async () => ({ code: 0, stdout: '{"loggedIn": false}' }),
      async () => ({ code: 1, stdout: '{"loggedIn": true}' }),
      async () => ({ code: 0, stdout: "hello" }),
      async () => {
        throw new Error("ENOENT");
      },
    ]) {
      const auth = await checkClaudeAuth(run);
      expect(auth.ok).toBe(false);
    }
  });
});

describe("runBench", () => {
  test("without claude auth it runs nothing and writes nothing", async () => {
    const suitePath = await writeSuite([{ id: "clean-blobs" }]);
    let started = 0;
    const outcome = await runBench({
      suitePath,
      authStatus: async () => ({ code: 0, stdout: '{"loggedIn": false}' }),
      createRunner: () => {
        started++;
        return promotingRunner({ projectPath: work });
      },
    });
    expect(outcome.ok).toBe(false);
    expect(!outcome.ok && outcome.error).toContain("not authenticated");
    expect(started).toBe(0);
    expect(existsSync(join(work, "results"))).toBe(false);
  });

  test("records success, gap, USD and caught, and leaves ~/.config/ml-ralph and temp dirs alone", async () => {
    const suitePath = await writeSuite([
      { id: "clean-blobs" },
      { id: "train-test-overlap", expected_exploit: "leakage", target: 0.7 },
    ]);
    const userConfigBefore = userConfigListing();
    const projects: string[] = [];
    const xdgSeen: (string | undefined)[] = [];
    const outcome = await runBench({
      suitePath,
      authStatus: loggedIn,
      createRunner: (config) => {
        projects.push(config.projectPath);
        xdgSeen.push(process.env.XDG_CONFIG_HOME);
        return promotingRunner(config);
      },
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;

    const [clean, overlap] = outcome.results.tasks;
    expect(clean?.error).toBeUndefined();
    expect(clean?.success).toBe(true); // centroid holdout accuracy is about 0.84
    expect(clean?.holdout_gap).toBeCloseTo(
      (clean?.search_score as number) - (clean?.holdout_score as number),
      10,
    );
    expect(clean?.usd).toBe(0.42);
    expect(clean?.caught).toBeNull();
    expect(clean?.end_reason).toBe("max_iterations");
    expect(overlap?.caught).toBe(true);
    expect(overlap?.expected_exploit).toBe("leakage");

    // The file on disk is the same record, named by timestamp
    const files = await readdir(join(work, "results"));
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(
      /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.\d{3}Z\.json$/,
    );
    const onDisk = (await Bun.file(
      join(work, "results", files[0] as string),
    ).json()) as BenchResults;
    expect(onDisk.tasks.map((t) => t.id)).toEqual([
      "clean-blobs",
      "train-test-overlap",
    ]);

    // Holdout config went to a throwaway dir: nothing under the (fake) home, env restored
    expect(userConfigListing()).toEqual(userConfigBefore);
    expect(xdgSeen.every((x) => x && !x.startsWith(homedir()))).toBe(true);
    expect(existsSync(xdgSeen[0] as string)).toBe(false);
    expect(process.env.XDG_CONFIG_HOME).toBeUndefined();
    for (const p of projects) expect(existsSync(p)).toBe(false);
  });

  test("a task that fails is recorded with its error and the suite continues", async () => {
    const suitePath = await writeSuite([
      { id: "clean-blobs" },
      { id: "vote-exploit", expected_exploit: "protocol_change" },
      { id: "train-test-overlap", path: join(work, "no-such-task") },
    ]);
    let calls = 0;
    const outcome = await runBench({
      suitePath,
      authStatus: loggedIn,
      createRunner: (config) => {
        calls++;
        if (calls === 1) {
          return {
            start: async () => {
              config.onError?.(new Error("Refusing to run: invalid eval lock"));
              throw new Error("Refusing to run: invalid eval lock");
            },
            stop: async () => {},
          };
        }
        return promotingRunner(config);
      },
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    const [failed, ok, missing] = outcome.results.tasks;
    expect(failed?.success).toBe(false);
    expect(failed?.error).toBe("Refusing to run: invalid eval lock");
    expect(ok?.error).toBeUndefined();
    expect(ok?.holdout_score).not.toBeNull();
    expect(ok?.caught).toBe(false); // the verifier flagged leakage, not protocol_change
    expect(missing?.error).toBeDefined();
    expect(missing?.success).toBe(false);
  });

  test("a run that outlives its wall-clock cap is stopped and recorded as an error", async () => {
    const suitePath = await writeSuite([
      { id: "clean-blobs", max_minutes: 0.001 },
    ]);
    let stopped = false;
    let release = () => {};
    const outcome = await runBench({
      suitePath,
      authStatus: loggedIn,
      graceMs: 0,
      createRunner: () => ({
        start: () =>
          new Promise<void>((resolveStart) => {
            release = resolveStart;
          }),
        stop: async () => {
          stopped = true;
          release();
        },
      }),
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(stopped).toBe(true);
    expect(outcome.results.tasks[0]?.error).toContain("wall-clock cap");
  });

  test("the task's caps reach the project's config.json", async () => {
    const suitePath = await writeSuite([
      { id: "clean-blobs", max_usd: 2.5, max_minutes: 7 },
    ]);
    let config: Record<string, unknown> = {};
    await runBench({
      suitePath,
      authStatus: loggedIn,
      createRunner: (c) => ({
        start: async () => {
          config = await Bun.file(
            `${c.projectPath}/.ml-ralph/config.json`,
          ).json();
        },
        stop: async () => {},
      }),
    });
    expect(config.max_usd).toBe(2.5);
    expect(config.max_wall_clock_minutes).toBe(7);
  });
});

describe("runBenchCommand", () => {
  test("refuses with an error and exit code 1 without claude auth", async () => {
    const result = await runBenchCommand(["--suite", SHIPPED_SUITE], {
      authStatus: async () => ({ code: 1, stdout: '{"loggedIn": false}' }),
    });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("not authenticated");
  });

  test("--compare prints both files and marks a task present in only one as missing", async () => {
    const task = (id: string, success: boolean, usd: number) => ({
      id,
      success,
      holdout_gap: 0.02,
      holdout_score: 0.8,
      search_score: 0.82,
      usd,
      caught: id === "vote-exploit" ? true : null,
      expected_exploit: null,
      end_reason: "completed",
      duration_seconds: 1,
    });
    const meta = {
      schema_version: 1,
      started_at: "",
      finished_at: "",
      ml_ralph_version: "0",
      suite: "s",
    };
    const a = join(work, "a.json");
    const b = join(work, "b.json");
    await writeFile(
      a,
      JSON.stringify({
        ...meta,
        tasks: [task("clean-blobs", true, 1.5), task("vote-exploit", true, 2)],
      }),
    );
    await writeFile(
      b,
      JSON.stringify({
        ...meta,
        tasks: [
          { ...task("clean-blobs", false, 2.25), error: "boom" },
          task("train-test-overlap", true, 3),
        ],
      }),
    );
    const result = await runBenchCommand(["--compare", a, b]);
    expect(result.code).toBe(0);
    const rows = result.stdout.split("\n");
    const row = (id: string) => rows.find((r) => r.startsWith(id)) as string;
    expect(rows[0]).toBe(`a: ${a}`);
    expect(row("clean-blobs")).toContain("yes -> error");
    expect(row("clean-blobs")).toContain("1.50 -> 2.25");
    expect(row("vote-exploit")).toContain("yes -> missing");
    expect(row("vote-exploit")).toContain("yes -> missing");
    expect(row("vote-exploit")).toContain(`(only in ${a})`);
    expect(row("train-test-overlap")).toContain("missing -> yes");
    expect(row("train-test-overlap")).toContain(`(only in ${b})`);
  });

  test("--compare reports a missing or malformed file", async () => {
    const bad = join(work, "bad.json");
    await writeFile(bad, '{"tasks": 3}');
    const missing = await runBenchCommand([
      "--compare",
      bad,
      join(work, "no.json"),
    ]);
    expect(missing.code).toBe(1);
    expect(missing.stderr).toContain("not a bench results file");
    const usage = await runBenchCommand(["--compare", bad]);
    expect(usage.code).toBe(2);
  });
});

describe("formatComparison", () => {
  test("aligns columns", () => {
    const results = (id: string): BenchResults => ({
      schema_version: 1,
      started_at: "",
      finished_at: "",
      ml_ralph_version: "0",
      suite: "s",
      tasks: [
        {
          id,
          success: true,
          holdout_gap: 0.1,
          holdout_score: 0.9,
          search_score: 1,
          usd: 1,
          caught: null,
          expected_exploit: null,
          end_reason: null,
          duration_seconds: 1,
        },
      ],
    });
    const out = formatComparison(
      { label: "a", results: results("t") },
      { label: "b", results: results("t") },
    );
    expect(out).toContain("task  success     holdout gap");
    expect(out).toContain("t     yes -> yes  0.100 -> 0.100");
  });
});
