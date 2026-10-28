import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { auditClaims, buildClaims, parseLog, writeReport } from "./report.ts";
import { RalphRunner, type RunCompleteReason } from "./runner.ts";

const evalEvent = (id: string, mean: number) => ({
  type: "eval",
  eval_id: id,
  status: "ok",
  candidate: "sub.csv",
  mean,
  std: 0.01,
});
const toLog = (events: Record<string, unknown>[]) =>
  `${events.map((e) => JSON.stringify(e)).join("\n")}\n`;

describe("claims", () => {
  test("every claim line ends in an eval id the log knows", () => {
    const log = toLog([
      evalEvent("e1", 0.85),
      {
        type: "promotion",
        verdict: "promoted",
        reason: "beats 0.8",
        candidate_eval_id: "e1",
      },
      {
        type: "experiment",
        hypothesis_id: "H-1",
        observations: "AUC 0.99!",
        eval_id: "forged",
        metrics: {},
      },
      {
        type: "experiment",
        hypothesis_id: "H-2",
        observations: "lift of 5%",
        eval_id: "e1",
        metrics: {},
      },
    ]);
    const claims = buildClaims(parseLog(log));
    expect(claims).toHaveLength(3);
    expect(claims.join("\n")).not.toContain("0.99");
    const report = `## Claims\n\n${claims.join("\n")}\n`;
    expect(auditClaims(report, log)).toEqual([]);
  });

  test("the audit fails a numeric claim with a missing or unknown eval id", () => {
    const log = toLog([evalEvent("e1", 0.85)]);
    const report = [
      "## Claims",
      "",
      "- AUC reached 0.97",
      "- AUC reached 0.97 [eval:nope]",
      "- AUC reached 0.85 [eval:e1]",
      "",
    ].join("\n");
    expect(auditClaims(report, log)).toEqual([
      "- AUC reached 0.97",
      "- AUC reached 0.97 [eval:nope]",
    ]);
  });
});

describe("report.md at the end of a run", () => {
  let dir: string;
  const logPath = () => join(dir, ".ml-ralph/log.jsonl");
  const reportPath = (id: string) =>
    join(dir, ".ml-ralph/reports", id, "report.md");

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "ml-ralph-report-"));
    await mkdir(join(dir, ".ml-ralph"), { recursive: true });
    await Bun.write(join(dir, ".ml-ralph/RALPH.md"), "# ralph");
    await Bun.write(
      join(dir, ".ml-ralph/prd.json"),
      JSON.stringify({
        project: "p",
        status: "draft",
        problem: "Predict churn",
      }),
    );
    await Bun.write(
      join(dir, ".ml-ralph/budget/run.json"),
      '{"run_id":"run-1"}',
    );
    await Bun.write(logPath(), toLog([evalEvent("e1", 0.85)]));
  });
  afterEach(() => rm(dir, { recursive: true, force: true }));

  const incumbent = async () => {
    await mkdir(join(dir, ".ml-ralph/evals/e1"), { recursive: true });
    await Bun.write(
      join(dir, ".ml-ralph/evals/e1/metrics.json"),
      JSON.stringify({
        eval_id: "e1",
        contract_hash: "a",
        evaluate_hash: "b",
        candidate: "sub.csv",
        split: "cv",
        created_at: "now",
        status: "ok",
        scores: [{ seed: 0, score: 0.85 }],
        mean: 0.85,
        std: 0.01,
      }),
    );
    await Bun.write(
      join(dir, ".ml-ralph/incumbent.json"),
      JSON.stringify({
        eval_id: "e1",
        candidate: "sub.csv",
        ref: "d".repeat(40),
        verifier_id: "v1",
        promoted_at: "now",
      }),
    );
  };

  test("states the problem, end reason, incumbent scores and SHA", async () => {
    await incumbent();
    await Bun.write(
      logPath(),
      toLog([
        evalEvent("e1", 0.85),
        {
          type: "run_complete",
          eval_id: "e1",
          search_score: 0.85,
          holdout_score: 0.83,
          verifier_verdict: "approve",
          verifier_id: "v1",
        },
      ]),
    );
    await writeReport({
      projectPath: dir,
      runId: "run-1",
      endReason: "run_complete",
    });
    const report = await Bun.file(reportPath("run-1")).text();
    expect(report).toContain("Predict churn");
    expect(report).toContain("End reason: run_complete");
    expect(report).toContain("Search score: 0.85");
    expect(report).toContain("Holdout score: 0.83");
    expect(report).toContain(`SHA: ${"d".repeat(40)}`);
    expect(auditClaims(report, await Bun.file(logPath()).text())).toEqual([]);
  });

  test("an unscored holdout reads `not scored`; no promotion is stated", async () => {
    await writeReport({
      projectPath: dir,
      runId: "run-1",
      endReason: "budget_exhausted",
    });
    expect(await Bun.file(reportPath("run-1")).text()).toContain(
      "no candidate was promoted",
    );
    await incumbent();
    await writeReport({
      projectPath: dir,
      runId: "run-1",
      endReason: "max_iterations",
    });
    expect(await Bun.file(reportPath("run-1")).text()).toContain(
      "Holdout score: not scored",
    );
  });

  test("refuses a run id that is not a safe directory name", async () => {
    await expect(
      writeReport({ projectPath: dir, runId: "../x", endReason: "user_quit" }),
    ).rejects.toThrow();
  });

  class Quick extends RalphRunner {
    protected override async runIteration(): Promise<string> {
      return "<iteration_complete>";
    }
  }
  const runOnce = async (stopDuring = false) => {
    const completions: RunCompleteReason[] = [];
    const runner = new Quick({
      projectPath: dir,
      maxIterations: 1,
      onComplete: (r) => completions.push(r),
      onIterationEnd: () => {
        if (stopDuring) runner.stop();
      },
    });
    await runner.start();
    return completions;
  };

  test("max_iterations writes the report before the run id is cleared", async () => {
    expect(await runOnce()).toEqual(["max_iterations"]);
    const report = await Bun.file(reportPath("run-1")).text();
    expect(report).toContain("End reason: max_iterations");
  });

  test("a user quit writes a report with end reason user_quit", async () => {
    await runOnce(true);
    expect(await Bun.file(reportPath("run-1")).text()).toContain(
      "End reason: user_quit",
    );
  });

  test("a failed report is logged as report_failed and the run still ends", async () => {
    await Bun.write(join(dir, ".ml-ralph/reports"), "not a directory");
    expect(await runOnce()).toEqual(["max_iterations"]);
    const events = parseLog(await Bun.file(logPath()).text());
    const failed = events.find((e) => e.type === "report_failed");
    expect(failed?.run_id).toBe("run-1");
  });
});
