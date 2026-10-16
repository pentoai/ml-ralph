/**
 * Tests for the pre-iteration tamper check on locked eval files (never spawns claude)
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  checkEvalGate,
  describeEvalChanges,
  type EvalChange,
  findEvalChanges,
  lockEvalContract,
  readEvalLock,
  relockEvalContract,
} from "./eval-lock.ts";
import {
  type ContractDecision,
  RalphRunner,
  type RunCompleteReason,
  type RunnerConfig,
} from "./runner.ts";

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
const CHEAT_PY = "print('majority vote')\n";

let dir: string;
const evalPath = (name: string) => join(dir, ".ml-ralph/eval", name);
const sha = (text: string) => createHash("sha256").update(text).digest("hex");

async function writePrd(status: string) {
  await Bun.write(
    join(dir, ".ml-ralph/prd.json"),
    JSON.stringify({ project: "p", status }),
  );
}

async function setupLocked() {
  await mkdir(join(dir, ".ml-ralph/eval"), { recursive: true });
  await Bun.write(join(dir, ".ml-ralph/RALPH.md"), "# ralph");
  await writePrd("approved");
  await Bun.write(evalPath("contract.json"), JSON.stringify(CONTRACT));
  await Bun.write(evalPath("evaluate.py"), EVALUATE_PY);
  const locked = await lockEvalContract(dir);
  expect(locked.ok).toBe(true);
}

/** A runner whose iterations run a callback instead of spawning claude */
class FakeRunner extends RalphRunner {
  iterations: number[] = [];
  constructor(
    config: RunnerConfig,
    private duringIteration: (i: number) => Promise<void> = async () => {},
  ) {
    super(config);
  }
  protected override async runIteration(): Promise<string> {
    const i = this.getCurrentIteration();
    this.iterations.push(i);
    await this.duringIteration(i);
    return "<iteration_complete>";
  }
}

interface Harness {
  runner: FakeRunner;
  pauses: Array<{ changes: EvalChange[]; relockError?: string }>;
  completions: RunCompleteReason[];
  errors: string[];
}

/** Build a runner that answers each pause with the next decision in `decisions` */
function harness(
  decisions: ContractDecision[],
  duringIteration?: (i: number) => Promise<void>,
  maxIterations = 3,
): Harness {
  const h: Harness = {
    pauses: [],
    completions: [],
    errors: [],
  } as unknown as Harness;
  h.runner = new FakeRunner(
    {
      projectPath: dir,
      maxIterations,
      onComplete: (reason) => h.completions.push(reason),
      onError: (e) => h.errors.push(e.message),
      onContractChanged: (changes, relockError) => {
        h.pauses.push({ changes, relockError });
        const next = decisions.shift();
        if (next) h.runner.resolveContractChange(next);
      },
    },
    duringIteration,
  );
  return h;
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "ml-ralph-tamper-"));
  await setupLocked();
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("findEvalChanges", () => {
  test("is empty while the files match the lock", async () => {
    const lock = await readEvalLock(dir);
    expect(await findEvalChanges(dir, lock!.files)).toEqual([]);
  });

  test("reports edited and deleted files", async () => {
    const lock = await readEvalLock(dir);
    await Bun.write(evalPath("evaluate.py"), CHEAT_PY);
    await rm(evalPath("contract.json"));
    const changes = await findEvalChanges(dir, lock!.files);
    expect(changes).toEqual([
      { file: "evaluate.py", kind: "edited" },
      { file: "contract.json", kind: "deleted" },
    ]);
    expect(describeEvalChanges(changes)).toBe(
      "evaluate.py was edited; contract.json was deleted",
    );
  });
});

describe("relockEvalContract", () => {
  test("writes new hashes even when the PRD is not approved", async () => {
    await Bun.write(evalPath("evaluate.py"), CHEAT_PY);
    await writePrd("blocked");
    const result = await relockEvalContract(dir);
    expect(result.ok).toBe(true);
    const lock = await readEvalLock(dir);
    expect(lock?.files["evaluate.py"]).toBe(sha(CHEAT_PY));
  });

  test("fails when a locked file is gone and leaves lock.json alone", async () => {
    const before = await Bun.file(evalPath("lock.json")).text();
    await rm(evalPath("evaluate.py"));
    const result = await relockEvalContract(dir);
    expect(result.ok === false && result.error).toContain("evaluate.py");
    expect(await Bun.file(evalPath("lock.json")).text()).toBe(before);
  });
});

describe("checkEvalGate with a draft PRD", () => {
  test("still checks an existing lock instead of treating the run as SETUP", async () => {
    await writePrd("draft");
    await rm(evalPath("evaluate.py"));
    const gate = await checkEvalGate(dir);
    expect(gate.ok).toBe(false);
  });

  test("still refuses when only the marker is left", async () => {
    await writePrd("draft");
    await rm(evalPath("lock.json"));
    const gate = await checkEvalGate(dir);
    expect(gate.ok === false && gate.error).toContain("removed");
  });
});

describe("RalphRunner tamper check", () => {
  test("starts every iteration when the hashes match", async () => {
    const h = harness([]);
    await h.runner.start();
    expect(h.runner.iterations).toEqual([1, 2, 3]);
    expect(h.pauses).toEqual([]);
    expect(h.errors).toEqual([]);
    expect(h.completions).toEqual(["max_iterations"]);
  });

  test("pauses before the next iteration when a file was edited, and stop ends the run", async () => {
    const h = harness(["stop"], async (i) => {
      if (i === 1) await Bun.write(evalPath("evaluate.py"), CHEAT_PY);
    });
    await h.runner.start();

    expect(h.runner.iterations).toEqual([1]);
    expect(h.pauses).toEqual([
      { changes: [{ file: "evaluate.py", kind: "edited" }] },
    ]);
    expect(h.completions).toEqual(["contract_changed"]);
    expect(h.runner.isRunning()).toBe(false);
    const lock = await readEvalLock(dir);
    expect(lock?.files["evaluate.py"]).toBe(sha(EVALUATE_PY));
  });

  test("pauses when a file was deleted", async () => {
    const h = harness(["stop"], async (i) => {
      if (i === 1) await rm(evalPath("contract.json"));
    });
    await h.runner.start();

    expect(h.runner.iterations).toEqual([1]);
    expect(h.pauses).toEqual([
      { changes: [{ file: "contract.json", kind: "deleted" }] },
    ]);
    expect(h.completions).toEqual(["contract_changed"]);
  });

  test("re-lock writes new hashes, logs contract_relocked and resumes", async () => {
    const h = harness(["relock"], async (i) => {
      if (i === 1) await Bun.write(evalPath("evaluate.py"), CHEAT_PY);
    });
    await h.runner.start();

    expect(h.runner.iterations).toEqual([1, 2, 3]);
    expect(h.pauses).toHaveLength(1);
    expect(h.completions).toEqual(["max_iterations"]);

    const lock = await readEvalLock(dir);
    expect(lock?.files["evaluate.py"]).toBe(sha(CHEAT_PY));

    const events = (await Bun.file(join(dir, ".ml-ralph/log.jsonl")).text())
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    const relocked = events.filter((e) => e.type === "contract_relocked");
    expect(relocked).toHaveLength(1);
    expect(relocked[0].changes).toEqual([
      { file: "evaluate.py", kind: "edited" },
    ]);
    expect(relocked[0].files["evaluate.py"]).toBe(sha(CHEAT_PY));
  });

  test("a failed re-lock pauses again with the error", async () => {
    const h = harness(["relock", "stop"], async (i) => {
      if (i === 1) await rm(evalPath("evaluate.py"));
    });
    await h.runner.start();

    expect(h.runner.iterations).toEqual([1]);
    expect(h.pauses).toHaveLength(2);
    expect(h.pauses[0]?.relockError).toBeUndefined();
    expect(h.pauses[1]?.relockError).toContain("evaluate.py");
    expect(h.completions).toEqual(["contract_changed"]);
  });

  test("an edit that also rewrites lock.json still pauses", async () => {
    const h = harness(["stop"], async (i) => {
      if (i !== 1) return;
      await Bun.write(evalPath("evaluate.py"), CHEAT_PY);
      await Bun.write(
        evalPath("lock.json"),
        JSON.stringify({
          locked_at: new Date().toISOString(),
          files: {
            "evaluate.py": sha(CHEAT_PY),
            "contract.json": sha(JSON.stringify(CONTRACT)),
          },
        }),
      );
    });
    await h.runner.start();

    expect(h.runner.iterations).toEqual([1]);
    expect(h.pauses[0]?.changes).toEqual([
      { file: "evaluate.py", kind: "edited" },
    ]);
  });

  test("resetting the PRD to draft and deleting the lock and marker does not skip the check", async () => {
    const h = harness(["stop"], async (i) => {
      if (i !== 1) return;
      await Bun.write(evalPath("evaluate.py"), CHEAT_PY);
      await writePrd("draft");
      await rm(evalPath("lock.json"));
      await rm(join(dir, ".ml-ralph/eval-lock.created"));
    });
    await h.runner.start();

    expect(h.runner.iterations).toEqual([1]);
    expect(h.pauses[0]?.changes).toEqual([
      { file: "evaluate.py", kind: "edited" },
    ]);
  });

  test("a new run against an edited file with a draft PRD pauses before iteration 1", async () => {
    await Bun.write(evalPath("evaluate.py"), CHEAT_PY);
    await writePrd("draft");
    const h = harness(["stop"]);
    await h.runner.start();

    expect(h.runner.iterations).toEqual([]);
    expect(h.pauses).toHaveLength(1);
    expect(h.completions).toEqual(["contract_changed"]);
  });

  test("stop() while paused ends the run without a completion reason", async () => {
    const h = harness([], async (i) => {
      if (i === 1) await Bun.write(evalPath("evaluate.py"), CHEAT_PY);
    });
    const running = h.runner.start();
    while (h.pauses.length === 0) await Bun.sleep(5);

    h.runner.stop();
    await running;

    expect(h.runner.iterations).toEqual([1]);
    expect(h.completions).toEqual([]);
    expect(h.runner.isRunning()).toBe(false);
    expect(h.runner.resolveContractChange("relock")).toBe(false);
  });

  test("without an onContractChanged handler the run ends with an error", async () => {
    const errors: string[] = [];
    const runner = new FakeRunner(
      { projectPath: dir, onError: (e) => errors.push(e.message) },
      async (i) => {
        if (i === 1) await Bun.write(evalPath("evaluate.py"), CHEAT_PY);
      },
    );
    await runner.start();

    expect(runner.iterations).toEqual([1]);
    expect(errors).toEqual([
      "Locked eval file changed: evaluate.py was edited",
    ]);
  });
});
