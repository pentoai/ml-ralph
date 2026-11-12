/**
 * Tests for the pre-compute critique of `ml-ralph job start`, using a stubbed `claude`
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LOG_EVENT_SCHEMAS } from "../../domain/validation/log-event.ts";
import { parseCritiqueThreshold, readCritiqueCosts } from "./critique.ts";
import { readActiveJobs, runJobCommand } from "./jobs.ts";
import { RalphRunner } from "./runner.ts";

let dir: string;
let stub: string;
const ml = (...p: string[]) => join(dir, ".ml-ralph", ...p);

const envelope = (result: string, cost?: number) =>
  JSON.stringify({
    type: "result",
    is_error: false,
    result,
    ...(cost === undefined ? {} : { total_cost_usd: cost }),
  });

/** What the stub prints and how it exits; it records that it ran in stub/ran */
async function stubReplies(stdout: string, mode = "0") {
  await writeFile(join(dir, "stub-stdout"), stdout);
  await writeFile(join(dir, "stub-mode"), mode);
}
const critiqueRan = () => Bun.file(join(dir, "stub-ran")).exists();

async function config(extra: Record<string, unknown>) {
  await writeFile(ml("config.json"), JSON.stringify({ name: "p", ...extra }));
}

async function events(): Promise<Record<string, unknown>[]> {
  const text = await readFile(ml("log.jsonl"), "utf8").catch(() => "");
  return text
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}
const critiques = async () =>
  (await events()).filter((e) => e.type === "critique_verdict");

const start = (flags: string[], cmd = "echo started > started.txt") =>
  runJobCommand(["start", ...flags, cmd], {
    cwd: dir,
    claudeBin: stub,
    critiqueTimeoutMs: 600,
  });
const started = () => Bun.file(join(dir, "started.txt")).exists();

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "critique-"));
  await mkdir(ml("runs"), { recursive: true });
  await writeFile(ml("RALPH.md"), "# ralph");
  await writeFile(ml("conclusions.md"), "- CONCLUSION-MARKER\n");
  await writeFile(ml("kanban.json"), '{"KANBAN-MARKER":true}');
  await writeFile(
    ml("log.jsonl"),
    `${JSON.stringify({ ts: "t", type: "hypothesis", id: "H1", claim: "wider net helps", expected_delta: 0.01, rubrics: ["r"], kill_criterion: "k" })}\n`,
  );
  stub = join(dir, "claude-stub");
  await writeFile(
    stub,
    `#!/bin/sh
cat > "${dir}/stub-prompt"
echo ran > "${dir}/stub-ran"
mode=$(cat "${dir}/stub-mode")
if [ "$mode" = hang ]; then exec sleep 30; fi
cat "${dir}/stub-stdout"
exit "$mode"
`,
  );
  await chmod(stub, 0o755);
  await stubReplies(envelope('{"verdict":"approve","reason":"fine"}', 0.25));
});
afterEach(() => rm(dir, { recursive: true, force: true }));

describe("critique before a job", () => {
  test("above the threshold: logs an approve verdict first, then the job starts", async () => {
    await config({ critique_threshold_minutes: 10 });
    const r = await start(["--est-minutes", "30", "--hypothesis-id", "H1"]);
    expect(r.code).toBe(0);
    expect(await started()).toBe(true);
    expect(await critiques()).toMatchObject([
      {
        verdict: "approve",
        reason: "fine",
        hypothesis_id: "H1",
        est_minutes: 30,
        cost_usd: 0.25,
      },
    ]);
    const prompt = await readFile(join(dir, "stub-prompt"), "utf8");
    expect(prompt).toContain("CONCLUSION-MARKER");
    expect(prompt).toContain("KANBAN-MARKER");
    expect(prompt).toContain("wider net helps");
  });

  test("a reject exits non-zero with exactly its one-line reason and starts no job", async () => {
    await config({ critique_threshold_minutes: 10 });
    await stubReplies(
      envelope(
        '{"verdict":"reject","reason":"conclusions.md already refutes H1\\nmore detail"}',
      ),
    );
    const r = await start(["--est-minutes=30", "--hypothesis-id=H1"]);
    expect(r.code).not.toBe(0);
    expect(r.stderr).toBe("conclusions.md already refutes H1\n");
    expect(await started()).toBe(false);
    expect(await readActiveJobs(dir)).toEqual([]);
    expect(await critiques()).toMatchObject([{ verdict: "reject" }]);
  });

  test("at or below the threshold, or with no threshold, no critique runs", async () => {
    await config({ critique_threshold_minutes: 10 });
    expect(
      (await start(["--est-minutes", "10", "--hypothesis-id", "H1"])).code,
    ).toBe(0);
    await config({});
    expect((await start(["--est-minutes", "999"])).code).toBe(0);
    expect(await critiqueRan()).toBe(false);
    expect(await critiques()).toEqual([]);
  });

  test("with a threshold, missing flags or an unknown hypothesis are refused with a fixable error", async () => {
    await config({ critique_threshold_minutes: 10 });
    for (const flags of [
      [],
      ["--est-minutes", "1"],
      ["--hypothesis-id", "H1"],
    ]) {
      const r = await start(flags);
      expect(r.code).not.toBe(0);
      expect(r.stderr).toContain("--est-minutes");
      expect(r.stderr).toContain("--hypothesis-id");
    }
    const r = await start(["--est-minutes", "1", "--hypothesis-id", "H9"]);
    expect(r.code).not.toBe(0);
    expect(r.stderr).toContain("H9");
    expect(await started()).toBe(false);
    expect(await critiqueRan()).toBe(false);
  });

  test("an invalid threshold is refused naming the key", async () => {
    await config({ critique_threshold_minutes: "soon" });
    const r = await start([]);
    expect(r.code).not.toBe(0);
    expect(r.stderr).toContain("critique_threshold_minutes");
    expect(await started()).toBe(false);
  });

  test("a crash, an unparseable reply or a timeout lets the job start and logs error", async () => {
    await config({ critique_threshold_minutes: 10 });
    const flags = ["--est-minutes", "30", "--hypothesis-id", "H1"];
    await stubReplies("", "1");
    expect((await start(flags)).code).toBe(0);
    await stubReplies(envelope("no json here"));
    expect((await start(flags)).code).toBe(0);
    await stubReplies("", "hang");
    const t0 = Date.now();
    expect((await start(flags)).code).toBe(0);
    expect(Date.now() - t0).toBeLessThan(10_000);
    expect((await critiques()).map((e) => e.verdict)).toEqual([
      "error",
      "error",
      "error",
    ]);
    expect(await started()).toBe(true);
  });

  test("a hypothesis found only past many later log lines is still found", async () => {
    await config({ critique_threshold_minutes: 10 });
    const filler = Array.from({ length: 2000 }, (_, i) =>
      JSON.stringify({ ts: "t", type: "learning", insight: `i${i}` }),
    );
    const first = (await readFile(ml("log.jsonl"), "utf8")).trim();
    await writeFile(ml("log.jsonl"), `${first}\n${filler.join("\n")}\n`);
    expect(
      (await start(["--est-minutes", "30", "--hypothesis-id", "H1"])).code,
    ).toBe(0);
  });
});

describe("critique cost and config", () => {
  test("the cost lands in the ledger the runner reads", async () => {
    await config({ critique_threshold_minutes: 10 });
    await start(["--est-minutes", "30", "--hypothesis-id", "H1"]);
    await start(["--est-minutes", "30", "--hypothesis-id", "H1"]);
    expect(readCritiqueCosts(dir)).toEqual({ usd: 0.5, lines: 2 });
    expect(readCritiqueCosts(dir, 1)).toEqual({ usd: 0.25, lines: 2 });
  });

  test("a critique's cost counts against max_usd: the runner ends the run", async () => {
    await mkdir(ml("eval"), { recursive: true });
    await config({ max_usd: 0.3 });
    const prompts: string[] = [];
    class Fake extends RalphRunner {
      protected override async runIteration(prompt: string): Promise<string> {
        prompts.push(prompt);
        // The agent's job start runs a critique costing $0.25 each iteration
        await config({ max_usd: 0.3, critique_threshold_minutes: 10 });
        await start(["--est-minutes", "30", "--hypothesis-id", "H1"]);
        return "";
      }
    }
    const reasons: string[] = [];
    const runner = new Fake({
      projectPath: dir,
      maxIterations: 5,
      onComplete: (reason: string) => reasons.push(reason),
    } as never);
    await runner.start();
    expect(prompts.length).toBeLessThan(5);
    const statuses = (await events()).filter((e) => e.type === "budget_status");
    expect(statuses.at(-1)?.usd_spent).toBeGreaterThanOrEqual(0.25);
    expect((await events()).some((e) => e.type === "budget_exhausted")).toBe(
      true,
    );
  });

  test("the runner refuses to start on an invalid threshold, naming the key", async () => {
    await config({ critique_threshold_minutes: -5 });
    const errors: string[] = [];
    let ran = false;
    class Fake extends RalphRunner {
      protected override async runIteration(): Promise<string> {
        ran = true;
        return "";
      }
    }
    await new Fake({
      projectPath: dir,
      maxIterations: 1,
      onError: (e: Error) => errors.push(e.message),
    } as never).start();
    expect(ran).toBe(false);
    expect(errors[0]).toContain("critique_threshold_minutes");
  });

  test("parseCritiqueThreshold: unset, valid and invalid values", () => {
    expect(parseCritiqueThreshold({})).toEqual({ ok: true });
    expect(
      parseCritiqueThreshold({ critique_threshold_minutes: null }),
    ).toEqual({ ok: true });
    expect(parseCritiqueThreshold({ critique_threshold_minutes: 5.5 })).toEqual(
      { ok: true, threshold: 5.5 },
    );
    for (const bad of [0, -1, "10", Number.NaN, true]) {
      expect(
        parseCritiqueThreshold({ critique_threshold_minutes: bad }).ok,
      ).toBe(false);
    }
  });

  test("critique_verdict is runner-only", () => {
    expect(LOG_EVENT_SCHEMAS.critique_verdict?.runnerOnly).toBe(true);
  });
});
