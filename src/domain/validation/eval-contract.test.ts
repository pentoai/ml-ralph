/**
 * Tests for eval contract validation
 */

import { describe, expect, test } from "bun:test";
import { validateEvalContract } from "./eval-contract.ts";

const valid = {
  primary_metric: "auc",
  direction: "max",
  search_split: "cv_5fold",
  seeds: [0, 1, 2],
  protocol: "5-fold CV, mean over seeds",
  success_threshold: 0.9,
  holdout_gap_threshold: 0.02,
  eval_timeout_seconds: 600,
  baseline_score: 0.81,
};

const fields = (input: unknown) => {
  const result = validateEvalContract(input);
  return result.valid ? [] : result.errors.map((e) => e.field);
};

describe("validateEvalContract", () => {
  test("accepts a complete contract", () => {
    const result = validateEvalContract(valid);
    expect(result.valid).toBe(true);
  });

  test("rejects non-objects", () => {
    expect(fields(null)).toEqual(["contract"]);
    expect(fields([])).toEqual(["contract"]);
  });

  test.each(Object.keys(valid))("names %s when it is missing", (field) => {
    const { [field as keyof typeof valid]: _omit, ...rest } = valid;
    expect(fields(rest)).toEqual([field]);
  });

  test("rejects a direction other than max|min", () => {
    expect(fields({ ...valid, direction: "up" })).toEqual(["direction"]);
  });

  test("rejects empty or non-integer seeds", () => {
    expect(fields({ ...valid, seeds: [] })).toEqual(["seeds"]);
    expect(fields({ ...valid, seeds: [1.5] })).toEqual(["seeds"]);
    expect(fields({ ...valid, seeds: "0" })).toEqual(["seeds"]);
  });

  test("rejects out-of-range numbers", () => {
    expect(fields({ ...valid, eval_timeout_seconds: 0 })).toEqual([
      "eval_timeout_seconds",
    ]);
    expect(fields({ ...valid, holdout_gap_threshold: -1 })).toEqual([
      "holdout_gap_threshold",
    ]);
    expect(fields({ ...valid, baseline_score: "0.8" })).toEqual([
      "baseline_score",
    ]);
  });
});
