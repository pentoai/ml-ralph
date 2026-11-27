/**
 * Tests for the worker helpers: --workers parsing, the conclusions merge, and
 * the lifecycle of the git worktrees (real git, throwaway repositories)
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runGit } from "./git.ts";
import {
  appendLogLine,
  findProjectDir,
  locateProject,
  WORKER_ENV,
} from "./log-command.ts";
import {
  checkWorktreeSupport,
  cleanStaleWorktrees,
  createWorktree,
  mergeConclusions,
  parseWorkers,
  removeWorktrees,
  splitConclusions,
  workerDir,
} from "./workers.ts";

describe("parseWorkers", () => {
  test("defaults to one worker and accepts 1 and 2", () => {
    expect(parseWorkers(undefined)).toEqual({ ok: true, workers: 1 });
    expect(parseWorkers("1")).toEqual({ ok: true, workers: 1 });
    expect(parseWorkers("2")).toEqual({ ok: true, workers: 2 });
  });

  test("refuses more than two, and anything that is not a positive integer", () => {
    const three = parseWorkers("3");
    expect(three.ok).toBe(false);
    if (!three.ok) expect(three.error).toContain("at most 2");
    for (const bad of ["0", "-1", "1.5", "two", "", "2x"]) {
      expect(parseWorkers(bad).ok).toBe(false);
    }
  });
});

describe("conclusions merge", () => {
  test("concatenates each worker's text under its tag and leaves out empty ones", () => {
    expect(
      mergeConclusions([
        { worker: 1, text: "A holds.\n" },
        { worker: 2, text: "B holds." },
      ]),
    ).toBe("[worker 1]\nA holds.\n\n[worker 2]\nB holds.");
    expect(
      mergeConclusions([
        { worker: 1, text: "" },
        { worker: 2, text: "B." },
      ]),
    ).toBe("[worker 2]\nB.");
    expect(mergeConclusions([{ worker: 1, text: " " }])).toBe("");
  });

  test("splitConclusions undoes the merge; untagged text belongs to worker 1", () => {
    const merged = mergeConclusions([
      { worker: 1, text: "one\nline two" },
      { worker: 2, text: "two" },
    ]);
    const parts = splitConclusions(merged);
    expect(parts.get(1)?.trim()).toBe("one\nline two");
    expect(parts.get(2)?.trim()).toBe("two");
    expect([...splitConclusions("plain claims")]).toEqual([
      [1, "plain claims"],
    ]);
    expect(splitConclusions("  ").size).toBe(0);
  });
});

describe("git worktrees", () => {
  let dir: string;
  const git = async (cwd: string, ...args: string[]) => {
    const r = await runGit(cwd, [
      "-c",
      "user.email=t@t",
      "-c",
      "user.name=t",
      "-c",
      "commit.gpgsign=false",
      ...args,
    ]);
    expect(r.code).toBe(0);
    return r.out.trim();
  };

  beforeEach(async () => {
    dir = await realpath(await mkdtemp(join(tmpdir(), "ml-ralph-workers-")));
    await git(dir, "init", "-q");
    await writeFile(join(dir, "train.py"), "v1\n");
    await mkdir(join(dir, ".ml-ralph"), { recursive: true });
    await writeFile(join(dir, ".ml-ralph/RALPH.md"), "# ralph\n");
    await writeFile(join(dir, ".ml-ralph/conclusions.md"), "main claims\n");
    await mkdir(join(dir, "data"), { recursive: true });
    await writeFile(join(dir, "data/train.csv"), "a,b\n");
    await git(dir, "add", "train.py");
    await git(dir, "commit", "-q", "-m", "v1");
  });

  afterEach(() => rm(dir, { recursive: true, force: true }));

  const worktreeList = async () =>
    (await git(dir, "worktree", "list", "--porcelain"))
      .split("\n")
      .filter((l) => l.startsWith("worktree "));

  test("a repository with no commit cannot host worktrees", async () => {
    const bare = await mkdtemp(join(tmpdir(), "ml-ralph-nogit-"));
    try {
      expect(await checkWorktreeSupport(bare)).toContain("git repository");
      await git(bare, "init", "-q");
      expect(await checkWorktreeSupport(bare)).toContain("at least one commit");
      expect(await checkWorktreeSupport(dir)).toBeNull();
    } finally {
      await rm(bare, { recursive: true, force: true });
    }
  });

  test("a worktree holds the tracked code, links the state and the data, and has its own conclusions", async () => {
    const wt = await createWorktree(dir, 1, {
      runId: "abcdef0123",
      conclusions: "my own claims",
    });
    expect(wt.dir).toBe(workerDir(dir, 1));
    expect(await readFile(join(wt.dir, "train.py"), "utf8")).toBe("v1\n");
    // The project's state is shared through links; conclusions.md is the worker's own
    expect(await readFile(join(wt.dir, ".ml-ralph/RALPH.md"), "utf8")).toBe(
      "# ralph\n",
    );
    expect(
      (await lstat(join(wt.dir, ".ml-ralph/RALPH.md"))).isSymbolicLink(),
    ).toBe(true);
    expect(
      await readFile(join(wt.dir, ".ml-ralph/conclusions.md"), "utf8"),
    ).toBe("my own claims");
    expect(await readFile(join(wt.dir, "data/train.csv"), "utf8")).toBe(
      "a,b\n",
    );
    // A log written through the worktree lands in the project's
    await appendLogLine(wt.dir, { type: "learning" });
    expect(await readFile(join(dir, ".ml-ralph/log.jsonl"), "utf8")).toContain(
      "learning",
    );
    // The links stay out of the worker's commits
    const status = async () => {
      const proc = Bun.spawn(["git", "status", "--porcelain"], {
        cwd: wt.dir,
        env: { ...process.env, ...wt.env },
        stdout: "pipe",
      });
      return (await new Response(proc.stdout).text()).trim();
    };
    expect(await status()).toBe("");
    expect(await git(dir, "status", "--porcelain")).toContain("data");
    // The worker's branch is its own
    expect(await git(wt.dir, "rev-parse", "--abbrev-ref", "HEAD")).toBe(
      wt.branch,
    );
  });

  test("the CLI tools find the real project from inside a worktree", async () => {
    const wt = await createWorktree(dir, 2, { runId: "r1", conclusions: "" });
    expect(await findProjectDir(wt.dir)).toBe(dir);
    expect(await findProjectDir(join(wt.dir, "data"))).toBe(dir);
    expect(await locateProject(wt.dir)).toEqual({
      projectDir: dir,
      workDir: wt.dir,
    });
    expect(await locateProject(dir)).toEqual({ projectDir: dir, workDir: dir });
  });

  test("events logged with the worker variable are tagged; an agent-chosen tag is not trusted", async () => {
    const before = process.env[WORKER_ENV];
    process.env[WORKER_ENV] = "2";
    try {
      await appendLogLine(dir, { type: "learning", insight: "x" });
    } finally {
      if (before === undefined) delete process.env[WORKER_ENV];
      else process.env[WORKER_ENV] = before;
    }
    await appendLogLine(dir, { type: "learning", insight: "y" });
    const lines = (await readFile(join(dir, ".ml-ralph/log.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    expect(lines[0].worker).toBe(2);
    expect(lines[1].worker).toBeUndefined();
  });

  test("removing worktrees deletes the directories but never what the links point at", async () => {
    const wts = [
      await createWorktree(dir, 1, { runId: "r1", conclusions: "" }),
      await createWorktree(dir, 2, { runId: "r1", conclusions: "" }),
    ];
    expect(await worktreeList()).toHaveLength(3);
    await removeWorktrees(dir, wts);
    expect(await worktreeList()).toHaveLength(1);
    expect(await readdir(join(dir, ".ml-ralph/worktrees"))).toEqual([]);
    expect(await readFile(join(dir, "data/train.csv"), "utf8")).toBe("a,b\n");
    expect(await readFile(join(dir, ".ml-ralph/RALPH.md"), "utf8")).toBe(
      "# ralph\n",
    );
    // The branches stay: the commits an eval scored must remain reachable
    expect(await git(dir, "branch", "--list", "ralph/*")).toContain("worker-1");
  });

  test("stale worktrees of a crashed run are cleaned, including one git no longer lists", async () => {
    await createWorktree(dir, 1, { runId: "r1", conclusions: "" });
    await createWorktree(dir, 2, { runId: "r1", conclusions: "" });
    // A crash can also leave a bare directory behind
    await mkdir(join(dir, ".ml-ralph/worktrees/worker-9"), { recursive: true });
    const removed = await cleanStaleWorktrees(dir);
    expect(removed).toHaveLength(3);
    expect(await worktreeList()).toHaveLength(1);
    expect(await readdir(join(dir, ".ml-ralph/worktrees"))).toEqual([]);
    expect(await readFile(join(dir, "data/train.csv"), "utf8")).toBe("a,b\n");
    expect(await cleanStaleWorktrees(dir)).toEqual([]);
  });
});
