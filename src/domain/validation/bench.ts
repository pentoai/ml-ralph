/**
 * Bench validation - schema for bench/suite.json and bench/results/*.json
 */

import type { BenchResults, BenchSuite } from "../types/index.ts";
import type { ValidationError } from "./prd.ts";

const EXPLOITS = ["leakage", "protocol_change", "rubrics"];
const TASK_ID = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

export type BenchSuiteValidation =
  | { valid: true; suite: BenchSuite; errors: [] }
  | { valid: false; errors: ValidationError[] };

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const isNumber = (v: unknown): v is number =>
  typeof v === "number" && Number.isFinite(v);

/** Validate parsed bench/suite.json. Every error names the task and field at fault. */
export function validateBenchSuite(input: unknown): BenchSuiteValidation {
  if (!isObject(input) || !Array.isArray(input.tasks)) {
    return {
      valid: false,
      errors: [{ field: "tasks", message: "must be an array" }],
    };
  }
  const errors: ValidationError[] = [];
  const seen = new Set<string>();
  input.tasks.forEach((raw, i) => {
    const at = (field: string) => `tasks[${i}].${field}`;
    if (!isObject(raw)) {
      errors.push({ field: `tasks[${i}]`, message: "must be an object" });
      return;
    }
    if (typeof raw.id !== "string" || !TASK_ID.test(raw.id)) {
      errors.push({
        field: at("id"),
        message: "must be letters, digits, - or _",
      });
    } else if (seen.has(raw.id)) {
      errors.push({ field: at("id"), message: `"${raw.id}" is duplicated` });
    } else seen.add(raw.id);
    if (typeof raw.path !== "string" || !raw.path.trim()) {
      errors.push({ field: at("path"), message: "must be a non-empty string" });
    }
    if (!isNumber(raw.target)) {
      errors.push({ field: at("target"), message: "must be a finite number" });
    }
    if (
      raw.expected_exploit !== null &&
      !EXPLOITS.includes(raw.expected_exploit as string)
    ) {
      errors.push({
        field: at("expected_exploit"),
        message: `must be null or one of ${EXPLOITS.join(", ")}`,
      });
    }
    for (const field of ["max_usd", "max_minutes"]) {
      if (!isNumber(raw[field]) || raw[field] <= 0) {
        errors.push({ field: at(field), message: "must be a number > 0" });
      }
    }
    if (
      raw.max_iterations !== undefined &&
      (!Number.isInteger(raw.max_iterations) ||
        (raw.max_iterations as number) < 1)
    ) {
      errors.push({
        field: at("max_iterations"),
        message: "must be an integer >= 1",
      });
    }
  });
  if (input.tasks.length === 0) {
    errors.push({ field: "tasks", message: "must not be empty" });
  }
  if (errors.length > 0) return { valid: false, errors };
  return { valid: true, suite: input as unknown as BenchSuite, errors: [] };
}

export type BenchResultsValidation =
  | { valid: true; results: BenchResults; errors: [] }
  | { valid: false; errors: ValidationError[] };

/** Check what `bench --compare` reads: a tasks array of objects with a string id and the compared fields */
export function validateBenchResults(input: unknown): BenchResultsValidation {
  if (!isObject(input) || !Array.isArray(input.tasks)) {
    return {
      valid: false,
      errors: [{ field: "tasks", message: "must be an array" }],
    };
  }
  const errors: ValidationError[] = [];
  input.tasks.forEach((raw, i) => {
    if (!isObject(raw) || typeof raw.id !== "string") {
      errors.push({
        field: `tasks[${i}].id`,
        message: "must be a string",
      });
      return;
    }
    if (typeof raw.success !== "boolean") {
      errors.push({
        field: `tasks[${i}].success`,
        message: "must be a boolean",
      });
    }
  });
  if (errors.length > 0) return { valid: false, errors };
  return { valid: true, results: input as unknown as BenchResults, errors: [] };
}
