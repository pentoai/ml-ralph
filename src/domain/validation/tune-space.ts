/**
 * Tune space validation - schema for the space.json that `ml-ralph tune` reads
 */

import type { ValidationError } from "./prd.ts";

export type TuneValue = number | string | boolean;

export type TuneParamSpec =
  | { type: "float"; low: number; high: number; log?: boolean; step?: number }
  | { type: "int"; low: number; high: number; log?: boolean; step?: number }
  | { type: "categorical"; choices: TuneValue[] };

export type TuneSpace = Record<string, TuneParamSpec>;

export type TuneSpaceValidation =
  | { valid: true; space: TuneSpace; errors: [] }
  | { valid: false; errors: ValidationError[] };

/** A parameter name is also the {placeholder} in the train command */
const PARAM_NAME = "[A-Za-z_][A-Za-z0-9_]*";

const isFiniteNumber = (v: unknown): v is number =>
  typeof v === "number" && Number.isFinite(v);

/**
 * Validate parsed space.json: an object mapping parameter names to
 * `{type: "float"|"int", low, high, log?, step?}` or `{type: "categorical", choices}`.
 * Every error names the field at fault.
 */
export function validateTuneSpace(input: unknown): TuneSpaceValidation {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return {
      valid: false,
      errors: [{ field: "space", message: "must be a JSON object" }],
    };
  }
  const entries = Object.entries(input);
  const errors: ValidationError[] = [];
  if (entries.length === 0) {
    errors.push({
      field: "space",
      message: "must define at least one parameter",
    });
  }
  const space: TuneSpace = {};

  for (const [name, raw] of entries) {
    const err = (field: string, message: string) =>
      errors.push({ field: `${name}${field ? `.${field}` : ""}`, message });
    if (!new RegExp(`^${PARAM_NAME}$`).test(name)) {
      err(
        "",
        "name must be letters, digits and underscores, not starting with a digit",
      );
      continue;
    }
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      err("", "must be an object");
      continue;
    }
    const p = raw as Record<string, unknown>;

    if (p.type === "categorical") {
      const valid =
        Array.isArray(p.choices) &&
        p.choices.length > 0 &&
        p.choices.every(
          (c) =>
            typeof c === "boolean" ||
            typeof c === "string" ||
            isFiniteNumber(c),
        );
      if (!valid) {
        err(
          "choices",
          "must be a non-empty array of strings, numbers or booleans",
        );
        continue;
      }
      space[name] = { type: "categorical", choices: p.choices as TuneValue[] };
      continue;
    }

    if (p.type !== "float" && p.type !== "int") {
      err("type", 'must be "float", "int" or "categorical"');
      continue;
    }
    const isInt = p.type === "int";
    const before = errors.length;
    for (const bound of ["low", "high"] as const) {
      const v = p[bound];
      if (!isFiniteNumber(v)) err(bound, "must be a finite number");
      else if (isInt && !Number.isInteger(v)) err(bound, "must be an integer");
    }
    if (errors.length === before && (p.low as number) > (p.high as number)) {
      err("high", "must not be below low");
    }
    if (p.log !== undefined && typeof p.log !== "boolean") {
      err("log", "must be true or false");
    } else if (p.log === true && isFiniteNumber(p.low) && p.low <= 0) {
      err("low", "must be above 0 when log is true");
    }
    if (p.step !== undefined) {
      if (!isFiniteNumber(p.step) || p.step <= 0) {
        err("step", "must be a positive number");
      } else if (isInt && !Number.isInteger(p.step)) {
        err("step", "must be an integer");
      } else if (p.log === true) {
        err("step", "cannot be combined with log");
      }
    }
    if (errors.length === before) {
      space[name] = {
        type: p.type as "float" | "int",
        low: p.low as number,
        high: p.high as number,
        ...(p.log === true ? { log: true } : {}),
        ...(p.step !== undefined ? { step: p.step as number } : {}),
      };
    }
  }

  if (errors.length > 0) return { valid: false, errors };
  return { valid: true, space, errors: [] };
}

/** `{name}` placeholders in a command, not counting shell `${name}` expansions */
const PLACEHOLDER = new RegExp(`(?<!\\$)\\{(${PARAM_NAME})\\}`, "g");

/** The distinct placeholder names in `template`, in order of first use */
export function findPlaceholders(template: string): string[] {
  return [...new Set([...template.matchAll(PLACEHOLDER)].map((m) => m[1]!))];
}

const SHELL_SAFE = /^[A-Za-z0-9_./:=+,@%-]+$/;

/** Quote a value for `sh -c`; plain tokens and numbers are left as they are */
export function shellQuote(value: TuneValue): string {
  const text = String(value);
  return SHELL_SAFE.test(text) ? text : `'${text.replaceAll("'", `'\\''`)}'`;
}

/** Replace each `{name}` with the trial's value (shell-quoted for a command, raw for a path) */
export function substituteParams(
  template: string,
  params: Record<string, TuneValue>,
  quote: boolean,
): string {
  return template.replace(PLACEHOLDER, (whole, name: string) => {
    const value = params[name];
    if (value === undefined) return whole;
    return quote ? shellQuote(value) : String(value);
  });
}
