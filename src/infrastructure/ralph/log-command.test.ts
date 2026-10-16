/**
 * Tests for the `ml-ralph log` command, in a temporary project directory
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pkg from "../../../package.json" with { type: "json" };
import { runLogCommand } from "./log-command.ts";
import { RALPH_MD } from "./templates.ts";

const hypothesis = {
  id: "H-001",
  claim: "Time features improve AUC",
  expected_delta: 0.05,
  rubrics: ["Split is unchanged"],
  kill_criterion: "AUC gain below 0.01 on every seed",
};

let dir: string;
const logPath = () => join(dir, ".ml-ralph", "log.jsonl");
const readLog = async () => {
  const file = Bun.file(logPath());
  return (await file.exists()) ? await file.text() : "";
};
const log = (...args: string[]) => runLogCommand(args, { cwd: dir });

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "ml-ralph-log-"));
  await mkdir(join(dir, ".ml-ralph"));
  await Bun.write(logPath(), "");
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("ml-ralph log", () => {
  test("appends exactly one line with ts and type set", async () => {
    const result = await log("hypothesis", JSON.stringify(hypothesis));
    expect(result.code).toBe(0);

    const lines = (await readLog()).split("\n");
    expect(lines).toHaveLength(2);
    expect(lines[1]).toBe("");
    const event = JSON.parse(lines[0] as string);
    expect(event).toMatchObject({ type: "hypothesis", ...hypothesis });
    expect(new Date(event.ts).toISOString()).toBe(event.ts);

    await log("phase", '{"phase":"EXECUTE","summary":"go"}');
    const all = (await readLog()).trimEnd().split("\n");
    expect(all.map((l) => JSON.parse(l).type)).toEqual(["hypothesis", "phase"]);
  });

  test("replaces a ts supplied by the caller and accepts a matching type", async () => {
    await log(
      "phase",
      '{"ts":"...","type":"phase","phase":"REFLECT","summary":"s"}',
    );
    const event = JSON.parse(await readLog());
    expect(event.ts).not.toBe("...");
    expect(event.type).toBe("phase");
  });

  test("reads the JSON from stdin when the argument is -", async () => {
    const result = await runLogCommand(["learning", "-"], {
      cwd: dir,
      readStdin: async () => `{"insight":"it's fine","source":"s"}`,
    });
    expect(result.code).toBe(0);
    expect(JSON.parse(await readLog()).insight).toBe("it's fine");
  });

  test("finds .ml-ralph from a subdirectory", async () => {
    const sub = join(dir, "src", "deep");
    await mkdir(sub, { recursive: true });
    const result = await runLogCommand(
      ["thinking", '{"subject":"a","thoughts":"b","conclusion":"c"}'],
      { cwd: sub },
    );
    expect(result.code).toBe(0);
    expect((await readLog()).trim().split("\n")).toHaveLength(1);
  });

  test("starts on a new line after an unterminated line", async () => {
    await Bun.write(logPath(), '{"ts":"t","type":"phase"}');
    await log("phase", '{"phase":"EXECUTE","summary":"go"}');
    const lines = (await readLog()).trimEnd().split("\n");
    expect(lines).toHaveLength(2);
    for (const line of lines) JSON.parse(line);
  });
});

describe("rejections append nothing", () => {
  const expectRejected = async (
    result: Awaited<ReturnType<typeof log>>,
    ...messages: string[]
  ) => {
    expect(result.code).not.toBe(0);
    expect(result.stdout).toBe("");
    for (const message of messages) expect(result.stderr).toContain(message);
    expect(await readLog()).toBe("");
  };

  test("unknown type", async () => {
    await expectRejected(
      await log("hypotheses", "{}"),
      "type:",
      "unknown event type",
      "hypothesis",
    );
  });

  test("missing required field", async () => {
    await expectRejected(
      await log("decision", '{"hypothesis_id":"H-1","reason":"r"}'),
      "action: missing required field",
      'one of "keep", "reject", "iterate", "pivot"',
    );
  });

  test("wrong type for a field", async () => {
    await expectRejected(
      await log(
        "experiment",
        '{"hypothesis_id":"H-1","metrics":{"auc":"x"},"observations":"o"}',
      ),
      "metrics.auc: expected finite number",
    );
  });

  test("unparseable JSON", async () => {
    await expectRejected(await log("phase", "{not json"), "not valid JSON");
    await expectRejected(await log("phase", ""), "not valid JSON");
  });

  test("JSON that is not an object", async () => {
    await expectRejected(
      await log("phase", "[1]"),
      "(root): expected a JSON object",
    );
  });

  test("a type in the JSON that disagrees with the command", async () => {
    await expectRejected(
      await log("phase", '{"type":"learning","phase":"EXECUTE","summary":"s"}'),
      "type:",
    );
  });

  test("a runner-only type", async () => {
    await expectRejected(
      await log(
        "verifier_verdict",
        '{"id":"v","verdict":"approve","checks":{"leakage":"pass","protocol_change":"pass","rubrics":"pass"},"reason":"ok","output_path":"p"}',
      ),
      "runner only",
    );
  });

  test("no .ml-ralph directory", async () => {
    const empty = await mkdtemp(join(tmpdir(), "ml-ralph-empty-"));
    try {
      const result = await runLogCommand(
        ["phase", '{"phase":"EXECUTE","summary":"s"}'],
        { cwd: empty },
      );
      expect(result.code).not.toBe(0);
      expect(result.stderr).toContain(".ml-ralph");
      expect(
        await Bun.file(join(empty, ".ml-ralph", "log.jsonl")).exists(),
      ).toBe(false);
    } finally {
      await rm(empty, { recursive: true, force: true });
    }
  });

  test("missing arguments print usage", async () => {
    await expectRejected(await runLogCommand([], { cwd: dir }), "Usage:");
    await expectRejected(
      await runLogCommand(["phase"], { cwd: dir }),
      "Usage:",
    );
  });
});

describe("hypothesis fields", () => {
  test.each([
    "claim",
    "expected_delta",
    "rubrics",
    "kill_criterion",
  ])("rejects a hypothesis without %s", async (field) => {
    const { [field as keyof typeof hypothesis]: _omit, ...rest } = hypothesis;
    const result = await log("hypothesis", JSON.stringify(rest));
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain(`${field}: missing required field`);
    expect(await readLog()).toBe("");
  });

  test("rejects empty rubrics and a non-numeric expected_delta", async () => {
    const empty = await log(
      "hypothesis",
      JSON.stringify({ ...hypothesis, rubrics: [] }),
    );
    expect(empty.stderr).toContain("rubrics: expected non-empty array");
    const text = await log(
      "hypothesis",
      JSON.stringify({ ...hypothesis, expected_delta: "+5%" }),
    );
    expect(text.stderr).toContain("expected_delta: expected finite number");
    expect(await readLog()).toBe("");
  });
});

describe("RALPH_MD", () => {
  test("logs through ml-ralph log, never by echoing into log.jsonl", () => {
    expect(RALPH_MD).toContain(`bunx @pentoai/ml-ralph@${pkg.version} log `);
    expect(RALPH_MD).not.toMatch(/echo[^\n]*log\.jsonl/);
    expect(RALPH_MD).not.toMatch(/>>\s*\S*log\.jsonl/);
  });

  test("every invocation pins the package version", () => {
    expect(RALPH_MD).not.toMatch(/bunx @pentoai\/ml-ralph(?!@)/);
    expect(RALPH_MD).not.toMatch(/ml-ralph@(?!\d)/);
  });

  test("the data_verified diagram names every required field", () => {
    const line = RALPH_MD.split("\n").find((l) =>
      l.includes("Log: data_verified"),
    );
    for (const field of ["dataset", "checks", "issues", "action"]) {
      expect(line).toContain(field);
    }
  });

  test("its hypothesis example passes validation", () => {
    const line = RALPH_MD.split("\n").find((l) =>
      l.startsWith('{"type":"hypothesis"'),
    );
    expect(line).toBeDefined();
    const result = runLogCommand(["hypothesis", line as string], { cwd: dir });
    return expect(result).resolves.toMatchObject({ code: 0 });
  });
});
