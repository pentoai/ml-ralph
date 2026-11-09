/**
 * Tests for space.json validation and {param} substitution
 */

import { describe, expect, test } from "bun:test";
import {
  findPlaceholders,
  shellQuote,
  substituteParams,
  validateTuneSpace,
} from "./tune-space.ts";

const fields = (input: unknown) => {
  const r = validateTuneSpace(input);
  return r.valid ? [] : r.errors.map((e) => e.field);
};

describe("validateTuneSpace", () => {
  test("accepts float, int and categorical parameters", () => {
    const r = validateTuneSpace({
      lr: { type: "float", low: 1e-5, high: 0.1, log: true },
      depth: { type: "int", low: 1, high: 8, step: 1 },
      opt: { type: "categorical", choices: ["adam", "sgd", 3, true] },
    });
    expect(r.valid).toBe(true);
  });

  test("rejects a non-object and an empty space", () => {
    expect(fields([])).toEqual(["space"]);
    expect(fields({})).toEqual(["space"]);
  });

  test("names the field at fault", () => {
    expect(fields({ lr: { type: "float", low: 1, high: 0 } })).toEqual([
      "lr.high",
    ]);
    expect(
      fields({ lr: { type: "float", low: 0, high: 1, log: true } }),
    ).toEqual(["lr.low"]);
    expect(fields({ d: { type: "int", low: 0.5, high: 3 } })).toEqual([
      "d.low",
    ]);
    expect(fields({ o: { type: "categorical", choices: [] } })).toEqual([
      "o.choices",
    ]);
    expect(fields({ o: { type: "categorical", choices: [null] } })).toEqual([
      "o.choices",
    ]);
    expect(fields({ x: { type: "normal" } })).toEqual(["x.type"]);
    expect(fields({ "bad name": { type: "int", low: 1, high: 2 } })).toEqual([
      "bad name",
    ]);
    expect(
      fields({ x: { type: "float", low: 1, high: 2, log: true, step: 1 } }),
    ).toEqual(["x.step"]);
  });
});

describe("placeholders", () => {
  test("finds {name} but not shell dollar-brace expansions or JSON braces", () => {
    expect(
      findPlaceholders(
        "python train.py --lr {lr} --d {depth} --out $" +
          "{OUT}/{lr} --cfg '{\"a\": 1}'",
      ),
    ).toEqual(["lr", "depth"]);
  });

  test("substitutes values, quoting them for the shell", () => {
    const params = { lr: 0.01, opt: "a b; rm -rf /", flag: true };
    expect(
      substituteParams("t --lr {lr} --o {opt} {flag} {other}", params, true),
    ).toBe("t --lr 0.01 --o 'a b; rm -rf /' true {other}");
    expect(substituteParams("out/{opt}.pkl", params, false)).toBe(
      "out/a b; rm -rf /.pkl",
    );
    expect(shellQuote("it's")).toBe("'it'\\''s'");
  });
});
