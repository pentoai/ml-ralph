/**
 * End-to-end check of R9 with the real CLI (`bun src/index.tsx eval`) in
 * throwaway projects: the commit recorded by eval, the dirty-tree refusal, the
 * non-git warning, and the promotion gate's ralph/best tag against a real git repo.
 *
 * Run: bun test tests/eval-git.e2e.test.ts   (needs git and python on PATH)
 * The only stub is the independent verifier (it needs claude); git and tagging are real.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  lockEvalContract,
  readEvalLock,
} from "../src/infrastructure/ralph/eval-lock.ts";
import {
  judgeCandidate,
  type PromotionDeps,
  recordBaselineRef,
} from "../src/infrastructure/ralph/promotion.ts";

const CLI = join(import.meta.dir, "../src/index.tsx");
const CONTRACT = {
  primary_metric: "auc",
  direction: "max",
  search_split: "cv",
  holdout_split: "holdout",
  seeds: [0],
  protocol: "cv",
  success_threshold: 0.95,
  holdout_gap_threshold: 0.02,
  eval_timeout_seconds: 30,
  baseline_score: 0.5,
};
const EVALUATE = `import json
print(json.dumps({"score": 0.9}))
`;

let dir: string;

async function run(cmd: string[], cwd = dir) {
  const proc = Bun.spawn(cmd, { cwd, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { stdout: stdout.trim(), stderr: stderr.trim(), code };
}

const git = async (...args: string[]) => {
  const r = await run([
    "git",
    "-c",
    "user.email=t@t",
    "-c",
    "user.name=t",
    "-c",
    "commit.gpgsign=false",
    ...args,
  ]);
  expect(r.code).toBe(0);
  return r.stdout;
};
const evalCli = () => run(["bun", CLI, "eval", "cand.txt"]);

async function setupProject(withGit: boolean) {
  await mkdir(join(dir, ".ml-ralph/eval"), { recursive: true });
  await writeFile(
    join(dir, ".ml-ralph/prd.json"),
    JSON.stringify({ project: "p", status: "approved" }),
  );
  await writeFile(
    join(dir, ".ml-ralph/eval/contract.json"),
    JSON.stringify(CONTRACT),
  );
  await writeFile(join(dir, ".ml-ralph/eval/evaluate.py"), EVALUATE);
  await writeFile(join(dir, "cand.txt"), "x\n");
  await writeFile(join(dir, "model.py"), "v1\n");
  expect((await lockEvalContract(dir)).ok).toBe(true);
  if (withGit) {
    await git("init", "-q");
    await git("add", "model.py", "cand.txt");
    await git("commit", "-q", "-m", "v1");
  }
}

const events = async () =>
  (
    await Bun.file(join(dir, ".ml-ralph/log.jsonl"))
      .text()
      .catch(() => "")
  )
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Record<string, unknown>);
const evalIds = () =>
  readdir(join(dir, ".ml-ralph/evals")).catch(() => [] as string[]);
const metricsOf = (id: string) =>
  Bun.file(join(dir, ".ml-ralph/evals", id, "metrics.json")).json();

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "ml-ralph-e2e-"));
});
afterEach(() => rm(dir, { recursive: true, force: true }));

describe("ml-ralph eval CLI", () => {
  test("records HEAD in metrics.json and the eval event", async () => {
    await setupProject(true);
    const head = await git("rev-parse", "HEAD");
    const r = await evalCli();
    expect(r.code).toBe(0);
    const [id] = await evalIds();
    expect((await metricsOf(id!)).sha).toBe(head);
    expect((await events()).find((e) => e.type === "eval")?.sha).toBe(head);
  });

  test("a dirty tracked file exits non-zero and scores nothing", async () => {
    await setupProject(true);
    await writeFile(join(dir, "model.py"), "v2\n");
    const r = await evalCli();
    expect(r.code).not.toBe(0);
    expect(r.stderr).toContain("commit your changes before eval");
    expect(await evalIds()).toEqual([]);
    expect(await events()).toEqual([]);
  });

  test("outside a git repository it warns, records sha null and still scores", async () => {
    await setupProject(false);
    const r = await evalCli();
    expect(r.code).toBe(0);
    expect(r.stderr).toContain("warning: not a git repository");
    const [id] = await evalIds();
    const metrics = await metricsOf(id!);
    expect(metrics.sha).toBeNull();
    expect(metrics.status).toBe("ok");
  });
});

describe("promotion tags ralph/best", () => {
  const verify: PromotionDeps["verify"] = async () => ({
    id: "v-1",
    verdict: "approve",
    checks: { leakage: "pass", protocol_change: "pass", rubrics: "pass" },
    reason: "ok",
    outputPath: ".ml-ralph/verifier/v-1.json",
    feedback: "Verifier verdict: approve - ok",
  });

  async function promote() {
    await setupProject(true);
    await recordBaselineRef(dir);
    await writeFile(join(dir, "model.py"), "v2\n");
    await git("commit", "-q", "-am", "v2");
    const head = await git("rev-parse", "HEAD");
    await writeFile(
      join(dir, ".ml-ralph/log.jsonl"),
      `${JSON.stringify({ ts: new Date().toISOString(), type: "hypothesis", id: "H-1", claim: "c", expected_delta: 0.1, rubrics: ["r"], kill_criterion: "k" })}\n`,
    );
    const started = new Date(Date.now() - 1000).toISOString();
    const r = await evalCli();
    expect(r.code).toBe(0);
    const [id] = await evalIds();
    const lock = (await readEvalLock(dir))!;
    const decision = await judgeCandidate(
      {
        projectPath: dir,
        claimedEvalId: id!,
        iterationStartedAt: started,
        lockedFiles: lock.files,
      },
      { verify },
    );
    return { head, decision };
  }

  test("a promotion force-moves the tag to the promoted SHA", async () => {
    const { head, decision } = await promote();
    expect(decision.verdict).toBe("promoted");
    expect(await git("rev-parse", "ralph/best")).toBe(head);
    // A second promotion at a later commit moves the same tag
    await writeFile(join(dir, "model.py"), "v3\n");
    await git("commit", "-q", "-am", "v3");
    const r = await evalCli();
    expect(r.code).toBe(0);
    const ids = await evalIds();
    const newest = (
      await Promise.all(
        ids.map(async (i) => [i, (await metricsOf(i)).created_at] as const),
      )
    )
      .sort((a, b) => a[1].localeCompare(b[1]))
      .at(-1)![0];
    const lock = (await readEvalLock(dir))!;
    // Not better than the incumbent by more than noise (same score) -> rejected, tag stays on v2
    const second = await judgeCandidate(
      {
        projectPath: dir,
        claimedEvalId: newest,
        iterationStartedAt: new Date(Date.now() - 1000).toISOString(),
        lockedFiles: lock.files,
      },
      { verify },
    );
    expect(second.verdict).toBe("rejected");
    expect(await git("rev-parse", "ralph/best")).toBe(head);
  });

  test("a tagging failure logs tag_failed and the promotion stands", async () => {
    // refs/tags/ralph as a file makes refs/tags/ralph/best impossible to create
    await git("init", "-q");
    await mkdir(join(dir, ".git/refs/tags"), { recursive: true });
    await writeFile(join(dir, ".git/refs/tags/ralph"), "blocker\n");
    const { decision } = await promote();
    expect(decision.verdict).toBe("promoted");
    const failed = (await events()).find((e) => e.type === "tag_failed");
    expect(failed).toMatchObject({
      tag: "ralph/best",
      eval_id: expect.any(String),
    });
    expect(String(failed?.error).length).toBeGreaterThan(0);
    expect(await Bun.file(join(dir, ".ml-ralph/incumbent.json")).exists()).toBe(
      true,
    );
  });
});
