/**
 * Eval contract validation - schema for .ml-ralph/eval/contract.json
 */

import type { ValidationError } from "./prd.ts";

export type EvalDirection = "max" | "min";

export interface EvalContract {
  primary_metric: string;
  direction: EvalDirection;
  search_split: string;
  seeds: number[];
  protocol: string;
  success_threshold: number;
  holdout_gap_threshold: number;
  eval_timeout_seconds: number;
  baseline_score: number;
}

export type EvalContractValidation =
  | { valid: true; contract: EvalContract; errors: [] }
  | { valid: false; errors: ValidationError[] };

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/**
 * Validate parsed contract.json content. Every error names the field at fault.
 */
export function validateEvalContract(input: unknown): EvalContractValidation {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return {
      valid: false,
      errors: [
        { field: "contract", message: "Contract must be a JSON object" },
      ],
    };
  }

  const c = input as Record<string, unknown>;
  const errors: ValidationError[] = [];
  const required = (field: string) =>
    errors.push({ field, message: "is required" });

  for (const field of ["primary_metric", "search_split", "protocol"]) {
    if (c[field] === undefined) required(field);
    else if (typeof c[field] !== "string" || !(c[field] as string).trim()) {
      errors.push({ field, message: "must be a non-empty string" });
    }
  }

  if (c.direction === undefined) required("direction");
  else if (c.direction !== "max" && c.direction !== "min") {
    errors.push({ field: "direction", message: 'must be "max" or "min"' });
  }

  if (c.seeds === undefined) required("seeds");
  else if (!Array.isArray(c.seeds) || c.seeds.length === 0) {
    errors.push({ field: "seeds", message: "must be a non-empty array" });
  } else if (!c.seeds.every((s) => Number.isInteger(s))) {
    errors.push({ field: "seeds", message: "must contain only integers" });
  }

  for (const field of ["success_threshold", "baseline_score"]) {
    if (c[field] === undefined) required(field);
    else if (!isFiniteNumber(c[field])) {
      errors.push({ field, message: "must be a finite number" });
    }
  }

  if (c.holdout_gap_threshold === undefined) required("holdout_gap_threshold");
  else if (
    !isFiniteNumber(c.holdout_gap_threshold) ||
    c.holdout_gap_threshold < 0
  ) {
    errors.push({
      field: "holdout_gap_threshold",
      message: "must be a number >= 0",
    });
  }

  if (c.eval_timeout_seconds === undefined) required("eval_timeout_seconds");
  else if (
    !isFiniteNumber(c.eval_timeout_seconds) ||
    c.eval_timeout_seconds <= 0
  ) {
    errors.push({
      field: "eval_timeout_seconds",
      message: "must be a number > 0",
    });
  }

  if (errors.length > 0) return { valid: false, errors };
  return { valid: true, contract: c as unknown as EvalContract, errors: [] };
}
