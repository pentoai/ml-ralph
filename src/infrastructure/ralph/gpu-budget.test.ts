/**
 * Tests for the GPU-hours cap: `--gpus` on job start, the ledger under
 * .ml-ralph/budget, the config key, the prompt and header text, and the stop.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  budgetPrompt,
  formatBudget,
  headerBudget,
  parseBudgetCaps,
  readRecordedBudget,
  writeRunId,
} from "./budget.ts";
import { readGpuHours, writeGpuJob } from "./gpu-hours.ts";
import { readActiveJobs, runJobCommand } from "./jobs.ts";
import { RalphRunner, type RunCompleteReason } from "./runner.ts";

const HOUR = 3_600_000;
const STUB_CLAUDE = `#!/bin/sh
sleep 1
echo '{"type":"result","subtype":"success","result":"done <iteration_complete>","total_cost_usd":0.01}'
`;

let dir: string;
let binDir: string;
let oldPath: string | undefined;
const children: number[] = [];

const ledgerFiles = () =>
  readdir(join(dir, ".ml-ralph/budget/gpu-jobs")).catch(() => []);
const writeConfig = (extra: Record<string, unknown>) =>
  Bun.write(
    join(dir, ".ml-ralph/config.json"),
    JSON.stringify({ name: "p", ...extra }),
  );

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "ml-ralph-gpu-"));
  binDir = await mkdtemp(join(tmpdir(), "ml-ralph-gpu-bin-"));
  await mkdir(join(dir, ".ml-ralph/runs"), { recursive: true });
  await Bun.write(join(dir, ".ml-ralph/RALPH.md"), "# ralph");
  await Bun.write(join(binDir, "claude"), STUB_CLAUDE);
  await chmod(join(binDir, "claude"), 0o755);
  oldPath = process.env.PATH;
  process.env.PATH = `${binDir}:${oldPath}`;
});

afterEach(async () => {
  process.env.PATH = oldPath;
  for (const pid of children.splice(0)) {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      // already gone
    }
  }
  await rm(dir, { recursive: true, force: true });
  await rm(binDir, { recursive: true, force: true });
});

describe("max_gpu_hours config key", () => {
  test("a positive number is accepted; absent leaves no cap", () => {
    expect(parseBudgetCaps({ max_gpu_hours: 2.5 })).toEqual({
      ok: true,
      caps: { max_gpu_hours: 2.5 },
    });
    expect(parseBudgetCaps({ name: "p" })).toEqual({ ok: true, caps: {} });
  });

  test.each([0, -1, "8", Number.NaN])("rejects %p and names the key", (v) => {
    const result = parseBudgetCaps({ max_gpu_hours: v });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("max_gpu_hours");
  });

  test("an invalid value is refused at run start", async () => {
    await writeConfig({ max_gpu_hours: -3 });
    const errors: string[] = [];
    const runner = new RalphRunner({
      projectPath: dir,
      maxIterations: 1,
      onError: (e) => errors.push(e.message),
    });
    await runner.start();
    expect(errors[0]).toContain("max_gpu_hours");
  });
});

describe("job start --gpus", () => {
  test("records gpus with the job and in the ledger, and the ledger outlives the job", async () => {
    await writeRunId(dir, "run-1");
    let seen: number | undefined;
    const watcher = setInterval(async () => {
      const jobs = await readActiveJobs(dir);
      if (jobs[0]) seen = jobs[0].gpus;
    }, 20);
    const result = await runJobCommand(["start", "--gpus", "2", "sleep 0.6"], {
      cwd: dir,
    });
    clearInterval(watcher);
    expect(result.code).toBe(0);
    expect(seen).toBe(2);
    expect(await readActiveJobs(dir)).toEqual([]);
    expect(await ledgerFiles()).toHaveLength(1);
    const hours = await readGpuHours(dir, "run-1");
    // 2 GPUs for about 0.6 s
    expect(hours).toBeGreaterThan((2 * 0.5) / 3600);
    expect(hours).toBeLessThan((2 * 5) / 3600);
    expect(await readGpuHours(dir, "other-run")).toBe(0);
  });

  test("the --gpus=N form works and a bad value is refused", async () => {
    await writeRunId(dir, "run-1");
    expect(
      (await runJobCommand(["start", "--gpus=1", "true"], { cwd: dir })).code,
    ).toBe(0);
    const bad = await runJobCommand(["start", "--gpus", "two", "true"], {
      cwd: dir,
    });
    expect(bad.code).toBe(1);
    expect(bad.stderr).toContain("--gpus");
  });

  test("with max_gpu_hours set, a start without --gpus is refused naming the flag", async () => {
    await writeConfig({ max_gpu_hours: 5 });
    const result = await runJobCommand(["start", "touch ran.txt"], {
      cwd: dir,
    });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("--gpus");
    expect(await Bun.file(join(dir, "ran.txt")).exists()).toBe(false);
  });

  test("without a cap, --gpus is optional", async () => {
    expect((await runJobCommand(["start", "true"], { cwd: dir })).code).toBe(0);
  });

  test("a start is refused once the cap is already used", async () => {
    await writeConfig({ max_gpu_hours: 4 });
    await writeRunId(dir, "run-1");
    const now = Date.now();
    await writeGpuJob(dir, {
      job_id: "old",
      run_id: "run-1",
      gpus: 2,
      pid: 1,
      started_at: now - 3 * HOUR,
      last_seen: now - HOUR,
      ended_at: now - HOUR,
    });
    const result = await runJobCommand(
      ["start", "--gpus", "1", "touch ran.txt"],
      { cwd: dir },
    );
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("max_gpu_hours");
    expect(await Bun.file(join(dir, "ran.txt")).exists()).toBe(false);
  });
});

describe("usage", () => {
  test("sums finished and running jobs; a dead unfinished job stops at its last heartbeat", async () => {
    const now = Date.now();
    const base = { run_id: "r", pid: 4242, last_seen: now };
    await writeGpuJob(dir, {
      ...base,
      job_id: "done",
      gpus: 2,
      started_at: now - 2 * HOUR,
      ended_at: now - HOUR,
    });
    await writeGpuJob(dir, {
      ...base,
      job_id: "running",
      gpus: 4,
      started_at: now - HOUR / 2,
    });
    await writeGpuJob(dir, {
      ...base,
      job_id: "dead",
      gpus: 1,
      started_at: now - 5 * HOUR,
      last_seen: now - 4 * HOUR,
    });
    const alive = (_pid: number) => true;
    expect(await readGpuHours(dir, "r", now, alive)).toBeCloseTo(2 + 2 + 5, 5);
    const dead = (_pid: number) => false;
    // running (4 GPUs) and dead (1 GPU) both stop at last_seen
    expect(await readGpuHours(dir, "r", now, dead)).toBeCloseTo(
      2 + 4 * 0.5 + 1,
      5,
    );
  });

  test("survives a runner restart: the header reads it from the ledger", async () => {
    await writeRunId(dir, "run-1");
    const now = Date.now();
    await writeGpuJob(dir, {
      job_id: "j",
      run_id: "run-1",
      gpus: 2,
      pid: 1,
      started_at: now - 2 * HOUR,
      last_seen: now - HOUR,
      ended_at: now - HOUR,
    });
    const recorded = await readRecordedBudget(dir);
    expect(recorded.gpu_hours_used).toBeCloseTo(2, 5);
  });

  test("a run with no ledger starts at 0", async () => {
    await writeRunId(dir, "legacy");
    expect((await readRecordedBudget(dir)).gpu_hours_used).toBe(0);
  });
});

describe("prompt and header", () => {
  test("show GPU-hours used and left only when a cap is set", () => {
    const text = budgetPrompt({
      usd_spent: 0,
      elapsed_minutes: 0,
      gpu_hours_used: 1.5,
      max_gpu_hours: 4,
    });
    expect(text).toContain("GPU-hours used: 1.50");
    expect(text).toContain("left: 2.50");
    const shown = formatBudget({
      usd_spent: 0,
      elapsed_minutes: 0,
      gpu_hours_used: 1.5,
      max_gpu_hours: 4,
    });
    expect(shown.gpu).toBe("1.50 / 4 h");

    const open = { usd_spent: 1, elapsed_minutes: 1 };
    expect(budgetPrompt(open)).not.toContain("GPU");
    expect(formatBudget(open).gpu).toBeUndefined();
    const header = headerBudget({ max_usd: 5 }, { ...open, gpu_hours_used: 3 });
    expect(header.status.gpu_hours_used).toBeUndefined();
  });
});

describe("runner stop", () => {
  test("at the cap the runner stops running jobs, ends with budget_exhausted gpu_hours and writes report.md", async () => {
    await writeConfig({ max_gpu_hours: 4.0005 });
    await writeRunId(dir, "run-1");
    const job = spawn("sleep", ["60"], { detached: true, stdio: "ignore" });
    const pid = job.pid as number;
    children.push(pid);
    const now = Date.now();
    await writeGpuJob(dir, {
      job_id: "job_1",
      run_id: "run-1",
      gpus: 4,
      pid,
      started_at: now - HOUR,
      last_seen: now,
    });
    await Bun.write(
      join(dir, ".ml-ralph/runs/active.json"),
      JSON.stringify({
        jobs: [
          {
            id: "job_1",
            storyId: "",
            experimentId: "",
            pid,
            command: "sleep 60",
            logPath: "/nope",
            startedAt: new Date(now - HOUR).toISOString(),
            status: "running",
            gpus: 4,
          },
        ],
      }),
    );
    const completions: RunCompleteReason[] = [];
    const runner = new RalphRunner({
      projectPath: dir,
      maxIterations: 5,
      onComplete: (r) => completions.push(r),
    });
    await runner.start();

    expect(completions).toEqual(["budget_exhausted"]);
    const log = (await Bun.file(join(dir, ".ml-ralph/log.jsonl")).text())
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l));
    const exhausted = log.filter((e) => e.type === "budget_exhausted");
    expect(exhausted).toHaveLength(1);
    expect(exhausted[0]).toMatchObject({
      cap: "gpu_hours",
      max_gpu_hours: 4.0005,
    });
    expect(exhausted[0].gpu_hours_used).toBeGreaterThanOrEqual(4.0005);
    expect(await readActiveJobs(dir)).toEqual([]);
    const reports = await readdir(join(dir, ".ml-ralph/reports/run-1"));
    expect(reports).toContain("report.md");
    // the job was signalled
    await new Promise((r) => setTimeout(r, 200));
    expect(() => process.kill(pid, 0)).toThrow();
  });

  test("a run whose cap is already used ends at start without running claude", async () => {
    await writeConfig({ max_gpu_hours: 1 });
    await writeRunId(dir, "run-1");
    const now = Date.now();
    await writeGpuJob(dir, {
      job_id: "old",
      run_id: "run-1",
      gpus: 1,
      pid: 1,
      started_at: now - 2 * HOUR,
      last_seen: now - HOUR,
      ended_at: now - HOUR,
    });
    const completions: RunCompleteReason[] = [];
    const runner = new RalphRunner({
      projectPath: dir,
      maxIterations: 3,
      onComplete: (r) => completions.push(r),
    });
    await runner.start();
    expect(completions).toEqual(["budget_exhausted"]);
  });
});
