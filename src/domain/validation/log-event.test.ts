/**
 * Tests for log event validation
 */

import { describe, expect, test } from "bun:test";
import {
  isRunnerOnlyEvent,
  LOG_EVENT_SCHEMAS,
  logEventTypes,
  validateLogEvent,
} from "./log-event.ts";

const hypothesis = {
  id: "H-001",
  claim: "Time features improve AUC",
  expected_delta: 0.05,
  rubrics: ["Split is unchanged"],
  kill_criterion: "AUC gain below 0.01 on every seed",
};

const errorsOf = (type: string, input: unknown) => {
  const result = validateLogEvent(type, input);
  return result.valid ? [] : result.errors;
};

describe("hypothesis", () => {
  test("accepts a complete hypothesis", () => {
    expect(validateLogEvent("hypothesis", hypothesis).valid).toBe(true);
  });

  test.each([
    "claim",
    "expected_delta",
    "rubrics",
    "kill_criterion",
  ])("names %s when it is missing", (field) => {
    const { [field as keyof typeof hypothesis]: _omit, ...rest } = hypothesis;
    const errors = errorsOf("hypothesis", rest);
    expect(errors.map((e) => e.field)).toEqual([field]);
    expect(errors[0]?.message).toContain("missing required field");
  });

  test("states the expected type for each field", () => {
    const messages = Object.fromEntries(
      errorsOf("hypothesis", {
        ...hypothesis,
        claim: 3,
        expected_delta: "big",
        rubrics: [],
        kill_criterion: "",
      }).map((e) => [e.field, e.message]),
    );
    expect(messages).toEqual({
      claim: "expected non-empty string",
      expected_delta: "expected finite number",
      rubrics: "expected non-empty array of non-empty strings",
      kill_criterion: "expected non-empty string",
    });
  });

  test("rejects non-string and non-finite entries", () => {
    expect(
      errorsOf("hypothesis", { ...hypothesis, rubrics: ["ok", 2] }),
    ).toEqual([{ field: "rubrics[1]", message: "expected non-empty string" }]);
    expect(
      errorsOf("hypothesis", { ...hypothesis, expected_delta: Number.NaN }),
    ).toHaveLength(1);
  });
});

describe("validateLogEvent", () => {
  test("rejects an unknown type and lists the known ones", () => {
    const [error] = errorsOf("hypotheses", {});
    expect(error?.field).toBe("type");
    expect(error?.message).toContain("hypothesis");
    expect(errorsOf("toString", {})[0]?.field).toBe("type");
  });

  test("rejects non-objects", () => {
    for (const input of [null, [], "x", 3]) {
      expect(errorsOf("phase", input)).toEqual([
        { field: "(root)", message: "expected a JSON object" },
      ]);
    }
  });

  test("lists allowed values for enums", () => {
    expect(errorsOf("phase", { phase: "DREAM", summary: "s" })[0]).toEqual({
      field: "phase",
      message:
        'expected one of "UNDERSTAND", "STRATEGIZE", "EXECUTE", "REFLECT"',
    });
  });

  test("reports nested field paths", () => {
    const errors = errorsOf("experiment", {
      hypothesis_id: "H-1",
      metrics: { auc: "high" },
      observations: "o",
    });
    expect(errors).toEqual([
      { field: "metrics.auc", message: "expected finite number" },
    ]);

    const nested = errorsOf("path_analysis", {
      paths: [{ id: "A", description: "d", expected: "e" }],
      chosen: "A",
      rationale: "r",
    });
    expect(nested.map((e) => e.field)).toEqual(["paths[0].learning_value"]);
  });

  test("keeps unknown extra fields", () => {
    expect(
      validateLogEvent("learning", {
        insight: "i",
        source: "s",
        extra: { anything: 1 },
      }).valid,
    ).toBe(true);
  });

  test("data_verified accepts checks as an array or an object", () => {
    const base = { dataset: "d", issues: [], action: "go" };
    expect(
      validateLogEvent("data_verified", { ...base, checks: ["a"] }).valid,
    ).toBe(true);
    expect(
      validateLogEvent("data_verified", { ...base, checks: { rows: {} } })
        .valid,
    ).toBe(true);
    expect(
      errorsOf("data_verified", { ...base, checks: "a" })[0]?.message,
    ).toBe("expected array of non-empty strings or object");
  });
});

describe("schema coverage", () => {
  test("has a schema for every event type in templates.ts", async () => {
    const source = await Bun.file(
      `${import.meta.dir}/../../infrastructure/ralph/templates.ts`,
    ).text();
    const documented = new Set(
      [...source.matchAll(/^\s+type: "([a-z_]+)";$/gm)].map((m) => m[1]),
    );
    expect(documented.size).toBeGreaterThan(15);
    for (const type of documented) {
      expect(Object.keys(LOG_EVENT_SCHEMAS)).toContain(type as string);
    }
  });

  test.each([
    "verifier_verdict",
    "contract_relocked",
    "eval",
    "promotion",
    "overfitting",
  ])("%s is runner-only and not offered to the agent", (type) => {
    expect(isRunnerOnlyEvent(type)).toBe(true);
    expect(logEventTypes()).not.toContain(type);
  });

  test("agent event types are not runner-only", () => {
    expect(isRunnerOnlyEvent("phase")).toBe(false);
  });
});

describe("contract_relocked", () => {
  const sha = "a".repeat(64);
  const relocked = {
    changes: [{ file: "evaluate.py", kind: "edited" }],
    files: { "evaluate.py": sha, "contract.json": sha },
  };

  test("accepts what the runner writes", () => {
    expect(validateLogEvent("contract_relocked", relocked).valid).toBe(true);
  });

  test.each(["changes", "files"])("names %s when it is missing", (field) => {
    const { [field as keyof typeof relocked]: _omit, ...rest } = relocked;
    expect(errorsOf("contract_relocked", rest).map((e) => e.field)).toEqual([
      field,
    ]);
  });

  test("rejects bad change entries and missing hashes", () => {
    expect(
      errorsOf("contract_relocked", {
        ...relocked,
        changes: [{ file: "train.py", kind: "edited" }],
        files: { "evaluate.py": sha },
      }).map((e) => e.field),
    ).toEqual(["changes[0].file", "files.contract.json"]);
  });
});
