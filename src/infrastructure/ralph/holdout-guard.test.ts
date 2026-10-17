/**
 * Tests for the holdout access guard: fixture stream-json lines for the pure
 * parsing, and a stub `claude` executable for the kill and the run's end
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  findHoldoutToolUse,
  holdoutNeedles,
  loadHoldoutNeedles,
} from "./holdout-guard.ts";
import {
  __testing,
  RalphRunner,
  type RunCompleteReason,
  type StreamEvent,
} from "./runner.ts";

const { parseStreamLine } = __testing;

const HOLDOUT = "/data/sealed/holdout.parquet";
const needles = holdoutNeedles(HOLDOUT);

const toolUse = (name: string, input: unknown) => ({
  type: "tool_use",
  id: "toolu_1",
  name,
  input,
});
const assistantLine = (...blocks: unknown[]) =>
  JSON.stringify({
    type: "assistant",
    message: { role: "assistant", content: blocks },
    session_id: "s1",
  });

describe("parseStreamLine with a holdout configured", () => {
  const flagged = (line: string, n = needles) =>
    parseStreamLine(line, null, n).holdoutAccess;

  test("Read of the holdout file is flagged with the tool name", () => {
    const line = assistantLine(toolUse("Read", { file_path: HOLDOUT }));
    expect(flagged(line)).toEqual({ toolName: "Read" });
  });

  test("Bash cat of the holdout file is flagged", () => {
    const line = assistantLine(
      toolUse("Bash", { command: `cat ${HOLDOUT} | head`, description: "x" }),
    );
    expect(flagged(line)).toEqual({ toolName: "Bash" });
  });

  test("Glob inside the holdout directory is flagged", () => {
    const line = assistantLine(
      toolUse("Glob", {
        pattern: "*.parquet",
        path: "/data/sealed/holdout.parquet",
      }),
    );
    expect(flagged(line)).toEqual({ toolName: "Glob" });
  });

  test("an unrelated tool call is not flagged and parses as before", () => {
    const line = assistantLine(
      toolUse("Read", { file_path: "/home/me/project/train.py" }),
    );
    const parsed = parseStreamLine(line, null, needles);
    expect(parsed.holdoutAccess).toBeUndefined();
    expect(parsed.outputs[0]).toMatchObject({
      type: "tool_call",
      toolName: "Read",
      content: "/home/me/project/train.py",
    });
    expect(parsed).toEqual(parseStreamLine(line, null));
  });

  test("a flagged call is still emitted as a tool_call and tracked", () => {
    const line = assistantLine(toolUse("Read", { file_path: HOLDOUT }));
    const parsed = parseStreamLine(line, null, needles);
    expect(parsed.outputs[0]).toMatchObject({
      type: "tool_call",
      toolName: "Read",
    });
    expect(parsed.lastToolCall?.name).toBe("Read");
  });

  test("the path in nested input values is found", () => {
    const line = assistantLine(
      toolUse("Task", { prompt: "look", args: [{ paths: [HOLDOUT] }] }),
    );
    expect(flagged(line)).toEqual({ toolName: "Task" });
  });

  test("a mention in text, a tool_result or a system event is not a tool call", () => {
    expect(
      flagged(
        assistantLine({ type: "text", text: `I will not read ${HOLDOUT}` }),
      ),
    ).toBeUndefined();
    expect(
      flagged(
        JSON.stringify({
          type: "user",
          message: {
            content: [
              { type: "tool_result", tool_use_id: "t", content: HOLDOUT },
            ],
          },
        }),
      ),
    ).toBeUndefined();
    expect(
      flagged(JSON.stringify({ type: "system", cwd: HOLDOUT })),
    ).toBeUndefined();
    expect(flagged("not json " + HOLDOUT)).toBeUndefined();
  });

  test("the first matching block of several is the one named", () => {
    const line = assistantLine(
      toolUse("Read", { file_path: "/a" }),
      toolUse("Grep", { pattern: "x", path: HOLDOUT }),
      toolUse("Bash", { command: `ls ${HOLDOUT}` }),
    );
    expect(flagged(line)).toEqual({ toolName: "Grep" });
  });

  test("an odd event shape still flags a matching block and keeps the text fallback", () => {
    const line = assistantLine(null, toolUse("Read", { file_path: HOLDOUT }));
    const parsed = parseStreamLine(line, null, needles);
    expect(parsed.holdoutAccess).toEqual({ toolName: "Read" });
    expect(parsed.outputs).toEqual([{ type: "text", content: line }]);
  });

  test("a tool_use without a name is reported as unknown; one without input is skipped", () => {
    expect(
      findHoldoutToolUse(
        JSON.parse(assistantLine({ type: "tool_use", input: { p: HOLDOUT } })),
        needles,
      ),
    ).toEqual({ toolName: "unknown" });
    expect(
      findHoldoutToolUse(
        JSON.parse(assistantLine({ type: "tool_use", name: "Bash" })),
        needles,
      ),
    ).toBeNull();
  });

  test("a result line is still parsed alongside the guard", () => {
    const line = JSON.stringify({ type: "result", result: "done" });
    expect(parseStreamLine(line, null, needles).result).toBe("done");
  });
});

describe("parseStreamLine without a holdout", () => {
  test("nothing is flagged with no needles", () => {
    const line = assistantLine(toolUse("Read", { file_path: HOLDOUT }));
    expect(parseStreamLine(line, null, []).holdoutAccess).toBeUndefined();
    expect(parseStreamLine(line, null).holdoutAccess).toBeUndefined();
  });
});

describe("holdoutNeedles", () => {
  test("a trailing slash is dropped so the bare directory is caught", () => {
    const dirNeedles = holdoutNeedles("/data/sealed/");
    const line = assistantLine(toolUse("Bash", { command: "ls /data/sealed" }));
    expect(parseStreamLine(line, null, dirNeedles).holdoutAccess).toBeDefined();
  });

  test("the real path of a symlinked holdout counts too", () => {
    const both = holdoutNeedles("/links/h.parquet", "/data/real/h.parquet");
    for (const path of ["/links/h.parquet", "/data/real/h.parquet"]) {
      const line = assistantLine(toolUse("Read", { file_path: path }));
      expect(findHoldoutToolUse(JSON.parse(line), both)).not.toBeNull();
    }
  });

  test("a path with characters JSON escapes is still found in the serialized input", () => {
    const odd = holdoutNeedles('/data/with "quote"/h.csv');
    const line = assistantLine(
      toolUse("Read", { file_path: '/data/with "quote"/h.csv' }),
    );
    expect(findHoldoutToolUse(JSON.parse(line), odd)).not.toBeNull();
  });

  test("an empty or root-only path adds no needle", () => {
    expect(holdoutNeedles("", "/")).toEqual([]);
  });
});

describe("loadHoldoutNeedles and the runner", () => {
  let dir: string;
  let sealed: string;
  let configHome: string;
  let stubDir: string;
  const saved = { xdg: process.env.XDG_CONFIG_HOME, path: process.env.PATH };

  const setConfig = async (projects: Record<string, unknown>) => {
    await mkdir(join(configHome, "ml-ralph"), { recursive: true });
    await Bun.write(
      join(configHome, "ml-ralph/config.json"),
      JSON.stringify({ projects }),
    );
  };

  /**
   * Make `claude` print these stdout lines, then hang (as a long iteration would) or exit.
   * With `child`, it first starts a background process (like a Bash tool's script) and writes its pid.
   */
  const stubClaude = async (lines: string[], hang: boolean, child = false) => {
    await Bun.write(join(stubDir, "lines"), `${lines.join("\n")}\n`);
    await Bun.write(
      join(stubDir, "claude"),
      `#!/bin/sh
d="$(dirname "$0")"
${child ? `sh -c 'exec sleep 60' &\necho $! > "$d/child.pid.tmp" && mv "$d/child.pid.tmp" "$d/child.pid"` : ""}
cat "$d/lines"
${hang ? "exec sleep 60" : "exit 0"}
`,
    );
    await chmod(join(stubDir, "claude"), 0o755);
    process.env.PATH = `${stubDir}:${saved.path}`;
  };

  const run = async (maxIterations = 3) => {
    const completions: RunCompleteReason[] = [];
    const errors: string[] = [];
    const outputs: StreamEvent[] = [];
    const ends: number[] = [];
    const runner = new RalphRunner({
      projectPath: dir,
      maxIterations,
      onComplete: (r) => completions.push(r),
      onError: (e) => errors.push(e.message),
      onOutput: (e) => outputs.push(e),
      onIterationEnd: (i) => ends.push(i),
    });
    const started = Date.now();
    await runner.start();
    return {
      completions,
      errors,
      outputs,
      ends,
      elapsed: Date.now() - started,
    };
  };

  const waitForChildPid = async (): Promise<number> => {
    for (let i = 0; i < 200; i++) {
      const text = await Bun.file(join(stubDir, "child.pid"))
        .text()
        .catch(() => "");
      if (text.trim()) return Number(text.trim());
      await Bun.sleep(25);
    }
    throw new Error("the stub never started its child");
  };

  /** Dead, or a zombie waiting to be reaped by an init that may not exist in a container */
  const waitUntilDead = async (pid: number): Promise<boolean> => {
    for (let i = 0; i < 120; i++) {
      const stat = (await Bun.$`ps -o stat= -p ${pid}`.nothrow().text()).trim();
      if (stat === "" || stat.startsWith("Z")) return true;
      await Bun.sleep(25);
    }
    return false;
  };

  const logEvents = async () =>
    (await Bun.file(join(dir, ".ml-ralph/log.jsonl")).text())
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as Record<string, unknown>);

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "ml-ralph-guard-"));
    sealed = await mkdtemp(join(tmpdir(), "ml-ralph-guard-sealed-"));
    configHome = await mkdtemp(join(tmpdir(), "ml-ralph-guard-config-"));
    stubDir = await mkdtemp(join(tmpdir(), "ml-ralph-guard-stub-"));
    await Bun.write(join(dir, ".ml-ralph/RALPH.md"), "# instructions");
    await Bun.write(join(sealed, "holdout.csv"), "y\n1\n");
    process.env.XDG_CONFIG_HOME = configHome;
  });

  afterEach(async () => {
    for (const [key, value] of [
      ["XDG_CONFIG_HOME", saved.xdg],
      ["PATH", saved.path],
    ] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await Promise.all(
      [dir, sealed, configHome, stubDir].map((d) =>
        rm(d, { recursive: true, force: true }),
      ),
    );
  });

  test("loadHoldoutNeedles reads the configured path and its real path", async () => {
    const link = join(configHome, "link-to-holdout");
    await symlink(sealed, link);
    await setConfig({ [dir]: { holdout_path: link } });
    const found = await loadHoldoutNeedles(dir);
    expect(found).toContain(link);
    expect(
      found.some((n) => n.endsWith(sealed.split("/").pop() as string)),
    ).toBe(true);
  });

  test("loadHoldoutNeedles also covers the config file and its real path", async () => {
    const linkedHome = join(dir, "..", `xdg-link-${Date.now()}`);
    await symlink(configHome, linkedHome);
    try {
      process.env.XDG_CONFIG_HOME = linkedHome;
      await setConfig({ [dir]: { holdout_path: sealed } });
      const found = await loadHoldoutNeedles(dir);
      for (const config of [
        join(linkedHome, "ml-ralph/config.json"),
        join(configHome, "ml-ralph/config.json"),
      ]) {
        const line = assistantLine(
          toolUse("Bash", { command: `cat ${config}` }),
        );
        expect(parseStreamLine(line, null, found).holdoutAccess).toEqual({
          toolName: "Bash",
        });
      }
    } finally {
      await rm(linkedHome, { force: true });
    }
  });

  test("a project with no usable holdout does not guard the config file", async () => {
    await setConfig({ "/somewhere/else": { holdout_path: sealed } });
    expect(await loadHoldoutNeedles(dir)).toEqual([]);
  });

  test("loadHoldoutNeedles is empty without a config, an entry or a usable path", async () => {
    expect(await loadHoldoutNeedles(dir)).toEqual([]);
    await setConfig({ "/somewhere/else": { holdout_path: sealed } });
    expect(await loadHoldoutNeedles(dir)).toEqual([]);
    await setConfig({ [dir]: { holdout_path: join(dir, "inside") } });
    expect(await loadHoldoutNeedles(dir)).toEqual([]);
    await setConfig({ [dir]: { holdout_path: "relative/path" } });
    expect(await loadHoldoutNeedles(dir)).toEqual([]);
  });

  test("a tool call on the holdout kills claude and ends the run with holdout_access", async () => {
    await setConfig({ [dir]: { holdout_path: sealed } });
    await stubClaude(
      [
        JSON.stringify({ type: "system", subtype: "init" }),
        assistantLine(
          toolUse("Bash", { command: `cat ${join(sealed, "holdout.csv")}` }),
        ),
        assistantLine(toolUse("Read", { file_path: "/never/processed" })),
        JSON.stringify({ type: "result", result: "<iteration_complete>" }),
      ],
      true,
    );
    const { completions, errors, outputs, ends, elapsed } = await run();

    expect(errors).toEqual([]);
    expect(completions).toEqual(["holdout_access"]);
    expect(ends).toEqual([]);
    expect(elapsed).toBeLessThan(20_000);
    const calls = outputs.filter((o) => o.type === "tool_call");
    expect(calls.map((o) => o.toolName)).toEqual(["Bash"]);

    const events = await logEvents();
    const access = events.filter((e) => e.type === "holdout_access");
    expect(access).toHaveLength(1);
    expect(access[0]).toMatchObject({ tool: "Bash", iteration: 1 });
    expect(
      await Bun.file(join(dir, ".ml-ralph/log.jsonl")).text(),
    ).not.toContain(sealed);
  });

  test("reading the config file ends the run with holdout_access", async () => {
    await setConfig({ [dir]: { holdout_path: sealed } });
    await stubClaude(
      [
        assistantLine(
          toolUse("Read", {
            file_path: join(configHome, "ml-ralph/config.json"),
          }),
        ),
      ],
      true,
    );
    const { completions, errors } = await run();
    expect(errors).toEqual([]);
    expect(completions).toEqual(["holdout_access"]);
    expect((await logEvents()).at(-1)).toMatchObject({
      type: "holdout_access",
      tool: "Read",
    });
  });

  test("the guard also kills what claude started, even a child that outlives it", async () => {
    await setConfig({ [dir]: { holdout_path: sealed } });
    await stubClaude(
      [
        assistantLine(
          toolUse("Bash", { command: `cp ${sealed}/holdout.csv .` }),
        ),
      ],
      true,
      true,
    );
    const { completions, errors } = await run();
    expect(errors).toEqual([]);
    expect(completions).toEqual(["holdout_access"]);
    expect(await waitUntilDead(await waitForChildPid())).toBe(true);
  });

  test("stop() also kills what claude started", async () => {
    await stubClaude([], true, true);
    const runner = new RalphRunner({ projectPath: dir, maxIterations: 1 });
    const started = runner.start().catch(() => {});
    const child = await waitForChildPid();
    expect((await Bun.$`ps -o stat= -p ${child}`.text()).trim()).not.toBe("");
    runner.stop();
    await started;
    expect(await waitUntilDead(child)).toBe(true);
  });

  test("unrelated tool calls run to the iteration limit as before", async () => {
    await setConfig({ [dir]: { holdout_path: sealed } });
    await stubClaude(
      [
        assistantLine(toolUse("Read", { file_path: join(dir, "train.py") })),
        JSON.stringify({ type: "result", result: "<iteration_complete>" }),
      ],
      false,
    );
    const { completions, errors, ends } = await run(2);
    expect(errors).toEqual([]);
    expect(ends).toEqual([1, 2]);
    expect(completions).toEqual(["max_iterations"]);
    expect((await logEvents()).some((e) => e.type === "holdout_access")).toBe(
      false,
    );
  });

  test("a project with no holdout configured is not guarded", async () => {
    await stubClaude(
      [
        assistantLine(
          toolUse("Read", { file_path: join(sealed, "holdout.csv") }),
        ),
        JSON.stringify({ type: "result", result: "<iteration_complete>" }),
      ],
      false,
    );
    const { completions, errors } = await run(1);
    expect(errors).toEqual([]);
    expect(completions).toEqual(["max_iterations"]);
  });

  test("a claude failure unrelated to the holdout is still an error", async () => {
    await setConfig({ [dir]: { holdout_path: sealed } });
    await Bun.write(
      join(stubDir, "claude"),
      "#!/bin/sh\necho boom >&2\nexit 3\n",
    );
    await chmod(join(stubDir, "claude"), 0o755);
    process.env.PATH = `${stubDir}:${saved.path}`;
    const errors: string[] = [];
    const runner = new RalphRunner({
      projectPath: dir,
      maxIterations: 1,
      onError: (e) => errors.push(e.message),
    });
    await expect(runner.start()).rejects.toThrow("Claude process failed");
    expect(errors[0]).toContain("boom");
  });
});
