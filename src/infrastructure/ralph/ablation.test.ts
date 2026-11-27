/**
 * Ablation phase against a real git repository: commits are made inside the
 * fake agent iteration, the runner promotes them with a stubbed verifier and
 * holdout, and the phase reverts them in a worktree with the real evaluator.
 * Needs git and python on PATH.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runAblations } from "./ablation.ts";
import { readLockedEval, scoreCandidate } from "./eval-command.ts";
import { lockEvalContract } from "./eval-lock.ts";
import { runGit } from "./git.ts";
import type { PromotionDeps } from "./promotion.ts";
import { auditClaims } from "./report.ts";
import { RalphRunner, type RunCompleteReason } from "./runner.ts";

const EVALUATE = `import argparse, json, os
p = argparse.ArgumentParser()
p.add_argument("--candidate"); p.add_argument("--split"); p.add_argument("--seed")
a = p.parse_args()
total = 0.0
for name in sorted(os.listdir(a.candidate)):
    with open(os.path.join(a.candidate, name)) as f:
        total += float(f.read().strip())
print(json.dumps({"score": total}))
`;

const contract = (success: number) => ({
  primary_metric: "auc",
  direction: "max",
  search_split: "cv",
  seeds: [0, 1],
  protocol: "cv",
  success_threshold: success,
  holdout_gap_threshold: 0.5,
  eval_timeout_seconds: 60,
  baseline_score: 0.1,
});

let dir: string;

const git = async (...args: string[]) => {
  const r = await runGit(dir, [
    "-c",
    "user.name=t",
    "-c",
    "user.email=t@t",
    "-c",
    "commit.gpgsign=false",
    ...args,
  ]);
  if (r.code !== 0) throw new Error(`git ${args.join(" ")}: ${r.err}`);
  return r.out.trim();
};

async function commitFile(name: string, text: string) {
  await Bun.write(join(dir, "feat", name), `${text}\n`);
  await git("add", "feat");
  await git("commit", "-m", `change ${name} ${text}`);
}

const events = async (type: string) =>
  (await Bun.file(join(dir, ".ml-ralph/log.jsonl")).text())
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l))
    .filter((e) => e.type === type);

const reportText = async () => {
  const [runId] = await readdir(join(dir, ".ml-ralph/reports"));
  return Bun.file(
    join(dir, ".ml-ralph/reports", runId ?? "", "report.md"),
  ).text();
};

async function setup(opts: {
  success: number;
  maxAblations?: number;
  config?: Record<string, unknown>;
}) {
  dir = await mkdtemp(join(tmpdir(), "ml-ralph-ablation-"));
  await mkdir(join(dir, ".ml-ralph/eval"), { recursive: true });
  await mkdir(join(dir, "feat"), { recursive: true });
  await git("init", "-q");
  await Bun.write(join(dir, ".gitignore"), ".ml-ralph/\n");
  await Bun.write(join(dir, "feat/base.txt"), "0.5\n");
  await git("add", ".");
  await git("commit", "-m", "baseline");
  await Bun.write(join(dir, ".ml-ralph/RALPH.md"), "# ralph");
  await Bun.write(
    join(dir, ".ml-ralph/prd.json"),
    JSON.stringify({ project: "p", status: "approved" }),
  );
  await Bun.write(
    join(dir, ".ml-ralph/eval/contract.json"),
    JSON.stringify(contract(opts.success)),
  );
  await Bun.write(join(dir, ".ml-ralph/eval/evaluate.py"), EVALUATE);
  expect((await lockEvalContract(dir)).ok).toBe(true);
  await Bun.write(
    join(dir, ".ml-ralph/log.jsonl"),
    `${JSON.stringify({
      ts: new Date().toISOString(),
      type: "hypothesis",
      id: "H-001",
      claim: "claim",
      expected_delta: 0.1,
      rubrics: ["no test labels used"],
      kill_criterion: "no gain",
    })}\n`,
  );
  const config = {
    ...(opts.maxAblations !== undefined
      ? { max_ablations: opts.maxAblations }
      : {}),
    ...opts.config,
  };
  await Bun.write(join(dir, ".ml-ralph/config.json"), JSON.stringify(config));
}

const verifyStub =
  (cost?: number): PromotionDeps["verify"] =>
  async () => ({
    id: "v",
    verdict: "approve",
    reason: "ok",
    checks: { leakage: "pass", protocol_change: "pass", rubrics: "pass" },
    outputPath: ".ml-ralph/verifier/v.json",
    feedback: "approve",
    ...(cost !== undefined ? { costUsd: cost } : {}),
  });

class FakeRunner extends RalphRunner {
  constructor(
    config: ConstructorParameters<typeof RalphRunner>[0],
    private body: () => Promise<string>,
  ) {
    super(config);
  }
  protected override async runIteration(): Promise<string> {
    return this.body();
  }
}

/** Run one iteration that commits `edits`, evals the result and hands it in */
async function runWith(
  edits: Array<[string, string]>,
  verifierCost?: number,
  maxIterations = 1,
) {
  const completions: RunCompleteReason[] = [];
  const errors: string[] = [];
  let first = true;
  const runner = new FakeRunner(
    {
      projectPath: dir,
      maxIterations,
      promotionDeps: { verify: verifyStub(verifierCost) },
      completionDeps: {
        scoreHoldout: async (id) => ({
          ok: true,
          evalId: id,
          searchScore: 1,
          holdoutScore: 1,
          holdoutGap: 0,
          threshold: 0.5,
          blocked: false,
          alreadyScored: false,
        }),
        readHoldoutPath: async () => ({
          ok: true,
          path: "/sealed/h.csv",
          realPath: "/sealed/h.csv",
        }),
      },
      onComplete: (r) => completions.push(r),
      onError: (e) => errors.push(e.message),
    },
    async () => {
      if (!first) return "<iteration_complete>";
      first = false;
      for (const [name, text] of edits) await commitFile(name, text);
      const locked = await readLockedEval(dir);
      if (!locked.ok) throw new Error(locked.error);
      const sha = await git("rev-parse", "HEAD");
      const res = await scoreCandidate({
        projectDir: dir,
        locked,
        sha,
        candidatePath: join(dir, "feat"),
        python: "python3",
      });
      return `<candidate_complete eval_id="${res.metrics?.eval_id}">`;
    },
  );
  await runner.start();
  expect(errors).toEqual([]);
  return { completions };
}

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("ablation phase after a completed run", () => {
  test("reverts each commit, logs one ablation event each, caps at max_ablations, leaves ralph/best alone", async () => {
    await setup({ success: 1.0, maxAblations: 2 });
    const { completions } = await runWith([
      ["a.txt", "0.1"],
      ["b.txt", "0.2"],
      ["c.txt", "0.3"],
    ]);
    expect(completions).toEqual(["completed"]);
    const best = await git("rev-parse", "ralph/best");
    expect(best).toBe(await git("rev-parse", "HEAD"));

    const log = await events("ablation");
    const commits = (await git("rev-list", "--reverse", "HEAD~3..HEAD")).split(
      "\n",
    );
    expect(log.map((e) => e.reverted_sha)).toEqual(commits);
    expect(log.map((e) => e.status)).toEqual(["ok", "ok", "skipped"]);
    expect(log[2].reason).toBe("cap");
    // Best scores 1.1; reverting a (0.1) or b (0.2) leaves 1.0 and 0.9
    expect(log[0].mean).toBeCloseTo(1.0);
    expect(log[1].mean).toBeCloseTo(0.9);
    expect(log[0].std).toBe(0);
    const evals = await events("eval");
    for (const e of log.slice(0, 2)) {
      expect(evals.some((x) => x.eval_id === e.eval_id)).toBe(true);
    }

    const report = await reportText();
    expect(report).toContain("## Ablations");
    expect(report).toContain("skipped: cap");
    expect(report).toContain(`[eval:${log[0].eval_id}]`);
    expect(
      auditClaims(
        report,
        await Bun.file(join(dir, ".ml-ralph/log.jsonl")).text(),
      ),
    ).toEqual([]);

    // The tag, the checked-out commit and the tree are untouched; the worktree is gone
    expect(await git("rev-parse", "ralph/best")).toBe(best);
    expect(await git("rev-parse", "HEAD")).toBe(best);
    expect(await git("status", "--porcelain")).toBe("");
    expect((await git("worktree", "list")).split("\n")).toHaveLength(1);
    expect(await events("promotion")).toHaveLength(1);
  });

  test("max_ablations 0 logs nothing and the report says so", async () => {
    await setup({ success: 1.0, maxAblations: 0 });
    await runWith([["a.txt", "0.6"]]);
    expect(await events("ablation")).toEqual([]);
    expect(await reportText()).toContain("Ablations disabled");
  });

  test("an invalid max_ablations stops the run at start", async () => {
    await setup({ success: 1.0, maxAblations: -1 });
    const errors: string[] = [];
    const runner = new FakeRunner(
      {
        projectPath: dir,
        maxIterations: 1,
        onError: (e) => errors.push(e.message),
      },
      async () => "x",
    );
    await runner.start();
    expect(errors[0]).toContain("max_ablations");
  });

  test("ralph/best equal to the baseline: no events, report says nothing to ablate", async () => {
    await setup({ success: 0.4 });
    const { completions } = await runWith([]);
    expect(completions).toEqual(["completed"]);
    expect(await events("ablation")).toEqual([]);
    expect(await reportText()).toContain("No promoted changes to ablate");
  });

  test("a revert that conflicts is a failed row and the rest still run", async () => {
    await setup({ success: 1.0 });
    // b edits the file a created, so reverting a cannot apply cleanly
    await runWith([
      ["a.txt", "0.1"],
      ["a.txt", "0.15"],
      ["c.txt", "0.4"],
    ]);
    const log = await events("ablation");
    expect(log.map((e) => e.status)).toEqual(["failed", "ok", "ok"]);
    expect(log[0].reason).toContain("revert did not apply cleanly");
    expect(log[0].eval_id).toBeUndefined();
    expect(await reportText()).toContain(
      "failed: revert did not apply cleanly",
    );
  });

  test("an exhausted budget skips every ablation and the report is still written", async () => {
    await setup({
      success: 1.0,
      config: { max_usd: 1 },
    });
    // The verifier's cost passes max_usd before the phase starts
    const { completions } = await runWith(
      [
        ["a.txt", "0.1"],
        ["b.txt", "0.2"],
        ["c.txt", "0.3"],
      ],
      5,
    );
    expect(completions).toEqual(["completed"]);
    const log = await events("ablation");
    expect(log.map((e) => `${e.status}:${e.reason}`)).toEqual([
      "skipped:budget",
      "skipped:budget",
      "skipped:budget",
    ]);
    expect(await reportText()).toContain("skipped: budget");
  });

  test("a run that ends without completing runs no ablations", async () => {
    await setup({ success: 5 });
    const { completions } = await runWith([["a.txt", "0.1"]]);
    expect(completions).toEqual(["max_iterations"]);
    expect(await events("ablation")).toEqual([]);
    expect(await reportText()).not.toContain("Ablations");
  });
});

describe("runAblations", () => {
  test("stops mid-phase when the budget runs out", async () => {
    await setup({ success: 1.0 });
    await runWith([
      ["a.txt", "0.1"],
      ["b.txt", "0.2"],
      ["c.txt", "0.3"],
    ]);
    let calls = 0;
    const outcome = await runAblations({
      projectPath: dir,
      runId: "r1",
      maxAblations: 5,
      stopReason: () => (calls++ >= 1 ? "budget" : null),
      onRow: async () => {},
    });
    expect(outcome.state).toBe("ran");
    if (outcome.state !== "ran") return;
    expect(outcome.rows.map((r) => `${r.status}:${r.reason ?? ""}`)).toEqual([
      "ok:",
      "skipped:budget",
      "skipped:budget",
    ]);
  });
});

describe("claim audit of the Ablations table", () => {
  const log = `${JSON.stringify({ type: "eval", eval_id: "e1", status: "ok", mean: 0.9, std: 0 })}\n`;
  const table = (row: string) =>
    `## Ablations\n\n| Reverted commit | Mean | Std | Eval | Status |\n| --- | --- | --- | --- | --- |\n${row}\n`;

  test("accepts a row linked to a recorded eval and rejects the rest", () => {
    expect(
      auditClaims(table("| abc | 0.9 | 0 | [eval:e1] | ok |"), log),
    ).toEqual([]);
    expect(
      auditClaims(table("| abc | 0.9 | 0 | [eval:e2] | ok |"), log),
    ).toHaveLength(1);
    expect(auditClaims(table("| abc | 0.9 | 0 | - | ok |"), log)).toHaveLength(
      1,
    );
    expect(
      auditClaims(table("| abc | 0.99 | 0 | [eval:e1] | ok |"), log),
    ).toHaveLength(1);
    expect(
      auditClaims(table("| abc | - | - | [eval:e2] | failed: x |"), log),
    ).toHaveLength(1);
    expect(
      auditClaims(table("| abc | - | - | - | skipped: cap |"), log),
    ).toEqual([]);
  });
});
