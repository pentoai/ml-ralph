/**
 * Runner-written log events: validated before appending, invalid ones shown
 * as errors, old invalid lines still readable, candidate_rejected before a lock
 */

import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateLogEvent } from "../../domain/validation/log-event.ts";
import { formatLogActivity } from "../../ui/widgets/log-event-formatter.ts";
import { appendValidatedEvent } from "./log-command.ts";
import { aggregateEvents, readLogFile } from "./log-parser.ts";
import { RalphRunner, type StreamEvent } from "./runner.ts";

let dir: string;
const logPath = () => join(dir, ".ml-ralph/log.jsonl");
const readLines = async () =>
  (await Bun.file(logPath()).text()).trim().split("\n").filter(Boolean);

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "ml-ralph-runner-log-"));
  await mkdir(join(dir, ".ml-ralph"), { recursive: true });
  await Bun.write(logPath(), "");
  await Bun.write(join(dir, ".ml-ralph/RALPH.md"), "# ralph");
  await Bun.write(
    join(dir, ".ml-ralph/prd.json"),
    JSON.stringify({ project: "p", status: "draft" }),
  );
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

class FakeRunner extends RalphRunner {
  prompts: string[] = [];
  constructor(
    config: ConstructorParameters<typeof RalphRunner>[0],
    private body: (i: number) => string,
  ) {
    super(config);
  }
  protected override async runIteration(prompt: string): Promise<string> {
    this.prompts.push(prompt);
    return this.body(this.getCurrentIteration());
  }
  emit(event: Record<string, unknown>): Promise<void> {
    const append = (
      this as unknown as {
        appendLogEvent: (e: Record<string, unknown>) => Promise<void>;
      }
    ).appendLogEvent.bind(this);
    return append(event);
  }
}

describe("invalid runner events", () => {
  test("appendValidatedEvent appends a valid event and nothing for an invalid one", async () => {
    const stderr = spyOn(process.stderr, "write").mockImplementation(
      () => true,
    );
    try {
      const seen: string[] = [];
      expect(
        await appendValidatedEvent(dir, {
          type: "phase",
          phase: "EXECUTE",
          summary: "s",
        }),
      ).toBe(true);
      expect(
        await appendValidatedEvent(
          dir,
          { type: "phase", phase: "NOPE", summary: "s" },
          (i) => seen.push(i.message),
        ),
      ).toBe(false);
      expect(await readLines()).toHaveLength(1);
      expect(seen[0]).toContain("phase");
      expect(seen[0]).toContain("not logged");
      expect(stderr).not.toHaveBeenCalled(); // the callback reports it
      expect(
        await appendValidatedEvent(dir, {
          type: "phase",
          phase: "NOPE",
          summary: "s",
        }),
      ).toBe(false);
      expect(stderr.mock.calls.map((c) => String(c[0])).join("")).toContain(
        "Invalid runner phase event",
      );
    } finally {
      stderr.mockRestore();
    }
  });

  test("the runner does not append an invalid event; it writes stderr and an error line", async () => {
    const stderr = spyOn(process.stderr, "write").mockImplementation(
      () => true,
    );
    try {
      const output: StreamEvent[] = [];
      const runner = new FakeRunner(
        { projectPath: dir, onOutput: (e) => output.push(e) },
        () => "",
      );
      await runner.emit({ type: "holdout_access", tool: "Bash" }); // iteration missing
      await runner.emit({ type: "holdout_access", tool: "Bash", iteration: 2 });
      const lines = await readLines();
      expect(lines).toHaveLength(1);
      expect(JSON.parse(lines[0] as string).iteration).toBe(2);
      const errors = output.filter((e) => e.type === "error");
      expect(errors).toHaveLength(1);
      expect(errors[0]?.content).toContain("iteration");
      expect(errors[0]?.isError).toBe(true);
      expect(stderr.mock.calls.map((c) => String(c[0])).join("")).toContain(
        "iteration",
      );
    } finally {
      stderr.mockRestore();
    }
  });

  test("a log with runner events that fail the schemas still reads and aggregates", async () => {
    const bad = [
      { type: "eval", eval_id: 7, status: "weird" },
      { type: "promotion", verdict: "maybe" },
      { type: "verifier_verdict" },
      { type: "run_complete", search_score: "high" },
      { type: "completion_blocked", reason: "gone" },
      { type: "contract_relocked", changes: "none" },
      { type: "overfitting" },
      { type: "phase", phase: "UNDERSTAND", summary: "ok" },
    ];
    for (const e of bad) {
      expect(validateLogEvent(e.type, e).valid).toBe(e.type === "phase");
    }
    await Bun.write(
      logPath(),
      `${bad.map((e) => JSON.stringify({ ts: "2026-01-01T00:00:00Z", ...e })).join("\n")}\n`,
    );
    const events = await readLogFile(dir);
    expect(events).toHaveLength(bad.length);
    expect(() => aggregateEvents(events)).not.toThrow();
    events.forEach((e, i) => {
      expect(() => formatLogActivity(e, i)).not.toThrow();
    });
  });
});

describe("candidate before the eval contract is locked", () => {
  test("logs candidate_rejected eval_not_locked and tells only the agent's next prompt", async () => {
    const output: StreamEvent[] = [];
    const errors: string[] = [];
    const runner = new FakeRunner(
      {
        projectPath: dir,
        maxIterations: 2,
        onOutput: (e) => output.push(e),
        onError: (e) => errors.push(e.message),
      },
      (i) =>
        i === 1
          ? '<iteration_complete> <candidate_complete eval_id="eval-x">'
          : "<iteration_complete>",
    );
    await runner.start();
    expect(errors).toEqual([]);
    const rejected = (await readLines())
      .map((l) => JSON.parse(l))
      .filter((e) => e.type === "candidate_rejected");
    expect(rejected).toHaveLength(1);
    expect(rejected[0]).toMatchObject({
      reason: "eval_not_locked",
      eval_id: "eval-x",
    });
    expect(validateLogEvent("candidate_rejected", rejected[0]).valid).toBe(
      true,
    );
    expect(runner.prompts[0]).not.toContain("eval_not_locked");
    expect(runner.prompts[1]).toContain("eval_not_locked");
    expect(output.filter((e) => e.type === "error")).toEqual([]);
  });
});
