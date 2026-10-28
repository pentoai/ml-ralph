/**
 * Tests for runner stream-json parsing (pure functions, never spawns claude)
 */

import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import {
  appendFile,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { lockEvalContract, readEvalLock } from "./eval-lock.ts";
import type { HoldoutResult } from "./holdout.ts";
import { BASELINE_PATH, type PromotionDeps } from "./promotion.ts";
import {
  __testing,
  type CompletionDeps,
  RalphRunner,
  type RunCompleteReason,
  type StreamEvent,
} from "./runner.ts";
import type { VerifyCandidateOptions } from "./verifier.ts";

const { parseStreamEvent, parseStreamLine } = __testing;

const assistant = (content: unknown[]) => ({
  type: "assistant",
  message: { role: "assistant", content },
  session_id: "s1",
});

const toolResult = (isError?: boolean) => ({
  type: "user",
  message: {
    role: "user",
    content: [
      {
        tool_use_id: "toolu_1",
        type: "tool_result",
        content: "output",
        ...(isError === undefined ? {} : { is_error: isError }),
      },
    ],
  },
  session_id: "s1",
});

describe("parseStreamEvent: assistant text", () => {
  test("emits a text event", () => {
    const { outputs } = parseStreamEvent(
      assistant([{ type: "text", text: "Hello" }]),
      null,
    );
    expect(outputs).toEqual([{ type: "text", content: "Hello" }]);
  });

  test("skips empty text blocks", () => {
    const { outputs } = parseStreamEvent(
      assistant([{ type: "text", text: "" }]),
      null,
    );
    expect(outputs).toEqual([]);
  });

  test("emits one event per block, in order", () => {
    const { outputs } = parseStreamEvent(
      assistant([
        { type: "text", text: "Reading" },
        { type: "tool_use", id: "t", name: "Read", input: { file_path: "/a" } },
      ]),
      null,
    );
    expect(outputs.map((o) => o.type)).toEqual(["text", "tool_call"]);
  });

  test("handles a missing message or content", () => {
    expect(parseStreamEvent({ type: "assistant" }, null).outputs).toEqual([]);
    expect(
      parseStreamEvent({ type: "assistant", message: {} }, null).outputs,
    ).toEqual([]);
  });
});

describe("parseStreamEvent: tool_use", () => {
  const call = (name: string, input: Record<string, unknown>) =>
    parseStreamEvent(
      assistant([{ type: "tool_use", id: "t", name, input }]),
      null,
    );

  test("Read uses file_path as description and keeps toolInput", () => {
    const { outputs, lastToolCall } = call("Read", {
      file_path: "/path/to/file",
      limit: 10,
    });
    expect(outputs).toEqual([
      {
        type: "tool_call",
        content: "/path/to/file",
        toolName: "Read",
        toolInput: { file_path: "/path/to/file", limit: 10 },
        agentName: undefined,
        teamEvent: undefined,
      },
    ]);
    expect(lastToolCall).toEqual({
      name: "Read",
      input: { file_path: "/path/to/file", limit: 10 },
    });
  });

  test("Write and Edit use file_path", () => {
    expect(call("Write", { file_path: "/w" }).outputs[0]?.content).toBe("/w");
    expect(call("Edit", { file_path: "/e" }).outputs[0]?.content).toBe("/e");
  });

  test("Glob and Grep use pattern", () => {
    expect(call("Glob", { pattern: "**/*.ts" }).outputs[0]?.content).toBe(
      "**/*.ts",
    );
    expect(call("Grep", { pattern: "foo" }).outputs[0]?.content).toBe("foo");
  });

  test("Bash prefers description, else truncates command to 50 chars", () => {
    expect(
      call("Bash", { command: "ls", description: "List files" }).outputs[0]
        ?.content,
    ).toBe("List files");
    const long = "x".repeat(80);
    expect(call("Bash", { command: long }).outputs[0]?.content).toBe(
      "x".repeat(50),
    );
    expect(call("Bash", {}).outputs[0]?.content).toBe("");
  });

  test("unknown tools get an empty description", () => {
    const { outputs } = call("WebFetch", { url: "https://example.com" });
    expect(outputs[0]).toMatchObject({
      type: "tool_call",
      content: "",
      toolName: "WebFetch",
    });
  });

  test("TeamCreate", () => {
    expect(call("TeamCreate", { team_name: "alpha" }).outputs[0]).toMatchObject(
      {
        content: "alpha",
        agentName: "lead",
        teamEvent: "team_create",
      },
    );
    expect(call("TeamCreate", {}).outputs[0]?.content).toBe("team");
  });

  test("Task with team_name is a teammate spawn", () => {
    expect(
      call("Task", {
        team_name: "alpha",
        name: "researcher",
        description: "Try lightgbm",
      }).outputs[0],
    ).toMatchObject({
      content: "Try lightgbm",
      agentName: "researcher",
      teamEvent: "teammate_spawn",
    });
    expect(call("Task", { team_name: "alpha" }).outputs[0]?.agentName).toBe(
      "teammate",
    );
  });

  test("Task without team_name is a plain tool call", () => {
    expect(
      call("Task", { description: "subagent" }).outputs[0]?.teamEvent,
    ).toBeUndefined();
  });

  test("SendMessage, TaskUpdate and TaskCreate", () => {
    expect(
      call("SendMessage", { recipient: "bob", summary: "hi" }).outputs[0],
    ).toMatchObject({
      content: "hi",
      agentName: "bob",
      teamEvent: "teammate_message",
    });
    expect(
      call("SendMessage", { content: "y".repeat(80) }).outputs[0],
    ).toMatchObject({ content: "y".repeat(50), agentName: "teammate" });
    expect(call("TaskUpdate", { status: "done" }).outputs[0]).toMatchObject({
      content: "done",
      agentName: "lead",
      teamEvent: "task_update",
    });
    expect(call("TaskCreate", { subject: "New" }).outputs[0]).toMatchObject({
      content: "New",
      agentName: "lead",
      teamEvent: "task_update",
    });
  });
});

describe("parseStreamEvent: tool_result", () => {
  test("success result", () => {
    const { outputs } = parseStreamEvent(toolResult(false), null);
    expect(outputs).toEqual([
      {
        type: "tool_result",
        content: "success",
        isError: false,
        agentName: undefined,
        teamEvent: undefined,
      },
    ]);
  });

  test("error result", () => {
    const { outputs } = parseStreamEvent(toolResult(true), null);
    expect(outputs[0]).toMatchObject({
      type: "tool_result",
      content: "failed",
      isError: true,
    });
  });

  test("missing is_error is treated as success", () => {
    const { outputs } = parseStreamEvent(toolResult(), null);
    expect(outputs[0]).toMatchObject({ content: "success" });
    expect(outputs[0]?.isError).toBeUndefined();
  });

  test("ignores non tool_result user content", () => {
    const { outputs } = parseStreamEvent(
      {
        type: "user",
        message: { role: "user", content: [{ type: "text", text: "hi" }] },
      },
      null,
    );
    expect(outputs).toEqual([]);
  });

  test("inherits team context from the preceding tool call", () => {
    const pairs: Array<[string, Record<string, unknown>, object]> = [
      [
        "Task",
        { team_name: "t", name: "bob" },
        { agentName: "bob", teamEvent: "teammate_message" },
      ],
      ["TeamCreate", {}, { agentName: "lead", teamEvent: "team_create" }],
      [
        "SendMessage",
        { recipient: "amy" },
        { agentName: "amy", teamEvent: "teammate_message" },
      ],
      ["TaskUpdate", {}, { agentName: "lead", teamEvent: "task_update" }],
      ["TaskCreate", {}, { agentName: "lead", teamEvent: "task_update" }],
    ];
    for (const [name, input, expected] of pairs) {
      const { outputs } = parseStreamEvent(toolResult(false), { name, input });
      expect(outputs[0]).toMatchObject(expected);
    }
  });

  test("non-team tool calls add no team context", () => {
    const { outputs } = parseStreamEvent(toolResult(false), {
      name: "Read",
      input: { file_path: "/a" },
    });
    expect(outputs[0]?.agentName).toBeUndefined();
    expect(outputs[0]?.teamEvent).toBeUndefined();
  });

  test("tool_use followed by tool_result pairs through lastToolCall", () => {
    const first = parseStreamEvent(
      assistant([
        {
          type: "tool_use",
          id: "t",
          name: "SendMessage",
          input: { recipient: "amy" },
        },
      ]),
      null,
    );
    const second = parseStreamEvent(toolResult(false), first.lastToolCall);
    expect(second.outputs[0]).toMatchObject({
      agentName: "amy",
      teamEvent: "teammate_message",
    });
  });
});

describe("parseStreamEvent: other event types", () => {
  test("system, stream_event and result emit nothing", () => {
    for (const event of [
      { type: "system", subtype: "init", session_id: "s1" },
      {
        type: "stream_event",
        event: {
          type: "content_block_delta",
          index: 0,
          delta: { type: "text_delta", text: "Hi" },
        },
      },
      { type: "result", subtype: "success", result: "done" },
      { type: "unknown" },
      {},
    ]) {
      expect(parseStreamEvent(event, null).outputs).toEqual([]);
    }
  });

  test("preserves lastToolCall when nothing changes it", () => {
    const prev = { name: "Read", input: {} };
    expect(parseStreamEvent({ type: "system" }, prev).lastToolCall).toBe(prev);
  });
});

describe("parseStreamLine", () => {
  test("blank lines emit nothing", () => {
    expect(parseStreamLine("", null)).toEqual({
      outputs: [],
      lastToolCall: null,
    });
    expect(parseStreamLine("   \t", null).outputs).toEqual([]);
  });

  test("parses a JSON assistant text line", () => {
    const line = JSON.stringify(assistant([{ type: "text", text: "Hi" }]));
    expect(parseStreamLine(line, null).outputs).toEqual([
      { type: "text", content: "Hi" },
    ]);
  });

  test("parses a JSON tool_use line and tracks the tool call", () => {
    const line = JSON.stringify(
      assistant([
        { type: "tool_use", id: "t", name: "Bash", input: { command: "ls" } },
      ]),
    );
    const parsed = parseStreamLine(line, null);
    expect(parsed.outputs[0]).toMatchObject({
      type: "tool_call",
      toolName: "Bash",
      content: "ls",
    });
    expect(parsed.lastToolCall?.name).toBe("Bash");
  });

  test("parses a JSON tool_result error line", () => {
    const parsed = parseStreamLine(JSON.stringify(toolResult(true)), null);
    expect(parsed.outputs[0]).toMatchObject({
      type: "tool_result",
      content: "failed",
      isError: true,
    });
  });

  test("non-JSON lines are surfaced as raw text", () => {
    const parsed = parseStreamLine("Error: something broke", null);
    expect(parsed.outputs).toEqual([
      { type: "text", content: "Error: something broke" },
    ]);
  });

  test("truncated JSON is surfaced as raw text", () => {
    const parsed = parseStreamLine('{"type":"assistant","message":{', null);
    expect(parsed.outputs).toHaveLength(1);
    expect(parsed.outputs[0]?.type).toBe("text");
  });

  test("JSON that is not an object is surfaced as text", () => {
    expect(parseStreamLine("42", null).outputs).toEqual([
      { type: "text", content: "42" },
    ]);
    expect(parseStreamLine("null", null).outputs).toEqual([
      { type: "text", content: "null" },
    ]);
    expect(parseStreamLine("[1,2]", null).outputs).toEqual([
      { type: "text", content: "[1,2]" },
    ]);
  });

  test("valid JSON with an unexpected shape falls back to raw text", () => {
    const lines = [
      JSON.stringify(assistant([{ type: "tool_use", id: "t", name: "Bash" }])),
      JSON.stringify(assistant([null])),
      JSON.stringify({ type: "assistant", message: { content: 5 } }),
      JSON.stringify({ type: "user", message: { content: [null] } }),
    ];
    for (const line of lines) {
      const parsed = parseStreamLine(line, null);
      expect(parsed.outputs).toEqual([{ type: "text", content: line }]);
    }
  });

  test("string content does not throw and emits nothing", () => {
    for (const type of ["assistant", "user"]) {
      const line = JSON.stringify({ type, message: { content: "oops" } });
      expect(parseStreamLine(line, null).outputs).toEqual([]);
    }
  });

  test("unexpected shape keeps the previous lastToolCall", () => {
    const prev = { name: "Read", input: { file_path: "/a" } };
    const line = JSON.stringify(assistant([null]));
    expect(parseStreamLine(line, prev).lastToolCall).toBe(prev);
  });

  test("result lines return the final result text and emit nothing", () => {
    const line = JSON.stringify({
      type: "result",
      subtype: "success",
      is_error: false,
      result: "All done <iteration_complete>",
    });
    const parsed = parseStreamLine(line, null);
    expect(parsed.outputs).toEqual([]);
    expect(parsed.result).toBe("All done <iteration_complete>");
  });

  test("error result lines still carry the result field (empty if absent)", () => {
    const line = JSON.stringify({
      type: "result",
      subtype: "error",
      is_error: true,
      error: "Error message here",
    });
    const parsed = parseStreamLine(line, null);
    expect(parsed.outputs).toEqual([]);
    expect(parsed.result).toBe("");
  });

  test("non-result lines have no result", () => {
    const line = JSON.stringify(assistant([{ type: "text", text: "x" }]));
    expect(parseStreamLine(line, null).result).toBeUndefined();
  });

  test("a full tool-use conversation round-trips line by line", () => {
    const lines = [
      JSON.stringify({ type: "system", subtype: "init", session_id: "s1" }),
      JSON.stringify(assistant([{ type: "text", text: "Listing" }])),
      JSON.stringify(
        assistant([
          {
            type: "tool_use",
            id: "toolu_1",
            name: "Bash",
            input: { command: "ls", description: "List files" },
          },
        ]),
      ),
      JSON.stringify(toolResult(false)),
      "not json",
      JSON.stringify({ type: "result", subtype: "success", result: "fin" }),
    ];
    let last: ReturnType<typeof parseStreamLine>["lastToolCall"] = null;
    let result = "";
    const outputs: string[] = [];
    for (const line of lines) {
      const parsed = parseStreamLine(line, last);
      last = parsed.lastToolCall;
      result = parsed.result ?? result;
      outputs.push(...parsed.outputs.map((o) => o.type));
    }
    expect(outputs).toEqual(["text", "tool_call", "tool_result", "text"]);
    expect(result).toBe("fin");
  });
});

describe("RalphRunner completion gate", () => {
  const CONTRACT = {
    primary_metric: "auc",
    direction: "max",
    search_split: "cv_5fold",
    seeds: [0, 1],
    protocol: "5-fold CV",
    success_threshold: 0.9,
    holdout_gap_threshold: 0.02,
    eval_timeout_seconds: 600,
    baseline_score: 0.8,
  };
  let dir: string;
  let lockFiles: NonNullable<Awaited<ReturnType<typeof readEvalLock>>>["files"];
  let evalCounter = 0;
  /** Answers of the verifier, in call order: the promotion check, then the completion check */
  let verifierScript: Array<"approve" | "reject" | "error" | "throw">;
  let verifierCalls: VerifyCandidateOptions[];
  let holdoutCalls: string[];
  let holdoutAnswer: (id: string) => Promise<HoldoutResult>;
  let holdoutConfigured: boolean;

  const holdoutOk = (
    id: string,
    holdoutScore: number,
    blocked = false,
  ): HoldoutResult => ({
    ok: true,
    evalId: id,
    searchScore: 0.91,
    holdoutScore,
    holdoutGap: 0.91 - holdoutScore,
    threshold: 0.02,
    blocked,
    alreadyScored: false,
  });

  const promotionDeps = (): Partial<PromotionDeps> => ({
    gitHead: async () => ({ ok: true, ref: "c".repeat(40) }),
    verify: async (options) => {
      verifierCalls.push(options);
      const answer = verifierScript.shift() ?? "approve";
      if (answer === "throw") throw new Error("claude exploded");
      const id = `v-${verifierCalls.length}`;
      const common = {
        id,
        checks: {
          leakage: "pass",
          protocol_change: "pass",
          rubrics: "pass",
        } as const,
        outputPath: `.ml-ralph/verifier/${id}.json`,
      };
      if (answer === "error") {
        return {
          ...common,
          verdict: "reject",
          reason: "verifier_error",
          error: "claude timed out",
          feedback: "Verifier verdict: reject - verifier_error",
        };
      }
      const approve = answer === "approve";
      return {
        ...common,
        verdict: approve ? "approve" : "reject",
        reason: approve ? "looks fine" : "test labels used in training",
        feedback: `Verifier verdict: ${answer}`,
      };
    },
  });

  const completionDeps = (): Partial<CompletionDeps> => ({
    scoreHoldout: async (id) => {
      holdoutCalls.push(id);
      return holdoutAnswer(id);
    },
    readHoldoutPath: async () =>
      holdoutConfigured
        ? { ok: true, path: "/sealed/h.csv", realPath: "/sealed/h.csv" }
        : {
            ok: false,
            error: "config.json has no holdout_path",
            notConfigured: true,
          },
  });

  async function appendLog(event: Record<string, unknown>) {
    await appendFile(
      join(dir, ".ml-ralph/log.jsonl"),
      `${JSON.stringify({ ts: new Date().toISOString(), ...event })}\n`,
    );
  }

  /** What `ml-ralph eval` leaves behind, for an eval with the given search mean */
  async function writeEval(mean: number): Promise<string> {
    const id = `eval-${++evalCounter}`;
    const candidate = "submissions/h001.csv";
    await mkdir(join(dir, ".ml-ralph/evals", id), { recursive: true });
    await Bun.write(
      join(dir, ".ml-ralph/evals", id, "metrics.json"),
      JSON.stringify({
        eval_id: id,
        contract_hash: lockFiles["contract.json"],
        evaluate_hash: lockFiles["evaluate.py"],
        candidate,
        split: "cv_5fold",
        created_at: new Date().toISOString(),
        status: "ok",
        scores: [{ seed: 0, score: mean }],
        mean,
        std: 0.001,
      }),
    );
    await appendLog({
      type: "eval",
      eval_id: id,
      status: "ok",
      candidate,
      mean,
    });
    return id;
  }

  async function logEvents(type: string) {
    const text = await Bun.file(join(dir, ".ml-ralph/log.jsonl")).text();
    return text
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l))
      .filter((e) => e.type === type);
  }

  class FakeRunner extends RalphRunner {
    prompts: string[] = [];
    constructor(
      config: ConstructorParameters<typeof RalphRunner>[0],
      private body: (i: number) => Promise<string>,
    ) {
      super(config);
    }
    protected override async runIteration(prompt: string): Promise<string> {
      this.prompts.push(prompt);
      return this.body(this.getCurrentIteration());
    }
  }

  /** Each iteration hands in a new eval with the next mean in `means`; later iterations hand in nothing */
  async function run(means: number[], maxIterations = 3) {
    const completions: RunCompleteReason[] = [];
    const errors: string[] = [];
    const output: StreamEvent[] = [];
    const ids: string[] = [];
    const runner = new FakeRunner(
      {
        projectPath: dir,
        maxIterations,
        promotionDeps: promotionDeps(),
        completionDeps: completionDeps(),
        onComplete: (r) => completions.push(r),
        onError: (e) => errors.push(e.message),
        onOutput: (e) => output.push(e),
      },
      async (i) => {
        const mean = means[i - 1];
        if (mean === undefined) return "<iteration_complete>";
        const id = await writeEval(mean);
        ids.push(id);
        return `<iteration_complete> <candidate_complete eval_id="${id}">`;
      },
    );
    await runner.start();
    expect(errors).toEqual([]);
    return { runner, completions, output, ids };
  }

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "ml-ralph-completion-"));
    await mkdir(join(dir, ".ml-ralph/eval"), { recursive: true });
    await Bun.write(join(dir, ".ml-ralph/RALPH.md"), "# ralph");
    await Bun.write(
      join(dir, ".ml-ralph/prd.json"),
      JSON.stringify({ project: "p", status: "approved" }),
    );
    await Bun.write(
      join(dir, ".ml-ralph/eval/contract.json"),
      JSON.stringify(CONTRACT),
    );
    await Bun.write(join(dir, ".ml-ralph/eval/evaluate.py"), "print('x')\n");
    expect((await lockEvalContract(dir)).ok).toBe(true);
    lockFiles = (await readEvalLock(dir))!.files;
    await Bun.write(
      join(dir, BASELINE_PATH),
      JSON.stringify({ ref: "b".repeat(40), recorded_at: "2000-01-01" }),
    );
    await Bun.write(join(dir, ".ml-ralph/log.jsonl"), "");
    await appendLog({
      type: "hypothesis",
      id: "H-001",
      claim: "claim",
      expected_delta: 0.1,
      rubrics: ["no test labels used"],
      kill_criterion: "no gain",
    });
    verifierScript = [];
    verifierCalls = [];
    holdoutCalls = [];
    holdoutConfigured = true;
    holdoutAnswer = async (id) => holdoutOk(id, 0.905);
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test("promotion and completion verifier calls report an invalid verdict event as a TUI error line", async () => {
    const stderr = spyOn(process.stderr, "write").mockImplementation(
      () => true,
    );
    try {
      const { output } = await run([0.91]);
      expect(verifierCalls).toHaveLength(2);
      for (const call of verifierCalls) {
        expect(call.onInvalidEvent).toBeFunction();
      }
      verifierCalls[1]?.onInvalidEvent?.({
        type: "verifier_verdict",
        message: "Invalid runner verifier_verdict event, not logged: id",
      });
      const errors = output.filter((e) => e.type === "error");
      expect(errors).toHaveLength(1);
      expect(errors[0]?.content).toContain("verifier_verdict");
      expect(stderr.mock.calls.map((c) => String(c[0])).join("")).toContain(
        "verifier_verdict",
      );
    } finally {
      stderr.mockRestore();
    }
  });

  test("approve: the verifier runs, then the holdout once, and the run ends with run_complete", async () => {
    const { runner, completions, ids } = await run([0.91]);
    expect(verifierCalls).toHaveLength(2); // promotion, then completion
    expect(verifierCalls[1]?.baselineRef).toBe("b".repeat(40));
    expect(holdoutCalls).toEqual(ids);
    expect(completions).toEqual(["completed"]);
    expect(runner.prompts).toHaveLength(1);
    const [event] = await logEvents("run_complete");
    expect(event).toMatchObject({
      eval_id: ids[0],
      search_score: 0.91,
      holdout_score: 0.905,
      verifier_verdict: "approve",
      verifier_id: "v-2",
    });
    expect(await logEvents("completion_rejected")).toEqual([]);
  });

  test("a promotion below the success criteria runs neither the verifier again nor the holdout", async () => {
    const { completions } = await run([0.85], 2);
    expect(verifierCalls).toHaveLength(1);
    expect(holdoutCalls).toEqual([]);
    expect(completions).toEqual(["max_iterations"]);
  });

  test("verifier reject: logged, only the verdict and one line reach the next prompt, holdout untouched", async () => {
    verifierScript = ["approve", "reject"];
    const { runner, completions } = await run([0.91]);
    expect(holdoutCalls).toEqual([]);
    expect(completions).toEqual(["max_iterations"]);
    expect(runner.prompts).toHaveLength(3);
    const [event] = await logEvents("completion_rejected");
    expect(event).toMatchObject({ reason: "verifier_rejected" });
    expect(runner.prompts[1]).toContain("rejected (verifier_rejected)");
    expect(runner.prompts[1]).toContain("test labels used in training");
    expect(runner.prompts[2]).not.toContain("rejected (verifier_rejected)");
    expect(await logEvents("run_complete")).toEqual([]);
  });

  test("verifier error or throw: completion_blocked with the error, run continues", async () => {
    // The second candidate beats the first by more than the seed noise, so it is promoted too
    verifierScript = ["approve", "error", "approve", "throw"];
    const { completions } = await run([0.91, 0.95], 3);
    expect(holdoutCalls).toEqual([]);
    expect(completions).toEqual(["max_iterations"]);
    const blocked = await logEvents("completion_blocked");
    expect(blocked.map((e) => e.reason)).toEqual([
      "verifier_error",
      "verifier_error",
    ]);
    expect(blocked[0]?.error).toContain("claude timed out");
    expect(blocked[1]?.error).toContain("claude exploded");
  });

  test("holdout_failed: the holdout misses the success criteria", async () => {
    holdoutAnswer = async (id) => holdoutOk(id, 0.85);
    const { runner, completions } = await run([0.91]);
    expect(completions).toEqual(["max_iterations"]);
    const [event] = await logEvents("completion_rejected");
    expect(event).toMatchObject({ reason: "holdout_failed" });
    expect(runner.prompts[1]).toContain("rejected (holdout_failed)");
    // The agent never learns a holdout number
    expect(runner.prompts[1]).not.toContain("0.85");
  });

  test("overfitting_gap: success on holdout but a gap above the threshold", async () => {
    holdoutAnswer = async (id) => holdoutOk(id, 0.905, true);
    const { runner, completions } = await run([0.91]);
    expect(completions).toEqual(["max_iterations"]);
    const [event] = await logEvents("completion_rejected");
    expect(event).toMatchObject({ reason: "overfitting_gap" });
    expect(runner.prompts[1]).toContain("rejected (overfitting_gap)");
  });

  test("a rejected completion leaves no holdout score or gap in any project file", async () => {
    // A distinctive score and gap that no other project file would contain
    holdoutAnswer = async (id) => ({
      ...holdoutOk(id, 0.80123, true),
      holdoutGap: 0.10987,
    });
    const { runner } = await run([0.91]);
    expect(await logEvents("completion_rejected")).toHaveLength(1);

    const entries = await readdir(dir, {
      recursive: true,
      withFileTypes: true,
    });
    const files = entries
      .filter((e) => e.isFile())
      .map((e) => join(e.parentPath, e.name));
    expect(files.length).toBeGreaterThan(3);
    for (const file of files) {
      const text = await readFile(file, "utf8");
      for (const secret of [
        "0.80123",
        "0.10987",
        "holdout_score",
        'holdout_gap"',
      ]) {
        expect(`${file}: ${text.includes(secret)}`).toBe(`${file}: false`);
      }
    }
    for (const prompt of runner.prompts) {
      expect(prompt).not.toContain("0.80123");
      expect(prompt).not.toContain("0.10987");
    }
  });

  test("scoreHoldout throwing or failing blocks completion and the run continues", async () => {
    holdoutAnswer = async () => {
      throw new Error("holdout file unreadable");
    };
    const { completions } = await run([0.91], 2);
    expect(completions).toEqual(["max_iterations"]);
    const [event] = await logEvents("completion_blocked");
    expect(event).toMatchObject({ reason: "holdout_error" });
    expect(event.error).toContain("holdout file unreadable");
  });

  test("no holdout_path: completion_blocked once per promotion and the TUI sees the line; a path added mid-run is used next", async () => {
    holdoutConfigured = false;
    const { completions, output, ids } = await runWithPathAddedAfterFirst();
    const blocked = await logEvents("completion_blocked");
    expect(blocked).toHaveLength(1);
    expect(blocked[0]).toMatchObject({
      eval_id: ids[0],
      reason: "holdout_not_configured",
    });
    // The TUI renders onOutput text events as agent output
    expect(
      output.filter(
        (e) =>
          e.type === "text" && e.content.includes("holdout_not_configured"),
      ),
    ).toEqual([
      {
        type: "text",
        content: `Completion blocked for ${ids[0]}: holdout_not_configured (config.json has no holdout_path)`,
      },
    ]);
    // The promotion check ran for both evals; the completion verifier only once the path existed
    expect(verifierCalls).toHaveLength(3);
    expect(holdoutCalls).toEqual([ids[1] as string]);
    expect(completions).toEqual(["completed"]);
  });

  async function runWithPathAddedAfterFirst() {
    const completions: RunCompleteReason[] = [];
    const output: StreamEvent[] = [];
    const ids: string[] = [];
    const runner = new FakeRunner(
      {
        projectPath: dir,
        maxIterations: 3,
        promotionDeps: promotionDeps(),
        completionDeps: completionDeps(),
        onComplete: (r) => completions.push(r),
        onOutput: (e) => output.push(e),
      },
      async (i) => {
        if (i === 2) holdoutConfigured = true;
        const id = await writeEval(i === 1 ? 0.91 : 0.95);
        ids.push(id);
        return `<candidate_complete eval_id="${id}">`;
      },
    );
    await runner.start();
    return { completions, output, ids };
  }

  test("handing in the same eval_id again does not score the holdout again", async () => {
    holdoutAnswer = async (id) => holdoutOk(id, 0.85);
    const completions: RunCompleteReason[] = [];
    const ids: string[] = [];
    const runner = new FakeRunner(
      {
        projectPath: dir,
        maxIterations: 3,
        promotionDeps: promotionDeps(),
        completionDeps: completionDeps(),
        onComplete: (r) => completions.push(r),
      },
      async (i) => {
        if (i === 1) ids.push(await writeEval(0.91));
        return `<candidate_complete eval_id="${ids[0]}">`;
      },
    );
    await runner.start();
    expect(holdoutCalls).toEqual([ids[0] as string]);
    expect(completions).toEqual(["max_iterations"]);
  });

  test("scoreHoldout runs at most once per eval_id across two iterations", async () => {
    holdoutAnswer = async (id) => holdoutOk(id, id === "eval-1" ? 0.85 : 0.94);
    evalCounter = 0;
    const { completions, ids } = await run([0.91, 0.95]);
    expect(ids).toEqual(["eval-1", "eval-2"]);
    expect(holdoutCalls).toEqual(["eval-1", "eval-2"]);
    expect(completions).toEqual(["completed"]);
  });
});
