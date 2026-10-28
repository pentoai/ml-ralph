import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RalphRunner } from "../../infrastructure/ralph/index.ts";
import { DefaultOrchestrator } from "./orchestrator.ts";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "ml-ralph-quit-"));
  await mkdir(join(dir, ".ml-ralph/budget"), { recursive: true });
  await Bun.write(join(dir, ".ml-ralph/RALPH.md"), "# ralph");
  await Bun.write(join(dir, ".ml-ralph/budget/run.json"), '{"run_id":"run-q"}');
});
afterEach(() => rm(dir, { recursive: true, force: true }));

test("quitting through the orchestrator waits for the user_quit report", async () => {
  let release = () => {};
  class Hang extends RalphRunner {
    protected override async runIteration(): Promise<string> {
      await new Promise<void>((r) => {
        release = r;
      });
      return "<iteration_complete>";
    }
  }
  const orchestrator = new DefaultOrchestrator({
    projectPath: dir,
    autoAdvance: false,
  });
  (orchestrator as unknown as { runner: RalphRunner }).runner = new Hang({
    projectPath: dir,
  });
  const started = orchestrator.start();
  await Bun.sleep(50);
  expect(orchestrator.isRunning()).toBe(true);

  // What the TUI's quit path does before process exit
  const stopping = orchestrator.stop();
  release();
  await stopping;

  const report = Bun.file(join(dir, ".ml-ralph/reports/run-q/report.md"));
  expect(await report.exists()).toBe(true);
  expect(await report.text()).toContain("End reason: user_quit");
  expect(orchestrator.isRunning()).toBe(false);
  await started;
});
