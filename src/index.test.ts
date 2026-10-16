/**
 * Tests for the `ml-ralph log` entry point, run as a real process
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

let dir: string;
const logPath = () => join(dir, ".ml-ralph", "log.jsonl");

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "ml-ralph-cli-"));
  await mkdir(join(dir, ".ml-ralph"));
  await Bun.write(logPath(), "");
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const run = async (...args: string[]) => {
  const proc = Bun.spawn(["bun", join(import.meta.dir, "index.tsx"), ...args], {
    cwd: dir,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { stdout, stderr, code };
};

test("log appends a valid event and exits 0", async () => {
  const result = await run(
    "log",
    "phase",
    '{"phase":"EXECUTE","summary":"go"}',
  );
  expect(result.code).toBe(0);
  expect(JSON.parse(await Bun.file(logPath()).text()).type).toBe("phase");
});

test("log is not intercepted by -h or --help", async () => {
  for (const args of [
    ["log", "thinking", "-h"],
    ["log", "thinking", "--help"],
    ["log", "-h"],
    ["log", "--help"],
  ]) {
    const result = await run(...args);
    expect(result.code).not.toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).not.toContain("Keyboard shortcuts");
  }
  expect(await Bun.file(logPath()).text()).toBe("");
});

test("a help flag inside the event is data, not a request for help", async () => {
  const result = await run(
    "log",
    "phase",
    '{"phase":"EXECUTE","summary":"-h"}',
  );
  expect(result.code).toBe(0);
  expect(JSON.parse(await Bun.file(logPath()).text()).summary).toBe("-h");
});
