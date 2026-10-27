/**
 * Log event validation - one schema per event type written to .ml-ralph/log.jsonl
 */

import type { ValidationError } from "./prd.ts";

/** Shape of a field value. Describes itself for error messages. */
export type FieldSpec =
  | { kind: "string" }
  | { kind: "number" }
  | { kind: "enum"; values: readonly string[] }
  | { kind: "array"; items: FieldSpec; nonEmpty?: boolean }
  | { kind: "object"; fields: Record<string, Field> }
  | { kind: "numberMap" }
  | { kind: "oneOf"; options: FieldSpec[] };

export interface Field {
  spec: FieldSpec;
  optional?: boolean;
}

export interface LogEventSchema {
  /** Written by the runner only; the `ml-ralph log` command refuses it */
  runnerOnly?: boolean;
  fields: Record<string, Field>;
}

const str: Field = { spec: { kind: "string" } };
const num: Field = { spec: { kind: "number" } };
const oneOf = (...values: string[]): Field => ({
  spec: { kind: "enum", values },
});
const strings = (nonEmpty = false): Field => ({
  spec: { kind: "array", items: { kind: "string" }, nonEmpty },
});
const objects = (fields: Record<string, Field>, nonEmpty = false): Field => ({
  spec: { kind: "array", items: { kind: "object", fields }, nonEmpty },
});
const metrics: Field = { spec: { kind: "numberMap" } };
const optional = (field: Field): Field => ({ ...field, optional: true });

/** Schemas for every event type documented in templates.ts, by type name */
export const LOG_EVENT_SCHEMAS: Record<string, LogEventSchema> = {
  phase: {
    fields: {
      phase: oneOf("UNDERSTAND", "STRATEGIZE", "EXECUTE", "REFLECT"),
      summary: str,
    },
  },
  thinking: { fields: { subject: str, thoughts: str, conclusion: str } },
  mental_model: {
    fields: {
      domain: str,
      belief: str,
      confidence: oneOf("high", "medium", "low"),
      evidence: strings(),
    },
  },
  research: {
    fields: {
      source: str,
      key_insights: strings(),
      relevance: str,
      url: optional(str),
      insight: optional(str),
    },
  },
  path_analysis: {
    fields: {
      paths: objects(
        { id: str, description: str, expected: str, learning_value: str },
        true,
      ),
      chosen: str,
      rationale: str,
    },
  },
  data_verified: {
    fields: {
      dataset: str,
      checks: {
        spec: {
          kind: "oneOf",
          options: [
            { kind: "array", items: { kind: "string" } },
            { kind: "object", fields: {} },
          ],
        },
      },
      issues: strings(),
      action: str,
    },
  },
  result_verification: {
    fields: {
      result: str,
      verification_attempts: objects({ check: str, method: str, finding: str }),
      conclusion: str,
    },
  },
  success_verified: {
    fields: {
      criteria_met: strings(),
      verification_checks: strings(),
      attempts_to_break: strings(),
      conclusion: optional(str),
    },
  },
  hypothesis: {
    fields: {
      id: str,
      claim: str,
      expected_delta: num,
      rubrics: {
        spec: { kind: "array", items: { kind: "string" }, nonEmpty: true },
      },
      kill_criterion: str,
      rationale: optional(str),
    },
  },
  experiment: {
    fields: {
      hypothesis_id: str,
      metrics,
      observations: str,
      name: optional(str),
      eval_id: optional(str),
      wandb_run_id: optional(str),
      wandb_url: optional(str),
      config: optional({ spec: { kind: "object", fields: {} } }),
      surprises: optional(str),
    },
  },
  learning: { fields: { insight: str, source: str } },
  decision: {
    fields: {
      hypothesis_id: str,
      action: oneOf("keep", "reject", "iterate", "pivot"),
      reason: str,
      next_step: optional(str),
    },
  },
  strategic_retreat: { fields: { trigger: str, action: str, focus: str } },
  prd_updated: { fields: { field: str, change: str, reason: str } },
  kanban_updated: { fields: { changes: str, reason: str } },
  status: {
    fields: {
      status: oneOf("running", "paused", "complete"),
      reason: str,
    },
  },
  parallel_start: {
    fields: { team: str, hypotheses: strings(true), reason: str },
  },
  parallel_result: {
    fields: { hypothesis_id: str, agent: str, metrics, branch: str },
  },
  parallel_synthesis: {
    fields: { winner: str, reason: str, merged_branch: str },
  },
  contract_relocked: {
    runnerOnly: true,
    fields: {
      changes: objects({
        file: oneOf("evaluate.py", "contract.json"),
        kind: oneOf("edited", "deleted"),
      }),
      files: {
        spec: {
          kind: "object",
          fields: { "evaluate.py": str, "contract.json": str },
        },
      },
    },
  },
  eval: {
    runnerOnly: true,
    fields: {
      eval_id: str,
      status: oneOf("ok", "failed"),
      candidate: str,
      mean: optional(num),
      std: optional(num),
      reason: optional(str),
    },
  },
  promotion: {
    runnerOnly: true,
    fields: {
      verdict: oneOf("promoted", "rejected"),
      reason: str,
      candidate_eval_id: optional(str),
      incumbent_eval_id: optional(str),
      verifier_id: optional(str),
      candidate_mean: optional(num),
      reference_mean: optional(num),
    },
  },
  overfitting: {
    runnerOnly: true,
    fields: {
      eval_id: str,
      threshold: num,
    },
  },
  run_complete: {
    runnerOnly: true,
    fields: {
      eval_id: str,
      search_score: num,
      holdout_score: num,
      verifier_verdict: oneOf("approve"),
      verifier_id: str,
    },
  },
  completion_rejected: {
    runnerOnly: true,
    fields: {
      eval_id: str,
      reason: oneOf("verifier_rejected", "holdout_failed", "overfitting_gap"),
      detail: str,
      verifier_id: optional(str),
    },
  },
  completion_blocked: {
    runnerOnly: true,
    fields: {
      eval_id: str,
      reason: oneOf(
        "holdout_not_configured",
        "holdout_unavailable",
        "holdout_already_scored",
        "verifier_error",
        "holdout_error",
        "completion_error",
      ),
      error: str,
    },
  },
  holdout_access: {
    runnerOnly: true,
    fields: { tool: str, iteration: num },
  },
  verifier_verdict: {
    runnerOnly: true,
    fields: {
      id: str,
      verdict: oneOf("approve", "reject"),
      checks: {
        spec: {
          kind: "object",
          fields: {
            leakage: oneOf("pass", "fail", "unknown"),
            protocol_change: oneOf("pass", "fail", "unknown"),
            rubrics: oneOf("pass", "fail", "unknown"),
          },
        },
      },
      reason: str,
      output_path: str,
      model: optional(str),
    },
  },
};

function describe(spec: FieldSpec): string {
  switch (spec.kind) {
    case "string":
      return "non-empty string";
    case "number":
      return "finite number";
    case "enum":
      return `one of ${spec.values.map((v) => JSON.stringify(v)).join(", ")}`;
    case "array":
      return `${spec.nonEmpty ? "non-empty " : ""}array of ${describe(spec.items)}${spec.items.kind === "string" ? "s" : ""}`;
    case "object":
      return "object";
    case "numberMap":
      return "object mapping names to finite numbers";
    case "oneOf":
      return spec.options.map(describe).join(" or ");
  }
}

function checkValue(
  spec: FieldSpec,
  value: unknown,
  path: string,
  errors: ValidationError[],
): void {
  const fail = () =>
    errors.push({ field: path, message: `expected ${describe(spec)}` });

  switch (spec.kind) {
    case "string":
      if (typeof value !== "string" || !value.trim()) fail();
      return;
    case "number":
      if (typeof value !== "number" || !Number.isFinite(value)) fail();
      return;
    case "enum":
      if (typeof value !== "string" || !spec.values.includes(value)) fail();
      return;
    case "array": {
      if (!Array.isArray(value) || (spec.nonEmpty && value.length === 0)) {
        fail();
        return;
      }
      value.forEach((item, i) => {
        checkValue(spec.items, item, `${path}[${i}]`, errors);
      });
      return;
    }
    case "object": {
      if (typeof value !== "object" || value === null || Array.isArray(value)) {
        fail();
        return;
      }
      checkFields(spec.fields, value as Record<string, unknown>, path, errors);
      return;
    }
    case "numberMap": {
      if (typeof value !== "object" || value === null || Array.isArray(value)) {
        fail();
        return;
      }
      for (const [key, v] of Object.entries(value)) {
        if (typeof v !== "number" || !Number.isFinite(v)) {
          errors.push({
            field: `${path}.${key}`,
            message: "expected finite number",
          });
        }
      }
      return;
    }
    case "oneOf": {
      const matches = spec.options.some((option) => {
        const trial: ValidationError[] = [];
        checkValue(option, value, path, trial);
        return trial.length === 0;
      });
      if (!matches) fail();
      return;
    }
  }
}

function checkFields(
  fields: Record<string, Field>,
  data: Record<string, unknown>,
  prefix: string,
  errors: ValidationError[],
): void {
  for (const [name, field] of Object.entries(fields)) {
    const path = prefix ? `${prefix}.${name}` : name;
    const value = data[name];
    if (value === undefined) {
      if (!field.optional) {
        errors.push({
          field: path,
          message: `missing required field, expected ${describe(field.spec)}`,
        });
      }
      continue;
    }
    checkValue(field.spec, value, path, errors);
  }
}

export type LogEventValidation =
  | { valid: true; errors: [] }
  | { valid: false; errors: ValidationError[] };

/** Event types the agent may log (runner-only types are left out) */
export function logEventTypes(): string[] {
  return Object.entries(LOG_EVENT_SCHEMAS)
    .filter(([, schema]) => !schema.runnerOnly)
    .map(([type]) => type);
}

/**
 * Validate an event body (without ts and type) against the schema for its
 * type. Every error names the field path and what was expected.
 */
export function validateLogEvent(
  type: string,
  input: unknown,
): LogEventValidation {
  const schema = Object.hasOwn(LOG_EVENT_SCHEMAS, type)
    ? LOG_EVENT_SCHEMAS[type]
    : undefined;
  if (!schema) {
    return {
      valid: false,
      errors: [
        {
          field: "type",
          message: `unknown event type ${JSON.stringify(type)}, expected one of ${logEventTypes().join(", ")}`,
        },
      ],
    };
  }
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return {
      valid: false,
      errors: [{ field: "(root)", message: "expected a JSON object" }],
    };
  }

  const errors: ValidationError[] = [];
  checkFields(schema.fields, input as Record<string, unknown>, "", errors);
  if (errors.length > 0) return { valid: false, errors };
  return { valid: true, errors: [] };
}

/** True when only the runner may write events of this type */
export function isRunnerOnlyEvent(type: string): boolean {
  return Object.hasOwn(LOG_EVENT_SCHEMAS, type)
    ? LOG_EVENT_SCHEMAS[type]?.runnerOnly === true
    : false;
}
