/**
 * Tests for the sealed holdout with a fake evaluate.py (no real training, no claude)
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { runEvalCommand } from "./eval-command.ts";
import { lockEvalContract } from "./eval-lock.ts";
import { EVALS_DIR, readEvalMetrics } from "./eval-metrics.ts";
import {
  holdoutConfigFile,
  holdoutGap,
  readHoldoutPath,
  scoreHoldout,
} from "./holdout.ts";
import { initRalph } from "./init.ts";
import { RalphRunner } from "./runner.ts";

/** Search runs score 0.9; a holdout run scores the number in the holdout file */
const FAKE_EVALUATE = `import argparse, json, os, sys

ap = argparse.ArgumentParser()
ap.add_argument("--candidate")
ap.add_argument("--split")
ap.add_argument("--seed", type=int)
a = ap.parse_args()
ED = os.environ["ML_RALPH_EVAL_DIR"]
with open(os.path.join(ED, "calls.jsonl"), "a") as f:
    f.write(json.dumps({"split": a.split, "seed": a.seed, "holdout_env": "ML_RALPH_HOLDOUT_PATH" in os.environ}) + "\\n")
if a.split == "holdout":
    path = os.environ["ML_RALPH_HOLDOUT_PATH"]
    if open(a.candidate).read().strip() == "crash":
        sys.stderr.write("FileNotFoundError: " + path + ".missing\\n")
        sys.exit(1)
    print(json.dumps({"score": float(open(path).read())}))
else:
    print(json.dumps({"score": 0.9}))
`;

const CONTRACT = {
  primary_metric: "auc",
  direction: "max",
  search_split: "cv_5fold",
  seeds: [0, 1],
  protocol: "5-fold CV",
  success_threshold: 0.95,
  holdout_gap_threshold: 0.02,
  eval_timeout_seconds: 30,
  baseline_score: 0.5,
};

let dir: string;
let secretDir: string;
let configHome: string;
let holdoutFile: string;
let env: Record<string, string | undefined>;
const savedEnv = {
  xdg: process.env.XDG_CONFIG_HOME,
  holdout: process.env.ML_RALPH_HOLDOUT_PATH,
};

const configFile = () => join(configHome, "ml-ralph", "config.json");

async function writeConfig(projects: Record<string, unknown>) {
  await mkdir(join(configHome, "ml-ralph"), { recursive: true });
  await Bun.write(configFile(), JSON.stringify({ projects }));
}

/** Project with a locked contract; the config points at a holdout whose score is `holdoutScore` */
async function setup(holdoutScore: number, contract: object = CONTRACT) {
  await mkdir(join(dir, ".ml-ralph/eval"), { recursive: true });
  await Bun.write(
    join(dir, ".ml-ralph/prd.json"),
    JSON.stringify({ project: "p", status: "approved" }),
  );
  await Bun.write(
    join(dir, ".ml-ralph/eval/contract.json"),
    JSON.stringify(contract),
  );
  await Bun.write(join(dir, ".ml-ralph/eval/evaluate.py"), FAKE_EVALUATE);
  expect((await lockEvalContract(dir)).ok).toBe(true);
  await Bun.write(holdoutFile, String(holdoutScore));
  await writeConfig({ [dir]: { holdout_path: holdoutFile } });
}

async function evalCandidate(mode = "ok"): Promise<string> {
  await Bun.write(join(dir, "cand.txt"), mode);
  const result = await runEvalCommand(["cand.txt"], { cwd: dir });
  expect(result.code).toBe(0);
  return result.metrics?.eval_id as string;
}

const jsonl = async (name: string) => {
  const file = Bun.file(join(dir, name));
  if (!(await file.exists())) return [];
  return (await file.text())
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l) as Record<string, unknown>);
};
const calls = () => jsonl(".ml-ralph/eval/calls.jsonl");
const logEvents = () => jsonl(".ml-ralph/log.jsonl");
const holdoutCalls = async () =>
  (await calls()).filter((c) => c.split === "holdout");

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "ml-ralph-holdout-"));
  secretDir = await mkdtemp(join(tmpdir(), "ml-ralph-sealed-"));
  configHome = await mkdtemp(join(tmpdir(), "ml-ralph-config-"));
  holdoutFile = join(secretDir, "sealed-holdout.txt");
  env = { XDG_CONFIG_HOME: configHome };
});

afterEach(async () => {
  for (const [key, value] of [
    ["XDG_CONFIG_HOME", savedEnv.xdg],
    ["ML_RALPH_HOLDOUT_PATH", savedEnv.holdout],
  ] as const) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await Promise.all(
    [dir, secretDir, configHome].map((d) =>
      rm(d, { recursive: true, force: true }),
    ),
  );
});

describe("holdout config", () => {
  test("lives under XDG_CONFIG_HOME, else ~/.config", () => {
    expect(holdoutConfigFile({ XDG_CONFIG_HOME: "/x/cfg" })).toBe(
      "/x/cfg/ml-ralph/config.json",
    );
    expect(holdoutConfigFile({})).toBe(
      join(homedir(), ".config/ml-ralph/config.json"),
    );
  });

  test("reads the path keyed by the project's absolute path", async () => {
    await writeConfig({
      "/other": { holdout_path: "/nope" },
      [dir]: { holdout_path: holdoutFile },
    });
    await Bun.write(holdoutFile, "1");
    expect(await readHoldoutPath(dir, env)).toEqual({
      ok: true,
      path: holdoutFile,
    });
  });

  test("a missing file names the file and the key", async () => {
    const result = await readHoldoutPath(dir, env);
    expect(result.ok).toBe(false);
    const error = !result.ok ? result.error : "";
    expect(error).toContain(configFile());
    expect(error).toContain(`projects[${JSON.stringify(dir)}].holdout_path`);
  });

  test("a missing entry names the file and the key", async () => {
    await writeConfig({ "/other": { holdout_path: holdoutFile } });
    const result = await readHoldoutPath(dir, env);
    const error = !result.ok ? result.error : "";
    expect(error).toContain(configFile());
    expect(error).toContain(`projects[${JSON.stringify(dir)}].holdout_path`);
  });

  test("a path that does not exist names the file and the key, not the path", async () => {
    await writeConfig({ [dir]: { holdout_path: holdoutFile } });
    const result = await readHoldoutPath(dir, env);
    expect(result.ok).toBe(false);
    const error = !result.ok ? result.error : "";
    expect(error).toContain(configFile());
    expect(error).toContain(`projects[${JSON.stringify(dir)}].holdout_path`);
    expect(error).toContain("does not exist");
    expect(error).not.toContain(holdoutFile);
  });

  test("a relative path and invalid JSON are refused", async () => {
    await writeConfig({ [dir]: { holdout_path: "holdout.csv" } });
    expect((await readHoldoutPath(dir, env)).ok).toBe(false);
    await Bun.write(configFile(), "{not json");
    const result = await readHoldoutPath(dir, env);
    expect(!result.ok && result.error).toContain("not valid JSON");
  });
});

describe("holdoutGap", () => {
  test("is positive when the holdout is worse, in either direction", () => {
    expect(holdoutGap("max", 0.9, 0.8)).toBeCloseTo(0.1);
    expect(holdoutGap("min", 0.2, 0.3)).toBeCloseTo(0.1);
    expect(holdoutGap("min", 0.2, 0.1)).toBeCloseTo(-0.1);
  });
});

describe("scoreHoldout", () => {
  test("runs the locked evaluate.py on the holdout split and records score and gap", async () => {
    await setup(0.89);
    const evalId = await evalCandidate();

    const result = await scoreHoldout(evalId, { projectPath: dir, env });

    expect(result).toMatchObject({
      ok: true,
      evalId,
      searchScore: 0.9,
      holdoutScore: 0.89,
      threshold: 0.02,
      blocked: false,
      alreadyScored: false,
    });
    expect(result.ok && result.holdoutGap).toBeCloseTo(0.01);

    expect(await holdoutCalls()).toEqual([
      { split: "holdout", seed: 0, holdout_env: true },
      { split: "holdout", seed: 1, holdout_env: true },
    ]);
    const metrics = await readEvalMetrics(dir, evalId);
    expect(metrics).toMatchObject({
      status: "ok",
      mean: 0.9,
      holdout_status: "ok",
      holdout_score: 0.89,
    });
    expect((metrics as { holdout_gap: number }).holdout_gap).toBeCloseTo(0.01);
    expect((await logEvents()).map((e) => e.type)).not.toContain("overfitting");
  });

  test("search evals never see the holdout path, even when it is in the runner's environment", async () => {
    await setup(0.89);
    process.env.ML_RALPH_HOLDOUT_PATH = holdoutFile;
    await evalCandidate();

    const searchCalls = (await calls()).filter((c) => c.split !== "holdout");
    expect(searchCalls.length).toBe(2);
    expect(searchCalls.every((c) => c.holdout_env === false)).toBe(true);
  });

  test("a gap above the threshold logs overfitting and reports blocked", async () => {
    await setup(0.7);
    const evalId = await evalCandidate();

    const result = await scoreHoldout(evalId, { projectPath: dir, env });

    expect(result).toMatchObject({
      ok: true,
      blocked: true,
      holdoutScore: 0.7,
    });
    const events = (await logEvents()).filter((e) => e.type === "overfitting");
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      eval_id: evalId,
      search_score: 0.9,
      holdout_score: 0.7,
      threshold: 0.02,
    });
    expect(events[0]?.holdout_gap as number).toBeCloseTo(0.2);
  });

  test("uses the contract direction when lower is better", async () => {
    await setup(0.95, { ...CONTRACT, direction: "min", baseline_score: 1 });
    const evalId = await evalCandidate();

    const result = await scoreHoldout(evalId, { projectPath: dir, env });

    expect(result.ok && result.holdoutGap).toBeCloseTo(0.05);
    expect(result.ok && result.blocked).toBe(true);
  });

  test("a holdout better than the search score has a negative gap and is not blocked", async () => {
    await setup(0.95);
    const result = await scoreHoldout(await evalCandidate(), {
      projectPath: dir,
      env,
    });
    expect(result.ok && result.holdoutGap).toBeLessThan(0);
    expect(result.ok && result.blocked).toBe(false);
  });

  test("a second call returns the recorded result and runs nothing", async () => {
    await setup(0.7);
    const evalId = await evalCandidate();
    const first = await scoreHoldout(evalId, { projectPath: dir, env });
    expect((await holdoutCalls()).length).toBe(2);

    // Even a changed holdout or a missing config cannot buy a second run
    await Bun.write(holdoutFile, "0.9");
    await rm(configFile());
    const second = await scoreHoldout(evalId, { projectPath: dir, env });

    expect(second).toEqual({ ...first, alreadyScored: true });
    expect(second.ok && second.blocked).toBe(true);
    expect((await holdoutCalls()).length).toBe(2);
    expect(
      (await logEvents()).filter((e) => e.type === "overfitting"),
    ).toHaveLength(1);
  });

  test("concurrent calls run the holdout once", async () => {
    await setup(0.89);
    const evalId = await evalCandidate();

    const results = await Promise.all([
      scoreHoldout(evalId, { projectPath: dir, env }),
      scoreHoldout(evalId, { projectPath: dir, env }),
    ]);

    expect(results.filter((r) => r.ok && !r.alreadyScored)).toHaveLength(1);
    expect((await holdoutCalls()).length).toBe(2);
  });

  test("each eval_id gets its own run", async () => {
    await setup(0.89);
    const a = await evalCandidate();
    const b = await evalCandidate();
    expect((await scoreHoldout(a, { projectPath: dir, env })).ok).toBe(true);
    const second = await scoreHoldout(b, { projectPath: dir, env });
    expect(second.ok && second.alreadyScored).toBe(false);
  });

  test("a config error runs nothing and does not use up the run", async () => {
    await setup(0.89);
    const evalId = await evalCandidate();
    await writeConfig({});

    const refused = await scoreHoldout(evalId, { projectPath: dir, env });
    expect(refused.ok).toBe(false);
    expect(!refused.ok && refused.error).toContain(configFile());
    expect(await holdoutCalls()).toEqual([]);

    await writeConfig({ [dir]: { holdout_path: holdoutFile } });
    expect((await scoreHoldout(evalId, { projectPath: dir, env })).ok).toBe(
      true,
    );
  });

  test("a failed holdout run is recorded without the path and not retried", async () => {
    await setup(0.89);
    const evalId = await evalCandidate("crash");

    const first = await scoreHoldout(evalId, { projectPath: dir, env });

    expect(first.ok).toBe(false);
    expect(!first.ok && first.error).not.toContain(holdoutFile);
    const metrics = await readEvalMetrics(dir, evalId);
    expect(metrics).toMatchObject({ status: "ok", holdout_status: "failed" });
    const raw = await Bun.file(
      join(dir, EVALS_DIR, evalId, "metrics.json"),
    ).text();
    expect(raw).toContain("<holdout>.missing");
    expect(raw).not.toContain(holdoutFile);

    const second = await scoreHoldout(evalId, { projectPath: dir, env });
    expect(second).toMatchObject({ ok: false, alreadyScored: true });
    expect((await holdoutCalls()).length).toBe(1);
  });

  test("refuses unknown evals, failed evals and drifted locks without running", async () => {
    await setup(0.89);
    expect((await scoreHoldout("nope", { projectPath: dir, env })).ok).toBe(
      false,
    );
    expect((await scoreHoldout("../x", { projectPath: dir, env })).ok).toBe(
      false,
    );

    const evalId = await evalCandidate();
    await Bun.write(
      join(dir, ".ml-ralph/eval/evaluate.py"),
      "print('cheat')\n",
    );
    const drifted = await scoreHoldout(evalId, { projectPath: dir, env });
    expect(!drifted.ok && drifted.error).toContain("evaluate.py was edited");
    expect(await holdoutCalls()).toEqual([]);
  });
});

describe("the holdout path stays out of the project and the prompts", () => {
  /** A runner whose iterations record the prompt instead of spawning claude */
  class PromptRecorder extends RalphRunner {
    prompts: string[] = [];
    protected override async runIteration(prompt: string): Promise<string> {
      this.prompts.push(prompt);
      return "<iteration_complete>";
    }
  }

  async function filesUnder(root: string): Promise<string[]> {
    const entries = await readdir(root, {
      recursive: true,
      withFileTypes: true,
    });
    return entries
      .filter((e) => e.isFile())
      .map((e) => join(e.parentPath, e.name));
  }

  for (const [label, holdoutScore, blocked] of [
    ["within the gap", 0.89, false],
    ["overfitting", 0.6, true],
  ] as const) {
    test(`init, lock, eval and holdout score (${label})`, async () => {
      process.env.XDG_CONFIG_HOME = configHome;
      process.env.ML_RALPH_HOLDOUT_PATH = holdoutFile;

      expect(
        (await initRalph({ projectPath: dir, name: "demo" })).success,
      ).toBe(true);
      await setup(holdoutScore);
      const runner = new PromptRecorder({
        projectPath: dir,
        maxIterations: 1,
        promotionDeps: {
          gitHead: async () => ({ ok: false, error: "no git" }),
        },
      });

      await runner.start();
      const evalId = await evalCandidate();
      const result = await runner.scoreHoldout(evalId);
      await runner.start();

      expect(result.ok && result.blocked).toBe(blocked);
      expect(runner.prompts).toHaveLength(2);

      const secrets = [holdoutFile, secretDir, "sealed-holdout"];
      for (const prompt of runner.prompts) {
        for (const secret of secrets) expect(prompt).not.toContain(secret);
      }
      const files = await filesUnder(dir);
      expect(files.length).toBeGreaterThan(10);
      for (const file of files) {
        const text = await readFile(file, "utf8");
        for (const secret of secrets) {
          expect(`${file}: ${text.includes(secret)}`).toBe(`${file}: false`);
        }
      }
      expect(
        (await readEvalMetrics(dir, evalId)) as { holdout_score?: number },
      ).toMatchObject({ holdout_score: holdoutScore });
    });
  }
});
