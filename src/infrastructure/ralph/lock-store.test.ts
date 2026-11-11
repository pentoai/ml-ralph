/**
 * Tests for the user-level eval lock store: gating, migration, resume, unlock, rekey
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  checkEvalGate,
  findEvalChanges,
  lockEvalContract,
  readEvalLock,
  readLockHashes,
} from "./eval-lock.ts";
import { runLockCommand } from "./lock-command.ts";
import {
  lockStoreFile,
  readStoredLock,
  rekeyStoredLock,
} from "./lock-store.ts";
import { RalphRunner } from "./runner.ts";

const CONTRACT = {
  primary_metric: "auc",
  direction: "max",
  search_split: "cv_5fold",
  seeds: [0, 1],
  protocol: "5-fold CV",
  success_threshold: 0.9,
  holdout_gap_threshold: 0.02,
  eval_timeout_seconds: 600,
  baseline_score: 0.8,
};

let dir: string;
const evalPath = (name: string) => join(dir, ".ml-ralph/eval", name);
const markerPath = () => join(dir, ".ml-ralph/eval-lock.created");

async function writePrd(status: string) {
  await Bun.write(
    join(dir, ".ml-ralph/prd.json"),
    JSON.stringify({ project: "p", status }),
  );
}

async function setupLocked() {
  await mkdir(join(dir, ".ml-ralph/eval"), { recursive: true });
  await Bun.write(join(dir, ".ml-ralph/RALPH.md"), "# ralph");
  await writePrd("approved");
  await Bun.write(evalPath("contract.json"), JSON.stringify(CONTRACT));
  await Bun.write(evalPath("evaluate.py"), "print('score')\n");
  expect((await lockEvalContract(dir)).ok).toBe(true);
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "ml-ralph-store-"));
  await setupLocked();
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("approval writes the store", () => {
  test("the project's entry holds the lock hashes", async () => {
    const lock = await readEvalLock(dir);
    const stored = await readStoredLock(dir);
    expect(stored?.files).toEqual(lock!.files);
    expect((await lockStoreFile(dir)).startsWith(dir)).toBe(false);
  });

  test("fails naming the store path when it cannot be written", async () => {
    await rm(evalPath("lock.json"));
    await rm(markerPath());
    const file = await lockStoreFile(dir);
    await rm(file);
    // A directory where the entry should be makes the atomic rename fail
    await mkdir(file, { recursive: true });
    const result = await lockEvalContract(dir);
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toContain(file);
    expect(await Bun.file(evalPath("lock.json")).exists()).toBe(false);
    await rm(file, { recursive: true });
  });
});

describe("deleting project copies", () => {
  test("a deleted lock.json does not re-lock and names the file", async () => {
    await rm(evalPath("lock.json"));
    const gate = await checkEvalGate(dir);
    expect(gate.ok).toBe(false);
    expect(gate.ok === false && gate.error).toContain("eval/lock.json");
    expect(await Bun.file(evalPath("lock.json")).exists()).toBe(false);
  });

  test("a deleted marker names the marker", async () => {
    await rm(markerPath());
    const gate = await checkEvalGate(dir);
    expect(gate.ok === false && gate.error).toContain("eval-lock.created");
  });

  test("resume restores both from the store", async () => {
    await rm(evalPath("lock.json"));
    await rm(markerPath());
    const result = await runLockCommand("resume", [], dir);
    expect(result.code).toBe(0);
    expect(await checkEvalGate(dir)).toEqual({ ok: true });
  });

  test("a rewritten lock.json that differs from the store refuses", async () => {
    await Bun.write(evalPath("evaluate.py"), "print('cheat')\n");
    await rm(evalPath("lock.json"));
    await rm(markerPath());
    await runLockCommand("resume", [], dir);
    const lock = await readEvalLock(dir);
    await Bun.write(
      evalPath("lock.json"),
      JSON.stringify({
        ...lock,
        files: { ...lock!.files, "evaluate.py": "0".repeat(64) },
      }),
    );
    expect((await checkEvalGate(dir)).ok).toBe(false);
  });
});

describe("gate and checks use the store", () => {
  test("a PRD set back to draft still gates as locked", async () => {
    await writePrd("draft");
    await rm(evalPath("lock.json"));
    const gate = await checkEvalGate(dir);
    expect(gate.ok).toBe(false);
    await rm(markerPath());
    expect((await checkEvalGate(dir)).ok).toBe(false);
  });

  test("hashes come from the store even when lock.json is rewritten", async () => {
    const stored = await readStoredLock(dir);
    await Bun.write(evalPath("evaluate.py"), "print('cheat')\n");
    const lock = await readEvalLock(dir);
    await Bun.write(
      evalPath("lock.json"),
      JSON.stringify({
        ...lock,
        files: { ...lock!.files, "evaluate.py": "1".repeat(64) },
      }),
    );
    expect(await readLockHashes(dir)).toEqual(stored!.files);
    expect(await findEvalChanges(dir, stored!.files)).toEqual([
      { file: "evaluate.py", kind: "edited" },
    ]);
  });

  test("a file edited between runs pauses the run at start, even with lock.json rewritten to match", async () => {
    await Bun.write(evalPath("evaluate.py"), "print('cheat')\n");
    // The agent also rewrites lock.json to match its edit
    const { createHash } = await import("node:crypto");
    const lock = await readEvalLock(dir);
    await Bun.write(
      evalPath("lock.json"),
      JSON.stringify({
        ...lock,
        files: {
          ...lock!.files,
          "evaluate.py": createHash("sha256")
            .update("print('cheat')\n")
            .digest("hex"),
        },
      }),
    );
    const pauses: string[][] = [];
    class Fake extends RalphRunner {
      iterations = 0;
      protected override async runIteration(): Promise<string> {
        this.iterations++;
        return "<iteration_complete>";
      }
    }
    const runner: Fake = new Fake({
      projectPath: dir,
      maxIterations: 1,
      onContractChanged: (changes) => {
        pauses.push(changes.map((c) => c.file));
        runner.resolveContractChange("stop");
      },
    });
    // The tamper check compares against the store, not the rewritten lock.json
    await runner.start();
    expect(runner.iterations).toBe(0);
    expect(pauses).toEqual([["evaluate.py"]]);
  });

  test("a file edited between runs, with lock.json intact, pauses against the store", async () => {
    await Bun.write(evalPath("evaluate.py"), "print('cheat')\n");
    const pauses: string[][] = [];
    class Fake extends RalphRunner {
      iterations = 0;
      protected override async runIteration(): Promise<string> {
        this.iterations++;
        return "<iteration_complete>";
      }
    }
    const runner: Fake = new Fake({
      projectPath: dir,
      maxIterations: 1,
      onContractChanged: (changes) => {
        pauses.push(changes.map((c) => c.file));
        runner.resolveContractChange("stop");
      },
    });
    await runner.start();
    expect(runner.iterations).toBe(0);
    expect(pauses).toEqual([["evaluate.py"]]);
  });
});

describe("migration", () => {
  /** Make the project look locked before the store: no store entry, no user_store flag */
  async function legacy() {
    const lock = await readEvalLock(dir);
    delete lock!.user_store;
    await Bun.write(evalPath("lock.json"), JSON.stringify(lock));
    await rm(markerPath());
    await rm(await lockStoreFile(dir));
  }

  test("copies the project lock into the store once and logs lock_migrated", async () => {
    const before = await readEvalLock(dir);
    await legacy();
    class Fake extends RalphRunner {
      protected override async runIteration(): Promise<string> {
        return "<iteration_complete>";
      }
    }
    await new Fake({ projectPath: dir, maxIterations: 1 }).start();

    expect((await readStoredLock(dir))?.files).toEqual(before!.files);
    const log = (await Bun.file(join(dir, ".ml-ralph/log.jsonl")).text())
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    expect(log.filter((e) => e.type === "lock_migrated")).toHaveLength(1);

    // Second start: already in the store, nothing more is logged
    await new Fake({ projectPath: dir, maxIterations: 1 }).start();
    const again = (await Bun.file(join(dir, ".ml-ralph/log.jsonl")).text())
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    expect(again.filter((e) => e.type === "lock_migrated")).toHaveLength(1);
  });
});

describe("moved project directory", () => {
  test("refuses, saying how to re-key or unlock; rekey fixes it", async () => {
    const oldDir = dir;
    const moved = await mkdtemp(join(tmpdir(), "ml-ralph-moved-"));
    await rm(moved, { recursive: true });
    const { rename } = await import("node:fs/promises");
    await rename(oldDir, moved);
    dir = moved;

    const gate = await checkEvalGate(dir);
    expect(gate.ok).toBe(false);
    const error = gate.ok === false ? gate.error : "";
    expect(error).toContain("ml-ralph rekey");
    expect(error).toContain("ml-ralph unlock");

    expect((await rekeyStoredLock(oldDir, dir)).ok).toBe(true);
    expect(await checkEvalGate(dir)).toEqual({ ok: true });
    expect(await readStoredLock(oldDir)).toBeNull();
  });
});

describe("unlock", () => {
  test("clears the store entry and project copies so the eval locks again", async () => {
    const result = await runLockCommand("unlock", [], dir);
    expect(result.code).toBe(0);
    expect(await readStoredLock(dir)).toBeNull();
    expect(await Bun.file(evalPath("lock.json")).exists()).toBe(false);
    expect(await Bun.file(markerPath()).exists()).toBe(false);
    // Approved PRD: the next gate locks the current files deliberately
    expect(await checkEvalGate(dir)).toEqual({ ok: true });
    expect(await readStoredLock(dir)).not.toBeNull();
  });
});
