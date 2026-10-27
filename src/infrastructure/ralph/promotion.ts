/**
 * Promotion gate - the runner, not the agent, decides whether a candidate becomes the incumbent
 */

import { rename } from "node:fs/promises";
import {
  type EvalContract,
  validateEvalContract,
} from "../../domain/validation/index.ts";
import { type EvalLock, sha256 } from "./eval-lock.ts";
import {
  type EvalMetrics,
  type EvalMetricsOk,
  readEvalMetrics,
} from "./eval-metrics.ts";
import {
  appendValidatedEvent,
  type InvalidRunnerEvent,
} from "./log-command.ts";
import { readLogFile } from "./log-parser.ts";
import type {
  EvalEvent,
  HypothesisEvent,
  PromotionEvent,
} from "./templates.ts";
import { type VerifyCandidateOptions, verifyCandidate } from "./verifier.ts";

export const INCUMBENT_PATH = ".ml-ralph/incumbent.json";
export const BASELINE_PATH = ".ml-ralph/baseline.json";
const CONTRACT_PATH = ".ml-ralph/eval/contract.json";
const MAX_REASON_CHARS = 200;
const MAX_ID_CHARS = 100;

/** Pointer to the current best candidate; its score is read from the eval's metrics.json */
export interface Incumbent {
  eval_id: string;
  candidate: string;
  /** Git commit of the candidate, the base of the next verifier diff */
  ref: string;
  verifier_id: string;
  promoted_at: string;
}

export type GitHead = { ok: true; ref: string } | { ok: false; error: string };

export interface PromotionDeps {
  verify: typeof verifyCandidate;
  /**
   * The commit the candidate is at. With `requireClean` it also fails when
   * tracked files outside .ml-ralph/ have uncommitted changes, because the
   * verifier only sees committed refs.
   */
  gitHead: (projectPath: string, requireClean: boolean) => Promise<GitHead>;
}

export interface JudgeCandidateOptions {
  projectPath: string;
  /** The eval_id from the agent's <candidate_complete> tag; null when it had none */
  claimedEvalId: string | null;
  /** ISO time the iteration started; the eval must have been logged after it */
  iterationStartedAt: string;
  /** Hashes the runner pinned for this run; what the eval files must still match */
  lockedFiles: EvalLock["files"];
  /** Called when the runner's own promotion event fails its schema and is not logged */
  onInvalidEvent?: (invalid: InvalidRunnerEvent) => void;
}

type JudgeState = Partial<
  Pick<
    PromotionEvent,
    "incumbent_eval_id" | "verifier_id" | "candidate_mean" | "reference_mean"
  >
> & { promoted?: PromotedCandidate };

/** What the completion gate needs about a candidate that was just promoted */
export interface PromotedCandidate {
  evalId: string;
  /** Mean from the eval's metrics.json, never from the agent's events */
  searchScore: number;
  contract: EvalContract;
  /** Commit of the candidate */
  candidateRef: string;
  /** Commit the run started from; the completion verifier diffs against it */
  baselineRef: string;
  hypothesis: VerifyCandidateOptions["hypothesis"];
}

export interface PromotionDecision {
  verdict: PromotionEvent["verdict"];
  reason: string;
  /** Terse text for the agent's next prompt: the verdict and one line of reason */
  feedback: string;
  /** Set only when verdict is "promoted" */
  promoted?: PromotedCandidate;
}

/**
 * Find the last `<candidate_complete eval_id="...">` in the agent's output.
 * Returns null when the tag is absent; `evalId` is null when it has no eval_id.
 */
export function parseCandidateComplete(
  text: string,
): { evalId: string | null } | null {
  const tags = [...text.matchAll(/<candidate_complete(\s[^<>]*)?>/g)];
  const last = tags.at(-1);
  if (!last) return null;
  const id = last[1]?.match(/\beval_id\s*=\s*(?:"([^"]*)"|'([^']*)')/);
  return { evalId: id?.[1] || id?.[2] || null };
}

/**
 * The scoring rule: the candidate must beat the reference by more than the
 * larger of the two seed stds, in the contract's direction.
 */
export function decideOnScore(input: {
  direction: EvalContract["direction"];
  candidateMean: number;
  candidateStd: number;
  referenceMean: number;
  /** Std of the incumbent's seeds; 0 when the reference is the baseline score */
  referenceStd: number;
}): { beats: boolean; improvement: number; margin: number } {
  const improvement =
    input.direction === "max"
      ? input.candidateMean - input.referenceMean
      : input.referenceMean - input.candidateMean;
  const margin = Math.max(input.candidateStd, input.referenceStd);
  return { beats: improvement > margin, improvement, margin };
}

/** Read incumbent.json: "none" when absent, "invalid" when it exists but is unusable */
export async function readIncumbent(
  projectPath: string,
): Promise<
  | { state: "none" }
  | { state: "invalid" }
  | { state: "ok"; incumbent: Incumbent }
> {
  const file = Bun.file(`${projectPath}/${INCUMBENT_PATH}`);
  if (!(await file.exists())) return { state: "none" };
  try {
    const value = (await file.json()) as Partial<Incumbent> | null;
    const ok =
      typeof value?.eval_id === "string" &&
      typeof value.candidate === "string" &&
      typeof value.ref === "string" &&
      typeof value.verifier_id === "string" &&
      typeof value.promoted_at === "string";
    return ok
      ? { state: "ok", incumbent: value as Incumbent }
      : { state: "invalid" };
  } catch {
    return { state: "invalid" };
  }
}

async function runGit(
  projectPath: string,
  args: string[],
): Promise<{ code: number; out: string; err: string }> {
  try {
    const proc = Bun.spawn(["git", ...args], {
      cwd: projectPath,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [out, err, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return { code, out, err };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { code: 1, out: "", err: message };
  }
}

export const defaultGitHead: PromotionDeps["gitHead"] = async (
  projectPath,
  requireClean,
) => {
  const head = await runGit(projectPath, ["rev-parse", "--verify", "HEAD"]);
  if (head.code !== 0) {
    return {
      ok: false,
      error: `no git commit to compare (${head.err.trim().slice(-120)})`,
    };
  }
  if (requireClean) {
    const status = await runGit(projectPath, [
      "status",
      "--porcelain",
      "--untracked-files=no",
      "--",
      ".",
      ":(exclude).ml-ralph",
    ]);
    if (status.code !== 0 || status.out.trim()) {
      return {
        ok: false,
        error:
          "tracked files have uncommitted changes; commit the candidate first",
      };
    }
  }
  return { ok: true, ref: head.out.trim() };
};

/**
 * Remember the commit the run started from, once, so the first candidate's
 * diff is taken against the code the baseline score belongs to.
 */
export async function recordBaselineRef(
  projectPath: string,
  gitHead: PromotionDeps["gitHead"] = defaultGitHead,
): Promise<void> {
  if (await Bun.file(`${projectPath}/${BASELINE_PATH}`).exists()) return;
  const head = await gitHead(projectPath, false);
  if (!head.ok) return;
  await Bun.write(
    `${projectPath}/${BASELINE_PATH}`,
    `${JSON.stringify({ ref: head.ref, recorded_at: new Date().toISOString() }, null, 2)}\n`,
  );
}

async function readBaselineRef(projectPath: string): Promise<string | null> {
  try {
    const value = (await Bun.file(
      `${projectPath}/${BASELINE_PATH}`,
    ).json()) as {
      ref?: unknown;
    } | null;
    return typeof value?.ref === "string" && value.ref ? value.ref : null;
  } catch {
    return null;
  }
}

const oneLine = (text: string) => {
  const line = (text.split("\n").find((l) => l.trim()) ?? "").trim();
  return line.length > MAX_REASON_CHARS
    ? `${line.slice(0, MAX_REASON_CHARS - 3)}...`
    : line;
};

const fmt = (n: number) => String(Number(n.toPrecision(6)));

const withinLock = (m: EvalMetrics, files: EvalLock["files"]) =>
  m.contract_hash === files["contract.json"] &&
  m.evaluate_hash === files["evaluate.py"];

/**
 * Decide on a `<candidate_complete>` and log a `promotion` event with the
 * evidence. Promotes (and points .ml-ralph/incumbent.json at the candidate)
 * only when all of these hold:
 *
 * - the eval is in the runner's own `eval` events from this iteration and its
 *   metrics.json says `status: "ok"` under the current lock;
 * - the committed candidate, diffed against the incumbent (or the baseline
 *   commit), is approved by the independent verifier;
 * - its mean beats the incumbent's mean (or `baseline_score` with no incumbent)
 *   by more than the larger of the two seed stds, in the contract's direction.
 *
 * Scores and the eval id come only from the runner's `eval` event and
 * `.ml-ralph/evals/<id>/metrics.json`, never from the agent's experiment event.
 * Every failure to establish a fact rejects; nothing here throws.
 */
export async function judgeCandidate(
  options: JudgeCandidateOptions,
  deps: Partial<PromotionDeps> = {},
): Promise<PromotionDecision> {
  const { projectPath, claimedEvalId } = options;
  const state: JudgeState = {};

  const finish = async (
    verdict: PromotionEvent["verdict"],
    reason: string,
  ): Promise<PromotionDecision> => {
    const text = oneLine(reason);
    const event: Omit<PromotionEvent, "ts"> = {
      type: "promotion",
      verdict,
      reason: text,
      ...(claimedEvalId
        ? { candidate_eval_id: claimedEvalId.slice(0, MAX_ID_CHARS) }
        : {}),
      ...(state.incumbent_eval_id
        ? { incumbent_eval_id: state.incumbent_eval_id }
        : {}),
      ...(state.verifier_id ? { verifier_id: state.verifier_id } : {}),
      ...(state.candidate_mean !== undefined
        ? { candidate_mean: state.candidate_mean }
        : {}),
      ...(state.reference_mean !== undefined
        ? { reference_mean: state.reference_mean }
        : {}),
    };
    try {
      await appendValidatedEvent(projectPath, event, options.onInvalidEvent);
    } catch {
      // The decision stands even if the log line could not be written
    }
    return {
      verdict,
      reason: text,
      feedback: `Runner decision on ${claimedEvalId ? JSON.stringify(claimedEvalId.slice(0, MAX_ID_CHARS)) : "your candidate"}: ${verdict} - ${text}`,
      ...(verdict === "promoted" && state.promoted
        ? { promoted: state.promoted }
        : {}),
    };
  };

  try {
    return await judge(options, deps, state, finish);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return finish("rejected", `promotion check failed: ${message}`);
  }
}

async function judge(
  options: JudgeCandidateOptions,
  deps: Partial<PromotionDeps>,
  state: JudgeState,
  finish: (
    verdict: PromotionEvent["verdict"],
    reason: string,
  ) => Promise<PromotionDecision>,
): Promise<PromotionDecision> {
  const { projectPath, claimedEvalId, iterationStartedAt, lockedFiles } =
    options;
  const verify = deps.verify ?? verifyCandidate;
  const gitHead = deps.gitHead ?? defaultGitHead;
  const reject = (reason: string) => finish("rejected", reason);

  if (!claimedEvalId) {
    return reject(
      'candidate_complete needs the eval it is based on: <candidate_complete eval_id="...">',
    );
  }

  // The runner's own record of the eval, from this iteration
  const events = await readLogFile(projectPath);
  const evalEvent = events.find(
    (e): e is EvalEvent =>
      e.type === "eval" &&
      e.eval_id === claimedEvalId &&
      e.ts >= iterationStartedAt,
  );
  if (!evalEvent) {
    return reject(
      "no eval with that eval_id was run in this iteration; run ml-ralph eval on the candidate first",
    );
  }
  const metrics = await readEvalMetrics(projectPath, claimedEvalId);
  if (!metrics) return reject("the eval has no readable metrics.json");
  if (metrics.status !== "ok" || evalEvent.status !== "ok") {
    return reject(
      metrics.status === "failed"
        ? `the eval failed: ${metrics.reason}`
        : "the eval did not finish with status ok",
    );
  }
  if (!withinLock(metrics, lockedFiles)) {
    return reject(
      "the eval was scored under a different eval lock; run it again",
    );
  }

  // contract.json decides direction and baseline; trust it only while it matches the lock
  let contract: EvalContract;
  try {
    const bytes = new Uint8Array(
      await Bun.file(`${projectPath}/${CONTRACT_PATH}`).arrayBuffer(),
    );
    if (sha256(bytes) !== lockedFiles["contract.json"]) {
      return reject("contract.json no longer matches the eval lock");
    }
    const validation = validateEvalContract(
      JSON.parse(new TextDecoder().decode(bytes)),
    );
    if (!validation.valid) return reject("contract.json is invalid");
    contract = validation.contract;
  } catch {
    return reject("contract.json could not be read");
  }

  // The incumbent, with its score from its own metrics.json
  let incumbent: Incumbent | null = null;
  let incumbentMetrics: EvalMetricsOk | null = null;
  let staleNote = "";
  const stored = await readIncumbent(projectPath);
  if (stored.state === "invalid") {
    return reject(
      "incumbent.json is unreadable, so there is nothing to compare with",
    );
  }
  if (stored.state === "ok") {
    const found = await readEvalMetrics(projectPath, stored.incumbent.eval_id);
    if (found?.status !== "ok") {
      return reject(
        `the incumbent's eval ${stored.incumbent.eval_id} has no usable metrics.json`,
      );
    }
    if (withinLock(found, lockedFiles)) {
      incumbent = stored.incumbent;
      incumbentMetrics = found;
      state.incumbent_eval_id = incumbent.eval_id;
    } else {
      staleNote = `incumbent ${stored.incumbent.eval_id} was scored under an earlier lock and is ignored; `;
    }
  }

  const referenceMean = incumbentMetrics?.mean ?? contract.baseline_score;
  const referenceName = incumbentMetrics
    ? `incumbent ${incumbentMetrics.eval_id}`
    : "baseline_score";
  state.candidate_mean = metrics.mean;
  state.reference_mean = referenceMean;

  const score = decideOnScore({
    direction: contract.direction,
    candidateMean: metrics.mean,
    candidateStd: metrics.std,
    referenceMean,
    referenceStd: incumbentMetrics?.std ?? 0,
  });
  const scoreText = `mean ${fmt(metrics.mean)} vs ${referenceName} ${fmt(referenceMean)} (${contract.direction === "max" ? "higher" : "lower"} is better): improvement ${fmt(score.improvement)}, seed noise ${fmt(score.margin)}`;
  if (!score.beats) {
    return reject(
      `${staleNote}${scoreText}; not better by more than the seed noise`,
    );
  }

  // Only a candidate that already wins on score is worth a verifier session
  const head = await gitHead(projectPath, true);
  if (!head.ok) return reject(head.error);
  const baselineRef = await readBaselineRef(projectPath);
  const referenceRef = incumbent?.ref ?? baselineRef;
  if (!referenceRef) {
    return reject(
      "no baseline commit was recorded, so there is nothing to diff against",
    );
  }

  const hypothesis = pickHypothesis(events, iterationStartedAt);
  if (!hypothesis) {
    return reject("no hypothesis with rubrics was logged for this candidate");
  }

  const verifierOptions: VerifyCandidateOptions = {
    projectPath,
    hypothesis,
    candidateRef: head.ref,
    baselineRef: baselineRef ?? referenceRef,
    ...(incumbent ? { incumbentRef: incumbent.ref } : {}),
  };
  const verdict = await verify(verifierOptions);
  state.verifier_id = verdict.id;
  if (verdict.verdict !== "approve") return reject(verdict.feedback);

  const promoted: Incumbent = {
    eval_id: metrics.eval_id,
    candidate: metrics.candidate,
    ref: head.ref,
    verifier_id: verdict.id,
    promoted_at: new Date().toISOString(),
  };
  const tmp = `${projectPath}/${INCUMBENT_PATH}.tmp`;
  await Bun.write(tmp, `${JSON.stringify(promoted, null, 2)}\n`);
  await rename(tmp, `${projectPath}/${INCUMBENT_PATH}`);
  state.promoted = {
    evalId: metrics.eval_id,
    searchScore: metrics.mean,
    contract,
    candidateRef: head.ref,
    baselineRef: baselineRef ?? referenceRef,
    hypothesis,
  };
  return finish("promoted", `${staleNote}${scoreText}; verifier approved`);
}

/**
 * The rubrics the verifier applies: those of every hypothesis logged during
 * this iteration (so citing one weak hypothesis does not drop a strict one),
 * or of the most recent hypothesis when none was logged in it.
 */
function pickHypothesis(
  events: Awaited<ReturnType<typeof readLogFile>>,
  iterationStartedAt: string,
): VerifyCandidateOptions["hypothesis"] | null {
  const hypotheses = events.filter(
    (e): e is HypothesisEvent =>
      e.type === "hypothesis" &&
      Array.isArray(e.rubrics) &&
      e.rubrics.length > 0,
  );
  const recent = hypotheses.filter((h) => h.ts >= iterationStartedAt);
  const chosen = recent.length > 0 ? recent : hypotheses.slice(-1);
  if (chosen.length === 0) return null;
  return {
    id: chosen.map((h) => h.id).join(", "),
    hypothesis: chosen
      .map((h) => `${h.id}: ${h.claim ?? h.hypothesis ?? ""}`)
      .join("\n"),
    rubrics: chosen.flatMap((h) => h.rubrics),
  };
}
