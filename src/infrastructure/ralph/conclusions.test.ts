import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { appendFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  checkConclusions,
  countWords,
  MAX_CONCLUSIONS_WORDS,
} from "./conclusions.ts";
import { lockEvalContract } from "./eval-lock.ts";
import { BASELINE_PATH } from "./promotion.ts";
import { RalphRunner } from "./runner.ts";

describe("checkConclusions", () => {
  const changed = (reason: string) =>
    JSON.stringify({ type: "conclusions_changed", reason, summary: "s" });

  test("unchanged file passes, even without events", () => {
    expect(checkConclusions("a b", "a b", [])).toBeNull();
  });

  test("counts whitespace-separated words", () => {
    expect(countWords("  one two\nthree\t four  ")).toBe(4);
    expect(countWords("")).toBe(0);
  });

  test("300 words pass, 301 are rejected as too_long", () => {
    const words = (n: number) => Array(n).fill("w").join(" ");
    expect(
      checkConclusions("", words(MAX_CONCLUSIONS_WORDS), [
        changed("refinement"),
      ]),
    ).toBeNull();
    expect(
      checkConclusions("", words(MAX_CONCLUSIONS_WORDS + 1), [
        changed("refinement"),
      ])?.reason,
    ).toBe("too_long");
  });

  test.each([
    "contradiction",
    "new_category",
    "flipped_recommendation",
    "refinement",
  ])("accepts reason %s", (reason) => {
    expect(checkConclusions("a", "b", [changed(reason)])).toBeNull();
  });

  test("rejects a change with no event or an unknown reason", () => {
    expect(checkConclusions("a", "b", [])?.reason).toBe("no_justification");
    expect(checkConclusions("a", "b", [changed("whim")])?.reason).toBe(
      "no_justification",
    );
    expect(
      checkConclusions("a", "b", ["not json", '{"type":"learning"}'])?.reason,
    ).toBe("no_justification");
  });
});

describe("runner conclusions", () => {
  let dir: string;

  class FakeRunner extends RalphRunner {
    prompts: string[] = [];
    constructor(
      config: ConstructorParameters<typeof RalphRunner>[0],
      private body: (i: number) => Promise<void>,
    ) {
      super(config);
    }
    protected override async runIteration(prompt: string): Promise<string> {
      this.prompts.push(prompt);
      await this.body(this.getCurrentIteration());
      return "<iteration_complete>";
    }
  }

  const logPath = () => join(dir, ".ml-ralph/log.jsonl");
  const append = (event: Record<string, unknown>) =>
    appendFile(logPath(), `${JSON.stringify({ ts: "t", ...event })}\n`);
  const conclusions = () =>
    Bun.file(join(dir, ".ml-ralph/conclusions.md")).text();

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "ml-ralph-conclusions-"));
    await mkdir(join(dir, ".ml-ralph/eval"), { recursive: true });
    await Bun.write(join(dir, ".ml-ralph/RALPH.md"), "# ralph");
    await Bun.write(
      join(dir, ".ml-ralph/prd.json"),
      JSON.stringify({ project: "p", status: "approved" }),
    );
    await Bun.write(
      join(dir, ".ml-ralph/eval/contract.json"),
      JSON.stringify({
        primary_metric: "auc",
        direction: "max",
        search_split: "cv_5fold",
        seeds: [0, 1],
        protocol: "5-fold CV",
        success_threshold: 0.9,
        holdout_gap_threshold: 0.02,
        eval_timeout_seconds: 600,
        baseline_score: 0.8,
      }),
    );
    await Bun.write(join(dir, ".ml-ralph/eval/evaluate.py"), "print('x')\n");
    await lockEvalContract(dir);
    await Bun.write(
      join(dir, BASELINE_PATH),
      JSON.stringify({ ref: "b".repeat(40), recorded_at: "2000-01-01" }),
    );
    await Bun.write(logPath(), "");
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const makeRunner = (body: (i: number) => Promise<void>, max = 2) =>
    new FakeRunner(
      {
        projectPath: dir,
        maxIterations: max,
        onError: (e) => {
          throw e;
        },
      },
      body,
    );

  test("start creates an empty conclusions.md when missing and keeps an existing one", async () => {
    await makeRunner(async () => {}, 1).start();
    expect(await conclusions()).toBe("");

    await Bun.write(join(dir, ".ml-ralph/conclusions.md"), "keep me");
    await makeRunner(async () => {}, 1).start();
    expect(await conclusions()).toBe("keep me");
  });

  test("an over-long edit is restored, logged and explained in the next prompt", async () => {
    await Bun.write(join(dir, ".ml-ralph/conclusions.md"), "original claim");
    const runner = makeRunner(async (i) => {
      if (i !== 1) return;
      await Bun.write(
        join(dir, ".ml-ralph/conclusions.md"),
        Array(301).fill("w").join(" "),
      );
      await append({
        type: "conclusions_changed",
        reason: "refinement",
        summary: "s",
      });
    });
    await runner.start();

    expect(await conclusions()).toBe("original claim");
    const log = (await Bun.file(logPath()).text())
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    const rejected = log.filter((e) => e.type === "conclusions_rejected");
    expect(rejected).toHaveLength(1);
    expect(rejected[0].reason).toBe("too_long");
    expect(runner.prompts[1]).toContain("rejected");
    expect(runner.prompts[1]).toContain("301 words");
    expect(runner.prompts[0]).not.toContain("rejected");
  });

  test("a change without a conclusions_changed event is restored; with one it stays", async () => {
    await Bun.write(join(dir, ".ml-ralph/conclusions.md"), "v0");
    const bad = makeRunner(async (i) => {
      if (i === 1) await Bun.write(join(dir, ".ml-ralph/conclusions.md"), "v1");
    });
    await bad.start();
    expect(await conclusions()).toBe("v0");
    expect(bad.prompts[1]).toContain("without a conclusions_changed event");

    const good = makeRunner(async (i) => {
      if (i !== 1) return;
      await Bun.write(join(dir, ".ml-ralph/conclusions.md"), "v2");
      await append({
        type: "conclusions_changed",
        reason: "contradiction",
        summary: "s",
      });
    });
    await good.start();
    expect(await conclusions()).toBe("v2");
  });

  test("the prompt inlines conclusions and only the last recent_events events (config key, default 30)", async () => {
    await Bun.write(join(dir, ".ml-ralph/conclusions.md"), "CLAIM-XYZ");
    for (let n = 1; n <= 40; n++) {
      await append({ type: "learning", insight: `ev-${n}-`, source: "s" });
    }
    const runner = makeRunner(async () => {}, 1);
    const prompt = await runner.buildPrompt();
    expect(prompt).toContain("CLAIM-XYZ");
    expect(prompt).toContain("ev-40-");
    expect(prompt).toContain("ev-11-");
    expect(prompt).not.toContain("ev-10-");
    expect(prompt).toContain("Do not read the whole log.jsonl");

    await Bun.write(
      join(dir, ".ml-ralph/config.json"),
      JSON.stringify({ recent_events: 5 }),
    );
    const small = await runner.buildPrompt();
    expect(small).toContain("ev-36-");
    expect(small).not.toContain("ev-35-");
  });

  test("prompt size at iteration 20 is within 10% of iteration 5 of a synthetic log", async () => {
    await Bun.write(
      join(dir, ".ml-ralph/conclusions.md"),
      "claim ".repeat(100),
    );
    const runner = makeRunner(async () => {}, 1);
    const sizeAfter = async (iteration: number) => {
      await Bun.write(logPath(), "");
      // ~8 events per iteration, as a real iteration logs several
      for (let n = 0; n < iteration * 8; n++) {
        await append({
          type: "learning",
          insight: `insight number ${n} with some detail`,
          source: "synthetic",
        });
      }
      return Buffer.byteLength(await runner.buildPrompt());
    };
    const at5 = await sizeAfter(5);
    const at20 = await sizeAfter(20);
    expect(Math.abs(at20 - at5) / at5).toBeLessThan(0.1);
  });
});
