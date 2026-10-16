/**
 * Tests for the independent verifier, using a stubbed `claude` executable
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import {
  buildVerifierArgs,
  formatVerdictForAgent,
  parseVerdict,
  verifyCandidate,
} from "./verifier.ts";

const APPROVE = {
  verdict: "approve",
  checks: { leakage: "pass", protocol_change: "pass", rubrics: "pass" },
  reason: "clean diff",
} as const;
const REJECT = {
  verdict: "reject",
  checks: { leakage: "fail", protocol_change: "pass", rubrics: "pass" },
  reason: "test labels used in target encoding\nsecond line with details",
} as const;

const envelope = (result: unknown, extra: Record<string, unknown> = {}) =>
  JSON.stringify({
    type: "result",
    is_error: false,
    result: typeof result === "string" ? result : JSON.stringify(result),
    ...extra,
  });

let dir: string;
let stub: string;

function git(...args: string[]) {
  const proc = Bun.spawnSync(
    ["git", "-c", "commit.gpgsign=false", "-c", "user.name=t", ...args],
    { cwd: dir, env: { ...process.env, GIT_AUTHOR_EMAIL: "t@t" } },
  );
  if (proc.exitCode !== 0) throw new Error(proc.stderr.toString());
  return proc.stdout.toString().trim();
}

async function commit(file: string, content: string, message: string) {
  await Bun.write(`${dir}/${file}`, content);
  git("add", file);
  git(
    "-c",
    "user.email=t@t",
    "-c",
    "user.name=t",
    "commit",
    "-q",
    "-m",
    message,
  );
  return git("rev-parse", "HEAD");
}

/** Configure what the stub prints: its stdout and exit code, or a hang */
async function stubReplies(
  stdout: string,
  opts: { exit?: number; hang?: boolean } = {},
) {
  await Bun.write(`${dir}/stub/stdout`, stdout);
  await Bun.write(
    `${dir}/stub/mode`,
    opts.hang ? "hang" : String(opts.exit ?? 0),
  );
}

async function stubArgs(): Promise<string[]> {
  return (await Bun.file(`${dir}/stub/argv`).text())
    .split("\n")
    .filter(Boolean);
}

async function stubPrompt(): Promise<string> {
  return Bun.file(`${dir}/stub/stdin`).text();
}

async function writeConfig(verifier?: Record<string, unknown>) {
  await Bun.write(
    `${dir}/.ml-ralph/config.json`,
    JSON.stringify({ name: "p", ...(verifier ? { verifier } : {}) }),
  );
}

async function writeLog(count: number) {
  const lines = Array.from({ length: count }, (_, i) =>
    JSON.stringify({ ts: "t", type: "learning", insight: `event-${i}` }),
  );
  await Bun.write(`${dir}/.ml-ralph/log.jsonl`, `${lines.join("\n")}\n`);
}

async function readLogTypes(): Promise<Record<string, unknown>[]> {
  const text = await Bun.file(`${dir}/.ml-ralph/log.jsonl`).text();
  return text
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

let baseline: string;
let incumbent: string;

beforeEach(async () => {
  dir = await mkdtemp(`${tmpdir()}/verifier-test-`);
  git("init", "-q");
  baseline = await commit("train.py", "# baseline\n", "baseline");
  incumbent = await commit("train.py", "# incumbent-change\n", "incumbent");
  await commit("train.py", "# candidate-change\n", "candidate");

  await mkdir(`${dir}/.ml-ralph/eval`, { recursive: true });
  await Bun.write(
    `${dir}/.ml-ralph/eval/contract.json`,
    JSON.stringify({ primary_metric: "auc-contract-marker" }),
  );
  await writeConfig();
  await writeLog(3);

  await mkdir(`${dir}/stub`, { recursive: true });
  stub = `${dir}/stub/claude`;
  await Bun.write(
    stub,
    `#!/bin/sh
d="$(dirname "$0")"
for a in "$@"; do printf '%s\\n' "$a"; done > "$d/argv"
cat > "$d/stdin"
mode="$(cat "$d/mode")"
if [ "$mode" = "hang" ]; then exec sleep 30; fi
cat "$d/stdout"
exit "$mode"
`,
  );
  await chmod(stub, 0o755);
  await stubReplies(envelope(APPROVE));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const verify = (extra: Record<string, unknown> = {}) =>
  verifyCandidate({
    projectPath: dir,
    hypothesis: {
      id: "H-001",
      hypothesis: "Time features improve AUC",
      rubrics: ["uses only train split for fitting", "seeds fixed"],
    },
    baselineRef: baseline,
    incumbentRef: incumbent,
    claudeBin: stub,
    id: "v1",
    ...extra,
  });

describe("verifyCandidate: verdicts", () => {
  test("approve", async () => {
    const result = await verify();
    expect(result.verdict).toBe("approve");
    expect(result.checks).toEqual(APPROVE.checks);
    expect(result.reason).toBe("clean diff");
    expect(result.feedback).toBe("Verifier verdict: approve - clean diff");
    expect(result.error).toBeUndefined();
  });

  test("approve with JSON in a code fence", async () => {
    await stubReplies(
      envelope(`Here you go:\n\`\`\`json\n${JSON.stringify(APPROVE)}\n\`\`\``),
    );
    expect((await verify()).verdict).toBe("approve");
  });

  test("reject passes back the verdict and one line of reason only", async () => {
    await stubReplies(envelope(REJECT));
    const result = await verify();
    expect(result.verdict).toBe("reject");
    expect(result.checks.leakage).toBe("fail");
    expect(result.feedback).toBe(
      "Verifier verdict: reject - test labels used in target encoding",
    );
    expect(result.feedback).not.toContain("\n");
    expect(result.feedback).not.toContain("second line");
  });

  test("saves the full output and logs a verifier_verdict event", async () => {
    const stdout = envelope(REJECT, { total_cost_usd: 0.02 });
    await stubReplies(stdout);
    const result = await verify();

    expect(result.outputPath).toBe(".ml-ralph/verifier/v1.json");
    const saved = await Bun.file(`${dir}/${result.outputPath}`).json();
    expect(saved.verdict).toBe("reject");
    expect(saved.checks).toEqual(REJECT.checks);
    expect(saved.reason).toBe(REJECT.reason);
    expect(saved.hypothesis_id).toBe("H-001");
    expect(saved.raw_output).toBe(stdout);

    const events = await readLogTypes();
    const event = events.at(-1);
    expect(event).toMatchObject({
      type: "verifier_verdict",
      id: "v1",
      verdict: "reject",
      checks: REJECT.checks,
      reason: REJECT.reason,
      output_path: ".ml-ralph/verifier/v1.json",
    });
    expect(typeof event?.ts).toBe("string");
  });
});

describe("verifyCandidate: verifier_error", () => {
  const expectError = async (
    result: Awaited<ReturnType<typeof verify>>,
    detail: string,
  ) => {
    expect(result.verdict).toBe("reject");
    expect(result.reason).toBe("verifier_error");
    expect(result.feedback).toBe("Verifier verdict: reject - verifier_error");
    expect(result.error).toContain(detail);
    const saved = await Bun.file(`${dir}/${result.outputPath}`).json();
    expect(saved.reason).toBe("verifier_error");
    expect(saved.error).toContain(detail);
    expect((await readLogTypes()).at(-1)).toMatchObject({
      type: "verifier_verdict",
      verdict: "reject",
      reason: "verifier_error",
    });
  };

  test("crash (non-zero exit)", async () => {
    await stubReplies("", { exit: 2 });
    await expectError(await verify(), "exit code 2");
  });

  test("timeout", async () => {
    await stubReplies("", { hang: true });
    const started = Date.now();
    await expectError(await verify({ timeoutMs: 300 }), "timeout");
    expect(Date.now() - started).toBeLessThan(10_000);
  });

  test("unparseable output", async () => {
    await stubReplies(envelope("I think this looks fine."));
    await expectError(await verify(), "unparseable");
  });

  test("stdout that is not JSON", async () => {
    await stubReplies("not json at all");
    await expectError(await verify(), "unparseable");
  });

  test("error envelope", async () => {
    await stubReplies(envelope(APPROVE, { is_error: true }));
    await expectError(await verify(), "unparseable");
  });

  test("approve that contradicts its own failed check", async () => {
    await stubReplies(
      envelope({
        ...APPROVE,
        checks: { ...APPROVE.checks, leakage: "fail" },
      }),
    );
    await expectError(await verify(), "unparseable");
  });

  test("missing contract.json", async () => {
    await rm(`${dir}/.ml-ralph/eval/contract.json`);
    await expectError(await verify(), "contract.json");
  });

  test("unknown git ref", async () => {
    await expectError(await verify({ incumbentRef: "nope" }), "git diff");
  });
});

describe("verifyCandidate: session flags", () => {
  test("denies write and shell tools and skips permission bypass", async () => {
    await verify();
    const args = await stubArgs();

    expect(args).toContain("-p");
    expect(args).not.toContain("--dangerously-skip-permissions");
    const denied = args[args.indexOf("--disallowedTools") + 1]?.split(",");
    for (const tool of ["Write", "Edit", "MultiEdit", "NotebookEdit", "Bash"]) {
      expect(denied).toContain(tool);
    }
    expect(args[args.indexOf("--tools") + 1]).toBe("Read,Grep,Glob");
    expect(args[args.indexOf("--permission-mode") + 1]).toBe("dontAsk");
  });

  test("buildVerifierArgs uses the default model unless one is given", () => {
    expect(buildVerifierArgs()).not.toContain("--model");
    const args = buildVerifierArgs("claude-sonnet-5");
    expect(args[args.indexOf("--model") + 1]).toBe("claude-sonnet-5");
  });

  test("omits --model by default", async () => {
    await verify();
    expect(await stubArgs()).not.toContain("--model");
  });

  test("uses verifier.model from config", async () => {
    await writeConfig({ model: "claude-opus-5-5" });
    await verify();
    const args = await stubArgs();
    expect(args[args.indexOf("--model") + 1]).toBe("claude-opus-5-5");
    const saved = await Bun.file(`${dir}/.ml-ralph/verifier/v1.json`).json();
    expect(saved.model).toBe("claude-opus-5-5");
  });
});

describe("verifyCandidate: prompt", () => {
  test("contains the diff vs incumbent, contract and rubrics", async () => {
    await verify();
    const prompt = await stubPrompt();
    expect(prompt).toContain("+# candidate-change");
    expect(prompt).toContain("-# incumbent-change");
    expect(prompt).not.toContain("# baseline");
    expect(prompt).toContain("auc-contract-marker");
    expect(prompt).toContain("1. uses only train split for fitting");
    expect(prompt).toContain("2. seeds fixed");
    expect(prompt).toContain("Hypothesis H-001");
  });

  test("diffs against the baseline when there is no incumbent", async () => {
    await verify({ incumbentRef: undefined });
    const prompt = await stubPrompt();
    expect(prompt).toContain("-# baseline");
    expect(prompt).toContain("+# candidate-change");
  });

  test("includes the last 50 log events by default", async () => {
    await writeLog(60);
    await verify();
    const prompt = await stubPrompt();
    expect(prompt).toContain("event-59");
    expect(prompt).toContain("event-10");
    expect(prompt).not.toContain('event-9"');
    expect(prompt).toContain("Last 50 log events");
  });

  test("honours verifier.recent_events", async () => {
    await writeConfig({ recent_events: 2 });
    await writeLog(10);
    await verify();
    const prompt = await stubPrompt();
    expect(prompt).toContain("event-9");
    expect(prompt).toContain("event-8");
    expect(prompt).not.toContain("event-7");
  });
});

describe("parseVerdict and formatVerdictForAgent", () => {
  test("rejects missing or invalid fields", () => {
    expect(parseVerdict("")).toBeNull();
    expect(parseVerdict(JSON.stringify({ verdict: "maybe" }))).toBeNull();
    expect(
      parseVerdict(JSON.stringify({ ...REJECT, checks: { leakage: "fail" } })),
    ).toBeNull();
    expect(parseVerdict(JSON.stringify({ ...REJECT, reason: 3 }))).toBeNull();
  });

  test("clips a long reason to one short line", () => {
    const text = formatVerdictForAgent("reject", "x".repeat(500));
    expect(text.length).toBeLessThan(260);
    expect(text).not.toContain("\n");
  });

  test("returns just the verdict when there is no reason", () => {
    expect(formatVerdictForAgent("approve", "  \n")).toBe(
      "Verifier verdict: approve",
    );
  });
});
