/**
 * Tests for the metrics reader: only runner files under .ml-ralph/evals/ count
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  isExperimentVerified,
  readEvalMetrics,
  readVerifiedEvalIds,
} from "./eval-metrics.ts";

const hash = "a".repeat(64);
const metrics = (eval_id: string, extra: object = {}) => ({
  eval_id,
  contract_hash: hash,
  evaluate_hash: hash,
  candidate: "c.csv",
  split: "cv",
  created_at: "2026-01-01T00:00:00.000Z",
  status: "ok",
  scores: [{ seed: 0, score: 0.8 }],
  mean: 0.8,
  std: 0,
  ...extra,
});

let dir: string;
const writeEval = (id: string, body: unknown) =>
  Bun.write(
    join(dir, ".ml-ralph/evals", id, "metrics.json"),
    JSON.stringify(body),
  );

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "ml-ralph-metrics-"));
  await mkdir(join(dir, ".ml-ralph/evals"), { recursive: true });
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("readEvalMetrics", () => {
  test("reads a runner metrics file", async () => {
    await writeEval("eval-1", metrics("eval-1"));
    expect(await readEvalMetrics(dir, "eval-1")).toMatchObject({ mean: 0.8 });
  });

  test("ignores metric files outside .ml-ralph/evals/", async () => {
    await Bun.write(join(dir, "metrics.json"), JSON.stringify(metrics("x")));
    await Bun.write(
      join(dir, ".ml-ralph/metrics.json"),
      JSON.stringify(metrics("y")),
    );
    await Bun.write(
      join(dir, "outside/metrics.json"),
      JSON.stringify(metrics("outside")),
    );
    for (const id of ["x", "y", "outside", "..", "../..", "../outside", ""]) {
      expect(await readEvalMetrics(dir, id)).toBeNull();
    }
    expect(await readVerifiedEvalIds(dir)).toEqual(new Set());
  });

  test("ignores an id that escapes the directory or a symlink out of it", async () => {
    await Bun.write(
      join(dir, "outside/metrics.json"),
      JSON.stringify(metrics("link")),
    );
    await symlink(join(dir, "outside"), join(dir, ".ml-ralph/evals/link"));
    expect(await readEvalMetrics(dir, "link")).toBeNull();
    expect(await readEvalMetrics(dir, "../../outside")).toBeNull();
  });

  test("rejects a file whose eval_id disagrees with its directory, or is malformed", async () => {
    await writeEval("eval-1", metrics("eval-2"));
    await writeEval("eval-3", metrics("eval-3", { mean: "high" }));
    await Bun.write(join(dir, ".ml-ralph/evals/eval-4/metrics.json"), "{nope");
    for (const id of ["eval-1", "eval-3", "eval-4", "eval-missing"]) {
      expect(await readEvalMetrics(dir, id)).toBeNull();
    }
  });

  test("no evals directory at all", async () => {
    const empty = await mkdtemp(join(tmpdir(), "ml-ralph-metrics-empty-"));
    try {
      expect(await readEvalMetrics(empty, "eval-1")).toBeNull();
      expect(await readVerifiedEvalIds(empty)).toEqual(new Set());
    } finally {
      await rm(empty, { recursive: true, force: true });
    }
  });
});

describe("verified evals", () => {
  test("only finished ok evals are verified", async () => {
    await writeEval("eval-ok", metrics("eval-ok"));
    await writeEval("eval-bad", {
      eval_id: "eval-bad",
      contract_hash: hash,
      evaluate_hash: hash,
      candidate: "c",
      split: "cv",
      created_at: "t",
      status: "failed",
      reason: "seed 0: timed out",
    });
    const ids = await readVerifiedEvalIds(dir);
    expect(ids).toEqual(new Set(["eval-ok"]));
  });

  test("an experiment is verified only by an existing eval_id", () => {
    const ids = new Set(["eval-ok"]);
    expect(isExperimentVerified({ eval_id: "eval-ok" }, ids)).toBe(true);
    expect(isExperimentVerified({ eval_id: "eval-made-up" }, ids)).toBe(false);
    expect(isExperimentVerified({}, ids)).toBe(false);
    expect(isExperimentVerified({ eval_id: 7 }, ids)).toBe(false);
  });
});
