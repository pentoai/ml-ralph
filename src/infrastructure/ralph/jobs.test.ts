import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TrainingJob } from "../../domain/types/index.ts";
import {
  pruneStaleJobs,
  readActiveJobs,
  runJobCommand,
  stopJob,
  tailJobLog,
} from "./jobs.ts";
import { RalphRunner } from "./runner.ts";

let dir: string;
const activeFile = () => join(dir, ".ml-ralph", "runs", "active.json");

const job = (id: string, pid: number, logPath = "/nope"): TrainingJob => ({
  id,
  storyId: "",
  experimentId: "",
  pid,
  command: "python train.py",
  logPath,
  startedAt: "2026-01-01T00:00:00.000Z",
  status: "running",
});

const seed = (jobs: TrainingJob[]) =>
  writeFile(activeFile(), JSON.stringify({ jobs }));

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "jobs-"));
  await mkdir(join(dir, ".ml-ralph", "runs"), { recursive: true });
  await seed([]);
});
afterEach(() => rm(dir, { recursive: true, force: true }));

describe("job start lifecycle", () => {
  test("records pid, command, start time and log path, then removes the entry on exit", async () => {
    const seen: TrainingJob[][] = [];
    const watcher = setInterval(async () => {
      const jobs = await readActiveJobs(dir);
      if (jobs.length) seen.push(jobs);
    }, 20);
    const result = await runJobCommand(["start", "echo hello; sleep 0.5"], {
      cwd: dir,
    });
    clearInterval(watcher);
    expect(result.code).toBe(0);
    const entry = seen[0]?.[0];
    expect(entry?.pid).toBeGreaterThan(0);
    expect(entry?.command).toBe("echo hello; sleep 0.5");
    expect(Date.parse(entry?.startedAt ?? "")).not.toBeNaN();
    expect(entry?.logPath).toContain(join(".ml-ralph", "runs", "logs"));
    expect(await readFile(entry?.logPath ?? "", "utf8")).toContain("hello");
    expect(await readActiveJobs(dir)).toEqual([]);
  });

  test("passes the exit code through and still removes the entry", async () => {
    const result = await runJobCommand(["start", "exit 3"], { cwd: dir });
    expect(result.code).toBe(3);
    expect(await readActiveJobs(dir)).toEqual([]);
  });

  test("rejects a missing command", async () => {
    expect((await runJobCommand(["start"], { cwd: dir })).code).toBe(1);
  });
});

describe("stale cleanup", () => {
  test("removes entries whose pid is not alive, keeps live ones", async () => {
    await seed([job("live", process.pid), job("dead", 2 ** 22 + 12345)]);
    const removed = await pruneStaleJobs(dir);
    expect(removed.map((j) => j.id)).toEqual(["dead"]);
    expect((await readActiveJobs(dir)).map((j) => j.id)).toEqual(["live"]);
  });

  test("runner start prunes stale entries", async () => {
    await seed([job("dead", 2 ** 22 + 12345)]);
    await writeFile(join(dir, ".ml-ralph", "RALPH.md"), "x");
    const runner = new RalphRunner({ projectPath: dir, maxIterations: 0 });
    await runner.start();
    expect(await readActiveJobs(dir)).toEqual([]);
  });
});

describe("stopJob", () => {
  test("SIGTERM, then SIGKILL after the grace period, and removes the entry", async () => {
    await seed([job("a", 111), job("b", 222)]);
    const sent: string[] = [];
    const result = await stopJob(dir, job("a", 111), {
      graceMs: 20,
      kill: (pid, sig) => void sent.push(`${pid}:${sig}`),
    });
    expect(result.outcome).toBe("stopped");
    expect(sent).toEqual(["111:SIGTERM"]);
    await Bun.sleep(60);
    expect(sent).toEqual(["111:SIGTERM", "111:SIGKILL"]);
    expect((await readActiveJobs(dir)).map((j) => j.id)).toEqual(["b"]);
  });

  test("reports job not running when the pid is gone, and removes the entry", async () => {
    await seed([job("a", 111)]);
    const result = await stopJob(dir, job("a", 111), {
      kill: () => {
        throw Object.assign(new Error("no"), { code: "ESRCH" });
      },
    });
    expect(result).toEqual({
      outcome: "not_running",
      message: "job not running",
    });
    expect(await readActiveJobs(dir)).toEqual([]);
  });

  test("reports the error when the kill fails", async () => {
    await seed([job("a", 111)]);
    const result = await stopJob(dir, job("a", 111), {
      kill: () => {
        throw Object.assign(new Error("operation not permitted"), {
          code: "EPERM",
        });
      },
    });
    expect(result.outcome).toBe("error");
    expect(result.message).toBe("operation not permitted");
    expect(await readActiveJobs(dir)).toEqual([]);
  });

  test("runner logs job_stopped and tells the next prompt", async () => {
    const j = job("a", 2 ** 22 + 999);
    await seed([j]);
    await writeFile(join(dir, ".ml-ralph", "log.jsonl"), "");
    const runner = new RalphRunner({ projectPath: dir });
    await runner.stopJob(j);
    const logged = (await readFile(join(dir, ".ml-ralph", "log.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    expect(logged[0]).toMatchObject({
      type: "job_stopped",
      job_id: "a",
      outcome: "not_running",
    });
    expect(await runner.buildPrompt()).toContain("training job a");
  });
});

describe("tailJobLog", () => {
  test("returns the last 50 lines of a longer log", async () => {
    const path = join(dir, "x.log");
    await writeFile(
      path,
      `${Array.from({ length: 120 }, (_, i) => `line ${i}`).join("\n")}\n`,
    );
    const lines = await tailJobLog(path);
    expect(lines).toHaveLength(50);
    expect(lines?.[0]).toBe("line 70");
    expect(lines?.[49]).toBe("line 119");
  });

  test("returns null when the log is missing", async () => {
    expect(await tailJobLog(join(dir, "missing.log"))).toBeNull();
  });
});
