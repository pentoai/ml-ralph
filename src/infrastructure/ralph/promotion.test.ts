/**
 * Tests for the promotion gate (never spawns claude: the verifier and git are stubbed)
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { appendFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateLogEvent } from "../../domain/validation/index.ts";
import {
  type EvalLock,
  lockEvalContract,
  readEvalLock,
  relockEvalContract,
} from "./eval-lock.ts";
import { runLogCommand } from "./log-command.ts";
import {
  BASELINE_PATH,
  decideOnScore,
  defaultGitHead,
  INCUMBENT_PATH,
  type Incumbent,
  judgeCandidate,
  type PromotionDeps,
  parseCandidateComplete,
  readIncumbent,
  recordBaselineRef,
} from "./promotion.ts";
import { RalphRunner, type RunCompleteReason } from "./runner.ts";
import { RALPH_MD } from "./templates.ts";
import type { VerifyCandidateOptions } from "./verifier.ts";

const CONTRACT = {
  primary_metric: "auc",
  direction: "max",
  search_split: "cv_5fold",
  seeds: [0, 1, 2],
  protocol: "5-fold CV",
  success_threshold: 0.9,
  holdout_gap_threshold: 0.02,
  eval_timeout_seconds: 600,
  baseline_score: 0.8,
};
const BASE_REF = "b".repeat(40);
const HEAD_REF = "c".repeat(40);
const LONG_AGO = "2000-01-01T00:00:00.000Z";

let dir: string;
let lockFiles: EvalLock["files"];
let verifierCalls: VerifyCandidateOptions[];
let verifierAnswer: "approve" | "reject" | "throw";
let head: Awaited<ReturnType<PromotionDeps["gitHead"]>>;
let evalCounter = 0;
let verifierCost: number | undefined;
let verifierDelayMs = 0;

const deps = (): Partial<PromotionDeps> => ({
  gitHead: async () => head,
  verify: async (options) => {
    verifierCalls.push(options);
    if (verifierDelayMs) await Bun.sleep(verifierDelayMs);
    if (verifierAnswer === "throw") throw new Error("claude exploded");
    const approve = verifierAnswer === "approve";
    return {
      id: `v-${verifierCalls.length}`,
      verdict: approve ? "approve" : "reject",
      checks: {
        leakage: approve ? "pass" : "fail",
        protocol_change: "pass",
        rubrics: "pass",
      },
      reason: approve ? "looks fine" : "test labels used in training",
      outputPath: `.ml-ralph/verifier/v-${verifierCalls.length}.json`,
      ...(verifierCost !== undefined ? { costUsd: verifierCost } : {}),
      feedback: approve
        ? "Verifier verdict: approve - looks fine"
        : "Verifier verdict: reject - test labels used in training",
    };
  },
});

async function appendLog(event: Record<string, unknown>, ts?: string) {
  await appendFile(
    join(dir, ".ml-ralph/log.jsonl"),
    `${JSON.stringify({ ts: ts ?? new Date().toISOString(), ...event })}\n`,
  );
}

/** What `ml-ralph eval` leaves behind: metrics.json plus the runner's eval event */
async function writeEval(
  overrides: Partial<{
    id: string;
    status: "ok" | "failed";
    mean: number;
    std: number;
    ts: string;
    hashes: EvalLock["files"];
    logEvent: boolean;
    reason: string;
  }> = {},
): Promise<string> {
  const id = overrides.id ?? `eval-test-${++evalCounter}`;
  const status = overrides.status ?? "ok";
  const hashes = overrides.hashes ?? lockFiles;
  const base = {
    eval_id: id,
    contract_hash: hashes["contract.json"],
    evaluate_hash: hashes["evaluate.py"],
    candidate: "submissions/h001.csv",
    split: "cv_5fold",
    created_at: new Date().toISOString(),
  };
  const mean = overrides.mean ?? 0.85;
  const std = overrides.std ?? 0.01;
  const metrics =
    status === "ok"
      ? {
          ...base,
          status,
          scores: [{ seed: 0, score: mean }],
          mean,
          std,
        }
      : { ...base, status, reason: overrides.reason ?? "seed 0: crashed" };
  await mkdir(join(dir, ".ml-ralph/evals", id), { recursive: true });
  await Bun.write(
    join(dir, ".ml-ralph/evals", id, "metrics.json"),
    JSON.stringify(metrics),
  );
  if (overrides.logEvent !== false) {
    await appendLog(
      {
        type: "eval",
        eval_id: id,
        status,
        candidate: base.candidate,
        ...(status === "ok"
          ? { mean, std }
          : { reason: overrides.reason ?? "seed 0: crashed" }),
      },
      overrides.ts,
    );
  }
  return id;
}

async function logHypothesis(id = "H-001", rubrics = ["no test labels used"]) {
  await appendLog({
    type: "hypothesis",
    id,
    claim: `claim ${id}`,
    expected_delta: 0.03,
    rubrics,
    kill_criterion: "no gain",
  });
}

const judge = (claimedEvalId: string | null, startedAt = LONG_AGO) =>
  judgeCandidate(
    {
      projectPath: dir,
      claimedEvalId,
      iterationStartedAt: startedAt,
      lockedFiles: lockFiles,
    },
    deps(),
  );

async function promotionEvents() {
  const text = await Bun.file(join(dir, ".ml-ralph/log.jsonl")).text();
  return text
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l))
    .filter((e) => e.type === "promotion");
}

const incumbentFile = () => Bun.file(join(dir, INCUMBENT_PATH));

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "ml-ralph-promotion-"));
  await mkdir(join(dir, ".ml-ralph/eval"), { recursive: true });
  await Bun.write(join(dir, ".ml-ralph/RALPH.md"), "# ralph");
  await Bun.write(
    join(dir, ".ml-ralph/prd.json"),
    JSON.stringify({ project: "p", status: "approved" }),
  );
  await Bun.write(
    join(dir, ".ml-ralph/eval/contract.json"),
    JSON.stringify(CONTRACT),
  );
  await Bun.write(join(dir, ".ml-ralph/eval/evaluate.py"), "print('x')\n");
  expect((await lockEvalContract(dir)).ok).toBe(true);
  lockFiles = (await readEvalLock(dir))!.files;
  await Bun.write(
    join(dir, BASELINE_PATH),
    JSON.stringify({ ref: BASE_REF, recorded_at: LONG_AGO }),
  );
  await Bun.write(join(dir, ".ml-ralph/log.jsonl"), "");
  verifierCalls = [];
  verifierAnswer = "approve";
  verifierCost = undefined;
  verifierDelayMs = 0;
  head = { ok: true, ref: HEAD_REF };
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("RALPH_MD", () => {
  test("tells the agent to emit <candidate_complete eval_id> and never <project_complete>", () => {
    expect(RALPH_MD).toContain('<candidate_complete eval_id="eval-...">');
    expect(RALPH_MD).not.toContain("project_complete");
    expect(RALPH_MD).toContain("promotion");
  });
});

describe("parseCandidateComplete", () => {
  test("reads the eval_id from the tag", () => {
    expect(
      parseCandidateComplete('done <candidate_complete eval_id="eval-1">'),
    ).toEqual({ evalId: "eval-1" });
    expect(
      parseCandidateComplete("<candidate_complete eval_id='eval-2' >"),
    ).toEqual({ evalId: "eval-2" });
  });

  test("takes the last tag", () => {
    expect(
      parseCandidateComplete(
        '<candidate_complete eval_id="a"> <candidate_complete eval_id="b">',
      ),
    ).toEqual({ evalId: "b" });
  });

  test("a tag without an eval_id still counts, with a null id", () => {
    expect(parseCandidateComplete("<candidate_complete>")).toEqual({
      evalId: null,
    });
    expect(parseCandidateComplete('<candidate_complete eval_id="">')).toEqual({
      evalId: null,
    });
  });

  test("null when there is no tag", () => {
    expect(parseCandidateComplete("<project_complete>")).toBeNull();
    expect(parseCandidateComplete("<iteration_complete>")).toBeNull();
  });
});

describe("decideOnScore", () => {
  const base = {
    candidateStd: 0.01,
    referenceMean: 0.8,
    referenceStd: 0.02,
  };

  test("needs an improvement above the larger std", () => {
    expect(
      decideOnScore({ ...base, direction: "max", candidateMean: 0.83 }).beats,
    ).toBe(true);
    expect(
      decideOnScore({ ...base, direction: "max", candidateMean: 0.82 }).beats,
    ).toBe(false);
    expect(
      decideOnScore({ ...base, direction: "max", candidateMean: 0.81 }).margin,
    ).toBe(0.02);
  });

  test("an improvement equal to the noise does not count", () => {
    expect(
      decideOnScore({
        direction: "max",
        candidateMean: 0.9,
        candidateStd: 0,
        referenceMean: 0.9,
        referenceStd: 0,
      }).beats,
    ).toBe(false);
  });

  test("direction min rewards a lower mean", () => {
    const input = { ...base, referenceMean: 0.5, referenceStd: 0.01 };
    expect(
      decideOnScore({ ...input, direction: "min", candidateMean: 0.45 }).beats,
    ).toBe(true);
    expect(
      decideOnScore({ ...input, direction: "min", candidateMean: 0.55 }).beats,
    ).toBe(false);
  });
});

describe("judgeCandidate", () => {
  test("promotes the first candidate when it beats baseline_score by more than its std", async () => {
    await logHypothesis();
    const id = await writeEval({ mean: 0.85, std: 0.01 });

    const decision = await judge(id);

    expect(decision.verdict).toBe("promoted");
    expect(decision.feedback).toContain("promoted");
    const stored = await readIncumbent(dir);
    expect(stored).toMatchObject({
      state: "ok",
      incumbent: { eval_id: id, ref: HEAD_REF, verifier_id: "v-1" },
    });
    expect(verifierCalls).toHaveLength(1);
    expect(verifierCalls[0]).toMatchObject({
      candidateRef: HEAD_REF,
      baselineRef: BASE_REF,
      hypothesis: { id: "H-001", rubrics: ["no test labels used"] },
    });
    expect(verifierCalls[0]?.incumbentRef).toBeUndefined();

    const events = await promotionEvents();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      verdict: "promoted",
      candidate_eval_id: id,
      verifier_id: "v-1",
      candidate_mean: 0.85,
      reference_mean: 0.8,
    });
    expect(events[0].incumbent_eval_id).toBeUndefined();
  });

  test("the next candidate is compared with the incumbent's metrics.json and diffed against its commit", async () => {
    await logHypothesis();
    const first = await writeEval({ mean: 0.85, std: 0.01 });
    await judge(first);

    head = { ok: true, ref: "d".repeat(40) };
    const second = await writeEval({ mean: 0.9, std: 0.01 });
    const decision = await judge(second);

    expect(decision.verdict).toBe("promoted");
    expect(verifierCalls[1]).toMatchObject({
      candidateRef: "d".repeat(40),
      incumbentRef: HEAD_REF,
    });
    const events = await promotionEvents();
    expect(events[1]).toMatchObject({
      verdict: "promoted",
      candidate_eval_id: second,
      incumbent_eval_id: first,
      reference_mean: 0.85,
    });
    expect(await incumbentFile().json()).toMatchObject({ eval_id: second });
  });

  test("rejects a score within seed noise of the incumbent, without calling the verifier", async () => {
    await logHypothesis();
    const first = await writeEval({ mean: 0.85, std: 0.01 });
    await judge(first);
    verifierCalls = [];

    const noisy = await writeEval({ mean: 0.87, std: 0.03 });
    const decision = await judge(noisy);

    expect(decision.verdict).toBe("rejected");
    expect(decision.reason).toContain("seed noise");
    expect(verifierCalls).toHaveLength(0);
    expect(await incumbentFile().json()).toMatchObject({ eval_id: first });
    const events = await promotionEvents();
    expect(events.at(-1)).toMatchObject({
      verdict: "rejected",
      candidate_eval_id: noisy,
      incumbent_eval_id: first,
    });
    expect(events.at(-1).verifier_id).toBeUndefined();
  });

  test("rejects a first candidate that does not beat baseline_score", async () => {
    await logHypothesis();
    const id = await writeEval({ mean: 0.8, std: 0 });
    const decision = await judge(id);
    expect(decision.verdict).toBe("rejected");
    expect(await incumbentFile().exists()).toBe(false);
    expect(verifierCalls).toHaveLength(0);
  });

  test("with direction min, a lower mean wins", async () => {
    await logHypothesis();
    const contract = { ...CONTRACT, direction: "min", baseline_score: 0.5 };
    await Bun.write(
      join(dir, ".ml-ralph/eval/contract.json"),
      JSON.stringify(contract),
    );
    expect((await relockEvalContract(dir)).ok).toBe(true);
    lockFiles = (await readEvalLock(dir))!.files;

    const worse = await writeEval({ mean: 0.55, std: 0.01 });
    expect((await judge(worse)).verdict).toBe("rejected");
    const better = await writeEval({ mean: 0.4, std: 0.01 });
    expect((await judge(better)).verdict).toBe("promoted");
  });

  test("rejects when the verifier rejects, and logs its id and one line of reason", async () => {
    await logHypothesis();
    verifierAnswer = "reject";
    const id = await writeEval({ mean: 0.9 });

    const decision = await judge(id);

    expect(decision.verdict).toBe("rejected");
    expect(decision.reason).toBe(
      "Verifier verdict: reject - test labels used in training",
    );
    expect(decision.feedback).not.toContain("leakage");
    expect(await incumbentFile().exists()).toBe(false);
    const [event] = await promotionEvents();
    expect(event).toMatchObject({
      verdict: "rejected",
      candidate_eval_id: id,
      verifier_id: "v-1",
    });
  });

  test("rejects a failed eval", async () => {
    await logHypothesis();
    const id = await writeEval({
      status: "failed",
      reason: "seed 1: timed out",
    });
    const decision = await judge(id);
    expect(decision.verdict).toBe("rejected");
    expect(decision.reason).toContain("seed 1: timed out");
    expect(verifierCalls).toHaveLength(0);
    expect(await incumbentFile().exists()).toBe(false);
  });

  test("a verifier that throws rejects instead of crashing the run", async () => {
    await logHypothesis();
    verifierAnswer = "throw";
    const id = await writeEval({ mean: 0.9 });
    const decision = await judge(id);
    expect(decision.verdict).toBe("rejected");
    expect(decision.reason).toContain("claude exploded");
    expect(await incumbentFile().exists()).toBe(false);
  });

  test("rejects a tag with no eval_id", async () => {
    await logHypothesis();
    const decision = await judge(null);
    expect(decision.verdict).toBe("rejected");
    const [event] = await promotionEvents();
    expect(event.candidate_eval_id).toBeUndefined();
  });

  test("an eval_id the runner never logged earns nothing, even with a metrics.json", async () => {
    await logHypothesis();
    // What an agent could fake: a metrics file and an experiment event, but no runner eval event
    const id = await writeEval({ mean: 0.99, logEvent: false });
    await appendLog({
      type: "experiment",
      hypothesis_id: "H-001",
      eval_id: id,
      metrics: { auc: 0.99 },
      observations: "great",
    });
    expect((await judge(id)).verdict).toBe("rejected");
    expect((await judge("eval-does-not-exist")).verdict).toBe("rejected");
    expect(verifierCalls).toHaveLength(0);
  });

  test("scores come from metrics.json, not from the agent's experiment event or numbers", async () => {
    await logHypothesis();
    const id = await writeEval({ mean: 0.7, std: 0.01 });
    await appendLog({
      type: "experiment",
      hypothesis_id: "H-001",
      eval_id: id,
      metrics: { auc: 0.99, mean: 0.99 },
      observations: "claims 0.99",
    });
    const decision = await judge(id);
    expect(decision.verdict).toBe("rejected");
    expect((await promotionEvents())[0]).toMatchObject({ candidate_mean: 0.7 });
  });

  test("an eval from an earlier iteration cannot be reused", async () => {
    await logHypothesis();
    const old = await writeEval({ mean: 0.9, ts: "2020-01-01T00:00:00.000Z" });
    const decision = await judge(old, "2021-01-01T00:00:00.000Z");
    expect(decision.verdict).toBe("rejected");
    expect(decision.reason).toContain("this iteration");
  });

  test("rejects an eval scored under another lock", async () => {
    await logHypothesis();
    const id = await writeEval({
      mean: 0.9,
      hashes: {
        "evaluate.py": "0".repeat(64),
        "contract.json": lockFiles["contract.json"],
      },
    });
    expect((await judge(id)).verdict).toBe("rejected");
  });

  test("rejects when contract.json no longer matches the lock", async () => {
    await logHypothesis();
    const id = await writeEval({ mean: 0.9 });
    await Bun.write(
      join(dir, ".ml-ralph/eval/contract.json"),
      JSON.stringify({ ...CONTRACT, baseline_score: 0 }),
    );
    const decision = await judge(id);
    expect(decision.verdict).toBe("rejected");
    expect(decision.reason).toContain("lock");
  });

  test("rejects when the tracked files are dirty or there is no commit", async () => {
    await logHypothesis();
    const id = await writeEval({ mean: 0.9 });
    head = {
      ok: false,
      error:
        "tracked files have uncommitted changes; commit the candidate first",
    };
    const decision = await judge(id);
    expect(decision.verdict).toBe("rejected");
    expect(decision.reason).toContain("uncommitted");
    expect(verifierCalls).toHaveLength(0);
  });

  test("rejects when no baseline commit was recorded and there is no incumbent", async () => {
    await logHypothesis();
    await rm(join(dir, BASELINE_PATH));
    const id = await writeEval({ mean: 0.9 });
    const decision = await judge(id);
    expect(decision.verdict).toBe("rejected");
    expect(decision.reason).toContain("baseline commit");
  });

  test("rejects when no hypothesis with rubrics was logged", async () => {
    const id = await writeEval({ mean: 0.9 });
    const decision = await judge(id);
    expect(decision.verdict).toBe("rejected");
    expect(decision.reason).toContain("hypothesis");
    expect(verifierCalls).toHaveLength(0);
  });

  test("the verifier gets the rubrics of every hypothesis logged this iteration", async () => {
    await logHypothesis("H-001", ["old rubric"]);
    const startedAt = new Date(Date.now() + 50).toISOString();
    await Bun.sleep(100);
    await logHypothesis("H-002", ["strict rubric"]);
    await logHypothesis("H-003", ["weak rubric"]);
    const id = await writeEval({ mean: 0.9 });
    await judge(id, startedAt);
    expect(verifierCalls[0]?.hypothesis).toMatchObject({
      id: "H-002, H-003",
      rubrics: ["strict rubric", "weak rubric"],
    });
  });

  test("an unreadable incumbent.json rejects instead of falling back to the baseline", async () => {
    await logHypothesis();
    await Bun.write(join(dir, INCUMBENT_PATH), "{not json");
    const id = await writeEval({ mean: 0.99 });
    const decision = await judge(id);
    expect(decision.verdict).toBe("rejected");
    expect(decision.reason).toContain("incumbent.json");
  });

  test("an incumbent whose eval has no metrics.json rejects", async () => {
    await logHypothesis();
    const incumbent: Incumbent = {
      eval_id: "eval-gone",
      candidate: "x",
      ref: BASE_REF,
      verifier_id: "v-0",
      promoted_at: LONG_AGO,
    };
    await Bun.write(join(dir, INCUMBENT_PATH), JSON.stringify(incumbent));
    const id = await writeEval({ mean: 0.99 });
    expect((await judge(id)).verdict).toBe("rejected");
  });

  test("an incumbent scored under an earlier lock is ignored and baseline_score is used", async () => {
    await logHypothesis();
    const stale = await writeEval({
      mean: 0.99,
      hashes: {
        "evaluate.py": "0".repeat(64),
        "contract.json": "1".repeat(64),
      },
    });
    await Bun.write(
      join(dir, INCUMBENT_PATH),
      JSON.stringify({
        eval_id: stale,
        candidate: "x",
        ref: "e".repeat(40),
        verifier_id: "v-0",
        promoted_at: LONG_AGO,
      }),
    );
    const id = await writeEval({ mean: 0.85 });
    const decision = await judge(id);
    expect(decision.verdict).toBe("promoted");
    expect(decision.reason).toContain("earlier lock");
    expect(verifierCalls[0]?.incumbentRef).toBeUndefined();
    expect((await promotionEvents())[0].incumbent_eval_id).toBeUndefined();
  });

  test("every logged promotion event passes the runner-only schema, and the agent cannot forge one", async () => {
    await logHypothesis();
    await judge(await writeEval({ mean: 0.85 }));
    await judge(await writeEval({ mean: 0.85 }));
    await judge(null);
    const events = await promotionEvents();
    expect(events).toHaveLength(3);
    for (const { ts: _ts, type: _type, ...body } of events) {
      expect(validateLogEvent("promotion", body)).toEqual({
        valid: true,
        errors: [],
      });
    }
    const forged = await runLogCommand(
      ["promotion", '{"verdict":"promoted","reason":"trust me"}'],
      { cwd: dir },
    );
    expect(forged.code).not.toBe(0);
    expect(forged.stderr).toContain("runner only");
  });
});

describe("RalphRunner promotion", () => {
  type Iteration = (i: number, prompt: string) => Promise<string>;

  class FakeRunner extends RalphRunner {
    prompts: string[] = [];
    constructor(
      config: ConstructorParameters<typeof RalphRunner>[0],
      private body: Iteration,
    ) {
      super(config);
    }
    protected override async runIteration(prompt: string): Promise<string> {
      this.prompts.push(prompt);
      return this.body(this.getCurrentIteration(), prompt);
    }
  }

  function run(maxIterations: number, body: Iteration) {
    const completions: RunCompleteReason[] = [];
    const errors: string[] = [];
    const runner = new FakeRunner(
      {
        projectPath: dir,
        maxIterations,
        promotionDeps: deps(),
        onComplete: (r) => completions.push(r),
        onError: (e) => errors.push(e.message),
      },
      body,
    );
    return { runner, completions, errors };
  }

  test("<project_complete> does not end the run, and the agent is told so", async () => {
    const { runner, completions, errors } = run(
      3,
      async () => "<iteration_complete> <project_complete>",
    );
    await runner.start();
    expect(errors).toEqual([]);
    expect(runner.prompts).toHaveLength(3);
    expect(runner.prompts[1]).toContain("ignores <project_complete>");
    expect(completions).toEqual(["max_iterations"]);
  });

  test("the prompt asks for <candidate_complete> and never offers <project_complete>", async () => {
    const { runner } = run(1, async () => "<iteration_complete>");
    await runner.start();
    expect(runner.prompts[0]).toContain('<candidate_complete eval_id="...">');
    expect(runner.prompts[0]).not.toContain("output: <project_complete>");
  });

  test("a candidate_complete is judged by the runner and the decision reaches the next prompt", async () => {
    await logHypothesis();
    const { runner, completions } = run(2, async (i) => {
      if (i === 1) {
        const id = await writeEval({ mean: 0.9 });
        return `<iteration_complete> <candidate_complete eval_id="${id}">`;
      }
      return "<iteration_complete>";
    });
    await runner.start();

    const [event] = await promotionEvents();
    expect(event).toMatchObject({ verdict: "promoted" });
    expect(await incumbentFile().exists()).toBe(true);
    expect(runner.prompts[1]).toContain("Runner decision on");
    expect(runner.prompts[1]).toContain("promoted");
    expect(runner.prompts[1]).not.toContain("leakage");
    // Reaching the iteration limit is a stop, whatever was promoted
    expect(completions).toEqual(["max_iterations"]);
  });

  test("a rejected candidate shows the agent only the verdict and one line of reason", async () => {
    await logHypothesis();
    verifierAnswer = "reject";
    const { runner } = run(2, async (i) => {
      if (i === 1) {
        const id = await writeEval({ mean: 0.9 });
        return `<candidate_complete eval_id="${id}">`;
      }
      return "";
    });
    await runner.start();
    const feedback = runner.prompts[1] ?? "";
    expect(feedback).toContain(
      "rejected - Verifier verdict: reject - test labels used in training",
    );
    expect(feedback).not.toContain("protocol_change");
    expect(await incumbentFile().exists()).toBe(false);
  });

  const candidateIteration = (maxIterations: number) =>
    run(maxIterations, async (i) => {
      if (i === 1) {
        const id = await writeEval({ mean: 0.9 });
        return `<candidate_complete eval_id="${id}">`;
      }
      return "";
    });
  const budgetStatuses = async () =>
    (await Bun.file(join(dir, ".ml-ralph/log.jsonl")).text())
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l))
      .filter((e) => e.type === "budget_status");

  test("the verifier's reported cost counts toward usd_spent", async () => {
    await logHypothesis();
    await Bun.write(
      join(dir, ".ml-ralph/config.json"),
      JSON.stringify({ max_usd: 10 }),
    );
    verifierCost = 0.75;
    const { runner } = candidateIteration(2);
    await runner.start();
    const spent = (await budgetStatuses()).map((e) => e.usd_spent);
    // iteration 1 status ($0 from the fake), then the verifier's cost, then iteration 2
    expect(spent).toEqual([0, 0.75, 0.75]);
    expect(runner.prompts[1]).toContain("USD remaining: $9.25");
  });

  test("a verifier that pushes spend past max_usd ends the run before the next iteration", async () => {
    await logHypothesis();
    await Bun.write(
      join(dir, ".ml-ralph/config.json"),
      JSON.stringify({ max_usd: 0.5 }),
    );
    verifierCost = 0.75;
    const { runner, completions } = candidateIteration(3);
    await runner.start();
    expect(runner.prompts).toHaveLength(1);
    expect(completions).toEqual(["budget_exhausted"]);
  });

  test("a wall-clock cap crossed while judging ends the run without spawning another iteration", async () => {
    await logHypothesis();
    await Bun.write(
      join(dir, ".ml-ralph/config.json"),
      JSON.stringify({ max_wall_clock_minutes: 0.0025 }),
    );
    verifierDelayMs = 400;
    const { runner, completions } = candidateIteration(3);
    await runner.start();
    expect(runner.prompts).toHaveLength(1);
    expect(completions).toEqual(["budget_exhausted"]);
  });

  test("stopping the run before the last iteration ends is not max_iterations", async () => {
    const { runner, completions } = run(2, async (i) => {
      if (i === 2) runner.stop();
      return "";
    });
    await runner.start();
    expect(completions).toEqual([]);
  });

  test("records the baseline commit once, from the first iteration", async () => {
    await rm(join(dir, BASELINE_PATH));
    const { runner } = run(2, async () => "");
    await runner.start();
    expect(await Bun.file(join(dir, BASELINE_PATH)).json()).toMatchObject({
      ref: HEAD_REF,
    });
  });
});

describe("git helpers", () => {
  async function git(cwd: string, ...args: string[]) {
    const proc = Bun.spawn(["git", ...args], {
      cwd,
      stdout: "pipe",
      stderr: "pipe",
    });
    const out = await new Response(proc.stdout).text();
    expect(await proc.exited).toBe(0);
    return out.trim();
  }

  async function repo() {
    const root = await mkdtemp(join(tmpdir(), "ml-ralph-git-"));
    await git(root, "init", "-q");
    await git(root, "config", "user.email", "t@example.com");
    await git(root, "config", "user.name", "t");
    await git(root, "config", "commit.gpgsign", "false");
    await Bun.write(join(root, "train.py"), "print(1)\n");
    await mkdir(join(root, ".ml-ralph"), { recursive: true });
    await git(root, "add", "train.py");
    await git(root, "commit", "-q", "-m", "init");
    return root;
  }

  test("defaultGitHead returns HEAD and only objects to tracked edits outside .ml-ralph", async () => {
    const root = await repo();
    try {
      const sha = await git(root, "rev-parse", "HEAD");
      expect(await defaultGitHead(root, true)).toEqual({ ok: true, ref: sha });

      await Bun.write(join(root, "scratch.csv"), "untracked\n");
      await Bun.write(join(root, ".ml-ralph/log.jsonl"), "{}\n");
      expect(await defaultGitHead(root, true)).toEqual({ ok: true, ref: sha });

      await Bun.write(join(root, "train.py"), "print(2)\n");
      const dirty = await defaultGitHead(root, true);
      expect(dirty.ok).toBe(false);
      expect(await defaultGitHead(root, false)).toEqual({ ok: true, ref: sha });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("defaultGitHead fails in a directory without a commit", async () => {
    const root = await mkdtemp(join(tmpdir(), "ml-ralph-nogit-"));
    try {
      expect((await defaultGitHead(root, false)).ok).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("recordBaselineRef writes once and never overwrites", async () => {
    await rm(join(dir, BASELINE_PATH));
    await recordBaselineRef(dir, async () => ({
      ok: true,
      ref: "a".repeat(40),
    }));
    await recordBaselineRef(dir, async () => ({
      ok: true,
      ref: "f".repeat(40),
    }));
    expect(await Bun.file(join(dir, BASELINE_PATH)).json()).toMatchObject({
      ref: "a".repeat(40),
    });
  });

  test("recordBaselineRef writes nothing when git has no commit", async () => {
    await rm(join(dir, BASELINE_PATH));
    await recordBaselineRef(dir, async () => ({ ok: false, error: "no git" }));
    expect(await Bun.file(join(dir, BASELINE_PATH)).exists()).toBe(false);
  });
});
