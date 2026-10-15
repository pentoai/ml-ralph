/**
 * Tests for runner stream-json parsing (pure functions, never spawns claude)
 */

import { describe, expect, test } from "bun:test";
import { __testing } from "./runner.ts";

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
