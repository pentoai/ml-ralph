import { describe, expect, test } from "bun:test";
import type {
  EvalScoring,
  VerifiedEvals,
} from "../../infrastructure/ralph/index.ts";
import {
  assessExperiment,
  summarizeExperiments,
} from "./experiment-verification.ts";

const evals: VerifiedEvals = new Map([
  ["eval-a", { mean: 0.8, std: 0.01, seeds: 3, sha: null }],
  ["eval-b", { mean: 0.9, std: 0.02, seeds: 3, sha: null }],
]);
const max: EvalScoring = { primaryMetric: "auc", direction: "max" };
const min: EvalScoring = { primaryMetric: "rmse", direction: "min" };

describe("assessExperiment", () => {
  test("a real eval_id gives the eval mean", () => {
    const trust = assessExperiment(
      { eval_id: "eval-a", metrics: { auc: 0.8 } },
      evals,
      max,
    );
    expect(trust.eval?.mean).toBe(0.8);
    expect(trust.mismatch).toBe(false);
  });

  test("a made-up, missing or non-string eval_id has no eval", () => {
    for (const eval_id of ["eval-made-up", undefined, 7, null]) {
      expect(
        assessExperiment({ eval_id, metrics: { auc: 0.99 } }, evals, max).eval,
      ).toBeNull();
    }
  });

  test("a real eval_id with made-up metrics is flagged, with the eval mean to show", () => {
    const trust = assessExperiment(
      { eval_id: "eval-a", metrics: { auc: 0.99 } },
      evals,
      max,
    );
    expect(trust.eval?.mean).toBe(0.8);
    expect(trust.reported).toBe(0.99);
    expect(trust.mismatch).toBe(true);
  });

  test("rounding in the reported number is not a mismatch", () => {
    expect(
      assessExperiment(
        { eval_id: "eval-a", metrics: { AUC: 0.8004 } },
        evals,
        max,
      ).mismatch,
    ).toBe(false);
  });

  test("no primary metric reported, or no contract: nothing to compare", () => {
    const other = { eval_id: "eval-a", metrics: { f1: 0.1 } };
    expect(assessExperiment(other, evals, max).mismatch).toBe(false);
    expect(
      assessExperiment(
        { eval_id: "eval-a", metrics: { auc: 0.1 } },
        evals,
        null,
      ).mismatch,
    ).toBe(false);
  });
});

describe("summarizeExperiments", () => {
  const experiments = [
    { name: "unscored", metrics: { auc: 0.99 } },
    { name: "forged", eval_id: "eval-nope", metrics: { auc: 0.999 } },
    { name: "a", eval_id: "eval-a", metrics: { auc: 0.8 } },
    { name: "b", eval_id: "eval-b", metrics: { auc: 0.5 } },
  ];

  test("counts unverified experiments and picks best from eval means only", () => {
    expect(summarizeExperiments(experiments, evals, max)).toEqual({
      total: 4,
      unverified: 2,
      best: { name: "b", mean: 0.9 },
    });
  });

  test("direction min picks the lowest eval mean", () => {
    expect(summarizeExperiments(experiments, evals, min).best).toEqual({
      name: "a",
      mean: 0.8,
    });
  });

  test("no verified experiment means no best, however good the reported numbers", () => {
    expect(summarizeExperiments(experiments.slice(0, 2), evals, max)).toEqual({
      total: 2,
      unverified: 2,
      best: null,
    });
    expect(summarizeExperiments(experiments, new Map(), max).best).toBeNull();
  });
});
