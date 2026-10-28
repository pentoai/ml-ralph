/**
 * Tests for ML-Ralph initialization
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { ensureInitialized, initRalph } from "./init.ts";
import { RALPH_MD } from "./templates.ts";

const CLI_ENTRY = join(import.meta.dir, "../../index.tsx");

const BASE_FILES = [
  ".claude/skills/ml-ralph/SKILL.md",
  ".codex/skills/ml-ralph/SKILL.md",
  ".ml-ralph/RALPH.md",
  ".ml-ralph/conclusions.md",
  ".ml-ralph/config.json",
  ".ml-ralph/kanban.json",
  ".ml-ralph/log.jsonl",
  ".ml-ralph/prd.json",
  ".ml-ralph/runs/active.json",
  "AGENTS.md",
  "CLAUDE.md",
];

async function listFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true });
  return entries
    .filter((e) => e.isFile())
    .map((e) => relative(dir, join(e.parentPath, e.name)))
    .sort();
}

describe("initRalph", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "ml-ralph-init-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test("creates the full set of files", async () => {
    const result = await initRalph({ projectPath: dir, name: "demo" });

    expect(result.success).toBe(true);
    expect(await listFiles(dir)).toEqual(BASE_FILES);
    expect(result.filesCreated.map((f) => relative(dir, f)).sort()).toEqual(
      BASE_FILES,
    );

    const config = await Bun.file(`${dir}/.ml-ralph/config.json`).json();
    expect(config.name).toBe("demo");
    const prd = await Bun.file(`${dir}/.ml-ralph/prd.json`).json();
    expect(prd.project).toBe("demo");
  });

  test("--teams also writes .claude/settings.json", async () => {
    await initRalph({ projectPath: dir, name: "demo", enableTeams: true });

    expect(await listFiles(dir)).toEqual(
      [...BASE_FILES, ".claude/settings.json"].sort(),
    );
    const settings = await Bun.file(`${dir}/.claude/settings.json`).json();
    expect(settings.env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS).toBe("1");
  });

  test("second run without force keeps user edits", async () => {
    await initRalph({ projectPath: dir, name: "demo" });
    const edited = [
      ".ml-ralph/RALPH.md",
      ".ml-ralph/conclusions.md",
      ".ml-ralph/config.json",
      ".ml-ralph/prd.json",
      "CLAUDE.md",
      "AGENTS.md",
      ".claude/skills/ml-ralph/SKILL.md",
    ];
    for (const file of edited) {
      await Bun.write(`${dir}/${file}`, `edited ${file}`);
    }

    const result = await initRalph({ projectPath: dir, name: "other" });

    expect(result.success).toBe(true);
    expect(result.filesCreated).toEqual([]);
    for (const file of edited) {
      expect(await Bun.file(`${dir}/${file}`).text()).toBe(`edited ${file}`);
    }
  });

  test("force overwrites existing files", async () => {
    await initRalph({ projectPath: dir, name: "demo" });
    await Bun.write(`${dir}/.ml-ralph/RALPH.md`, "edited");

    await initRalph({ projectPath: dir, name: "demo", force: true });

    expect(await Bun.file(`${dir}/.ml-ralph/RALPH.md`).text()).toBe(RALPH_MD);
  });

  test("force keeps existing runtime data", async () => {
    await initRalph({ projectPath: dir, name: "demo" });
    const data = [
      ".ml-ralph/log.jsonl",
      ".ml-ralph/prd.json",
      ".ml-ralph/kanban.json",
      ".ml-ralph/config.json",
      ".ml-ralph/runs/active.json",
    ];
    for (const file of data) {
      await Bun.write(`${dir}/${file}`, `data ${file}`);
    }
    for (const file of [".ml-ralph/RALPH.md", "CLAUDE.md", "AGENTS.md"]) {
      await Bun.write(`${dir}/${file}`, "edited");
    }

    await initRalph({ projectPath: dir, name: "demo", force: true });

    for (const file of data) {
      expect(await Bun.file(`${dir}/${file}`).text()).toBe(`data ${file}`);
    }
    expect(await Bun.file(`${dir}/.ml-ralph/RALPH.md`).text()).toBe(RALPH_MD);
    expect(await Bun.file(`${dir}/CLAUDE.md`).text()).not.toBe("edited");
    expect(await Bun.file(`${dir}/AGENTS.md`).text()).not.toBe("edited");
  });

  test("keeps a pre-existing CLAUDE.md and fills in the rest", async () => {
    await Bun.write(`${dir}/CLAUDE.md`, "mine");

    const result = await initRalph({ projectPath: dir, name: "demo" });

    expect(result.success).toBe(true);
    expect(await Bun.file(`${dir}/CLAUDE.md`).text()).toBe("mine");
    expect(await listFiles(dir)).toEqual(BASE_FILES);
  });
});

describe("ensureInitialized", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "ml-ralph-ensure-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test("adds config.json and runs/ to a project that already has RALPH.md", async () => {
    await Bun.write(`${dir}/.ml-ralph/RALPH.md`, "mine");

    expect(await ensureInitialized(dir)).toBe(true);

    expect(await Bun.file(`${dir}/.ml-ralph/RALPH.md`).text()).toBe("mine");
    expect(await Bun.file(`${dir}/.ml-ralph/config.json`).exists()).toBe(true);
    expect(await Bun.file(`${dir}/.ml-ralph/runs/active.json`).exists()).toBe(
      true,
    );
    expect(await Bun.file(`${dir}/CLAUDE.md`).exists()).toBe(false);
  });

  test("first launch matches init output (plus teams settings)", async () => {
    expect(await ensureInitialized(dir)).toBe(true);

    expect(await listFiles(dir)).toEqual(
      [...BASE_FILES, ".claude/settings.json"].sort(),
    );
  });
});

describe("ml-ralph init CLI", () => {
  test("produces the same files as the TUI first launch", async () => {
    const cliDir = await mkdtemp(join(tmpdir(), "ml-ralph-cli-"));
    const tuiDir = await mkdtemp(join(tmpdir(), "ml-ralph-tui-"));
    try {
      const proc = Bun.spawn(
        ["bun", "run", CLI_ENTRY, "init", "demo", cliDir, "--teams"],
        { stdout: "pipe", stderr: "pipe" },
      );
      expect(await proc.exited).toBe(0);
      await ensureInitialized(tuiDir);

      expect(await listFiles(cliDir)).toEqual(await listFiles(tuiDir));
      expect(await listFiles(cliDir)).toContain(".claude/settings.json");
    } finally {
      await rm(cliDir, { recursive: true, force: true });
      await rm(tuiDir, { recursive: true, force: true });
    }
  });
});
