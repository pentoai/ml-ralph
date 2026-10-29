import { describe, expect, test } from "bun:test";
import type { TrainingJob } from "../domain/types/index.ts";
import type { StopJobResult } from "../infrastructure/ralph/index.ts";
import { stopSelectedJob } from "./job-controls.ts";
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
