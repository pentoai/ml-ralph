import { describe, expect, test } from "bun:test";
import type { TrainingJob } from "../domain/types/index.ts";
import type { StopJobResult } from "../infrastructure/ralph/index.ts";
import { followJobLog, stopSelectedJob } from "./job-controls.ts";
import { JobsPanel } from "./widgets/jobs-panel.tsx";

const job = {
  id: "job_1",
  pid: 1,
  command: "python train.py",
  logPath: "/x",
} as TrainingJob;

async function run(result: StopJobResult | Error) {
  const events: string[] = [];
  let notice: string | null = null;
  await stopSelectedJob(job, {
    stop: async () => {
      if (result instanceof Error) throw result;
      return result;
    },
    refresh: async () => void events.push("refresh"),
    setNotice: (n) => {
      notice = n;
      events.push("notice");
    },
    closeLog: () => void events.push("closeLog"),
  });
  return { events, notice: notice as string | null };
}

describe("stop-job notices", () => {
  test("job not running is set after the refresh and is the last update", async () => {
    const { events, notice } = await run({
      outcome: "not_running",
      message: "job not running",
    });
    expect(events).toEqual(["closeLog", "refresh", "notice"]);
    expect(notice).toBe("job not running");
  });

  test("a kill error stays as the final notice", async () => {
    const { notice } = await run({ outcome: "error", message: "EPERM" });
    expect(notice).toBe("EPERM");
  });

  test("a rejected stop reports the failure", async () => {
    const { notice } = await run(new Error("boom"));
    expect(notice).toBe("Failed to stop job: boom");
  });

  test("a stop shows the stopping message", async () => {
    const { notice } = await run({ outcome: "stopped", message: "x" });
    expect(notice).toContain("stopping job_1");
  });
});

describe("JobsPanel", () => {
  const props = { selectedIndex: 0, log: null, logScroll: 0, maxRows: 10 };
  test("still renders a notice when the job list is empty", () => {
    expect(
      JobsPanel({ ...props, jobs: [], notice: "job not running" }),
    ).not.toBeNull();
  });
  test("renders nothing with no jobs and no notice", () => {
    expect(JobsPanel({ ...props, jobs: [], notice: null })).toBeNull();
  });
});

describe("followJobLog", () => {
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

  test("shows new lines while the job writes, pauses when scrolled, reloads once on stop", async () => {
    let n = 1;
    let paused = false;
    const seen: string[][] = [];
    const stop = followJobLog({
      logPath: "/x",
      tail: async () => Array.from({ length: n }, (_, i) => `l${i}`),
      onLines: (l) => seen.push(l),
      isPaused: () => paused,
      intervalMs: 10,
    });
    await wait(35);
    n = 3;
    await wait(25);
    expect(seen.at(-1)).toEqual(["l0", "l1", "l2"]);
    paused = true;
    await wait(15);
    const count = seen.length;
    n = 4;
    await wait(40);
    expect(seen.length).toBe(count);
    stop();
    await wait(10);
    expect(seen.at(-1)).toHaveLength(4);
    const after = seen.length;
    await wait(40);
    expect(seen.length).toBe(after);
  });
});
