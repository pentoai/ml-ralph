/**
 * Tests for log-parser: aggregateEvents, readLogFile, appendEvent
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  aggregateEvents,
  appendEvent,
  readKanbanFile,
  readLogFile,
  readPrdFile,
} from "./log-parser.ts";
import type { RalphEvent } from "./templates.ts";

const ev = (e: Record<string, unknown>) => e as unknown as RalphEvent;

const hypothesis = (id: string, ts: string, extra = {}) =>
  ev({
    type: "hypothesis",
    ts,
    id,
    hypothesis: `Hypothesis ${id}`,
    expected: "+2% AUC",
    ...extra,
  });

const experiment = (hypothesisId: string, name = "exp") =>
  ev({
    type: "experiment",
    ts: "2026-01-01T00:10:00Z",
    name,
    hypothesis_id: hypothesisId,
    metrics: { auc: 0.9 },
  });

describe("aggregateEvents", () => {
  test("empty input gives an empty summary", () => {
    expect(aggregateEvents([])).toEqual({
      hypotheses: [],
      experiments: [],
      learnings: [],
      research: [],
      prdChanges: [],
      currentPhase: null,
      phases: [],
      latestStatus: null,
    });
  });

  test("phase events are collected and the latest is current", () => {
    const events = [
      ev({ type: "phase", ts: "1", phase: "UNDERSTAND", summary: "a" }),
      ev({ type: "phase", ts: "2", phase: "STRATEGIZE", summary: "b" }),
      ev({ type: "phase", ts: "3", phase: "EXECUTE", summary: "c" }),
    ];
    const summary = aggregateEvents(events);
    expect(summary.phases).toHaveLength(3);
    expect(summary.currentPhase).toBe("EXECUTE");
  });

  test("hypothesis starts pending with no experiments", () => {
    const summary = aggregateEvents([hypothesis("H1", "2026-01-01T00:00:00Z")]);
    expect(summary.hypotheses).toEqual([
      {
        id: "H1",
        hypothesis: "Hypothesis H1",
        expected: "+2% AUC",
        status: "pending",
        experiments: [],
        createdAt: "2026-01-01T00:00:00Z",
      },
    ]);
  });

  test("typed hypothesis shows its claim and expected delta", () => {
    const summary = aggregateEvents([
      ev({
        type: "hypothesis",
        ts: "1",
        id: "H1",
        claim: "Time features help",
        expected_delta: 0.05,
        rubrics: ["Split unchanged"],
        kill_criterion: "Gain below 0.01",
      }),
    ]);
    expect(summary.hypotheses[0]).toMatchObject({
      hypothesis: "Time features help",
      expected: "Δ +0.05",
      rubrics: ["Split unchanged"],
      killCriterion: "Gain below 0.01",
    });
  });

  test("experiments are listed and attached to their hypothesis", () => {
    const summary = aggregateEvents([
      hypothesis("H1", "1"),
      experiment("H1", "a"),
      experiment("H1", "b"),
    ]);
    expect(summary.experiments.map((e) => e.name)).toEqual(["a", "b"]);
    expect(summary.hypotheses[0]?.experiments).toHaveLength(2);
  });

  test("experiment for an unknown hypothesis is kept in the flat list only", () => {
    const summary = aggregateEvents([experiment("H404")]);
    expect(summary.experiments).toHaveLength(1);
    expect(summary.hypotheses).toEqual([]);
  });

  test("decision updates hypothesis status for each action", () => {
    for (const action of ["keep", "reject", "iterate", "pivot"] as const) {
      const decision = ev({
        type: "decision",
        ts: "2",
        hypothesis_id: "H1",
        action,
        reason: "because",
      });
      const summary = aggregateEvents([hypothesis("H1", "1"), decision]);
      expect(summary.hypotheses[0]?.status).toBe(action);
      expect(summary.hypotheses[0]?.decision).toMatchObject(decision);
    }
  });

  test("decision for an unknown hypothesis is ignored", () => {
    const summary = aggregateEvents([
      ev({
        type: "decision",
        ts: "2",
        hypothesis_id: "nope",
        action: "keep",
        reason: "r",
      }),
    ]);
    expect(summary.hypotheses).toEqual([]);
  });

  test("the last decision wins", () => {
    const decide = (action: string) =>
      ev({
        type: "decision",
        ts: "2",
        hypothesis_id: "H1",
        action,
        reason: "",
      });
    const summary = aggregateEvents([
      hypothesis("H1", "1"),
      decide("iterate"),
      decide("keep"),
    ]);
    expect(summary.hypotheses[0]?.status).toBe("keep");
  });

  test("re-logging a hypothesis id resets it to pending", () => {
    const summary = aggregateEvents([
      hypothesis("H1", "1"),
      experiment("H1"),
      ev({
        type: "decision",
        ts: "2",
        hypothesis_id: "H1",
        action: "keep",
        reason: "",
      }),
      hypothesis("H1", "3", { hypothesis: "Revised" }),
    ]);
    expect(summary.hypotheses).toHaveLength(1);
    expect(summary.hypotheses[0]).toMatchObject({
      hypothesis: "Revised",
      status: "pending",
      experiments: [],
    });
  });

  test("hypotheses are sorted by creation time", () => {
    const summary = aggregateEvents([
      hypothesis("H2", "2026-01-02T00:00:00Z"),
      hypothesis("H1", "2026-01-01T00:00:00Z"),
      hypothesis("H3", "2026-01-03T00:00:00Z"),
    ]);
    expect(summary.hypotheses.map((h) => h.id)).toEqual(["H1", "H2", "H3"]);
  });

  test("learning and research events are collected in order", () => {
    const summary = aggregateEvents([
      ev({ type: "learning", ts: "1", insight: "L1" }),
      ev({ type: "research", ts: "2", source: "arxiv", insight: "R1" }),
      ev({ type: "learning", ts: "3", insight: "L2", source: "exp" }),
    ]);
    expect(summary.learnings.map((l) => l.insight)).toEqual(["L1", "L2"]);
    expect(summary.research.map((r) => r.insight)).toEqual(["R1"]);
  });

  test("prd_updated maps to prdChanges", () => {
    const summary = aggregateEvents([
      ev({
        type: "prd_updated",
        ts: "t",
        field: "success_criteria",
        change: "AUC > 0.9",
        reason: "baseline too low",
      }),
    ]);
    expect(summary.prdChanges).toEqual([
      {
        ts: "t",
        field: "success_criteria",
        change: "AUC > 0.9",
        reason: "baseline too low",
      },
    ]);
  });

  test("latest status event wins", () => {
    const status = (s: string) => ev({ type: "status", ts: "1", status: s });
    expect(
      aggregateEvents([status("running"), status("paused")]).latestStatus,
    ).toBe("paused");
    expect(
      aggregateEvents([status("paused"), status("complete")]).latestStatus,
    ).toBe("complete");
  });

  test("event types without a summary slot do not affect the summary", () => {
    const ignored = [
      { type: "thinking", subject: "s", thoughts: "t", conclusion: "c" },
      {
        type: "mental_model",
        domain: "d",
        belief: "b",
        confidence: "high",
        evidence: [],
      },
      { type: "path_analysis", paths: [], chosen: "a", rationale: "r" },
      {
        type: "data_verified",
        dataset: "d",
        checks: [],
        issues: [],
        action: "a",
      },
      {
        type: "result_verification",
        result: "r",
        verification_attempts: [],
        conclusion: "c",
      },
      {
        type: "success_verified",
        criteria_met: [],
        verification_checks: [],
        attempts_to_break: [],
        conclusion: "c",
      },
      { type: "strategic_retreat", trigger: "t", action: "a", focus: "f" },
      { type: "kanban_updated", changes: "c", reason: "r" },
      {
        type: "verifier_verdict",
        id: "v1",
        verdict: "reject",
        checks: { leakage: "fail", protocol_change: "pass", rubrics: "pass" },
        reason: "r",
        output_path: ".ml-ralph/verifier/v1.json",
      },
      { type: "parallel_start", team: "t", hypotheses: [], reason: "r" },
      {
        type: "parallel_result",
        hypothesis_id: "H1",
        agent: "a",
        metrics: {},
        branch: "b",
      },
      {
        type: "parallel_synthesis",
        winner: "H1",
        reason: "r",
        merged_branch: "b",
      },
    ].map((e) => ev({ ts: "1", ...e }));

    expect(aggregateEvents(ignored)).toEqual(aggregateEvents([]));
  });

  test("unknown event types are ignored", () => {
    const summary = aggregateEvents([
      ev({ type: "totally_new", ts: "1" }),
      ev({ type: "learning", ts: "2", insight: "kept" }),
    ]);
    expect(summary.learnings).toHaveLength(1);
  });

  test("a realistic research loop builds the full living plan", () => {
    const summary = aggregateEvents([
      ev({ type: "status", ts: "0", status: "running" }),
      ev({ type: "phase", ts: "1", phase: "UNDERSTAND", summary: "s" }),
      hypothesis("H1", "2"),
      ev({ type: "phase", ts: "3", phase: "EXECUTE", summary: "s" }),
      experiment("H1"),
      ev({ type: "learning", ts: "5", insight: "feature X matters" }),
      ev({
        type: "decision",
        ts: "6",
        hypothesis_id: "H1",
        action: "keep",
        reason: "r",
      }),
      ev({ type: "phase", ts: "7", phase: "REFLECT", summary: "s" }),
    ]);
    expect(summary.latestStatus).toBe("running");
    expect(summary.currentPhase).toBe("REFLECT");
    expect(summary.hypotheses[0]).toMatchObject({
      status: "keep",
      experiments: [expect.objectContaining({ name: "exp" })],
    });
    expect(summary.learnings).toHaveLength(1);
  });
});

describe("log file I/O", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "ml-ralph-log-"));
    await mkdir(join(dir, ".ml-ralph"), { recursive: true });
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const logPath = () => join(dir, ".ml-ralph", "log.jsonl");

  test("readLogFile returns [] when the log does not exist", async () => {
    expect(await readLogFile(dir)).toEqual([]);
  });

  test("readLogFile returns [] when the project directory does not exist", async () => {
    expect(await readLogFile(join(dir, "missing"))).toEqual([]);
  });

  test("readLogFile skips malformed and blank lines", async () => {
    const good1 = { ts: "1", type: "learning", insight: "a" };
    const good2 = { ts: "2", type: "learning", insight: "b" };
    await Bun.write(
      logPath(),
      [
        JSON.stringify(good1),
        "",
        "not json at all",
        '{"ts":"x","type":"learning","insi',
        "   ",
        JSON.stringify(good2),
        "",
      ].join("\n"),
    );
    expect(await readLogFile(dir)).toEqual([good1, good2] as RalphEvent[]);
  });

  test("readLogFile tolerates CRLF line endings", async () => {
    const e = { ts: "1", type: "learning", insight: "a" };
    await Bun.write(
      logPath(),
      `${JSON.stringify(e)}\r\n${JSON.stringify(e)}\r\n`,
    );
    expect(await readLogFile(dir)).toHaveLength(2);
  });

  test("appendEvent creates the log file and returns true", async () => {
    const ok = await appendEvent(dir, {
      type: "learning",
      insight: "first",
    } as Omit<RalphEvent, "ts">);
    expect(ok).toBe(true);
    const events = await readLogFile(dir);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: "learning", insight: "first" });
  });

  test("appendEvent adds an ISO timestamp", async () => {
    const before = Date.now();
    await appendEvent(dir, {
      type: "status",
      status: "running",
    } as Omit<RalphEvent, "ts">);
    const [event] = await readLogFile(dir);
    const ts = Date.parse(event?.ts ?? "");
    expect(Number.isNaN(ts)).toBe(false);
    expect(ts).toBeGreaterThanOrEqual(before);
    expect(event?.ts).toBe(new Date(ts).toISOString());
  });

  test("appendEvent writes one JSON object per line and keeps order", async () => {
    for (const insight of ["a", "b", "c"]) {
      await appendEvent(dir, { type: "learning", insight } as Omit<
        RalphEvent,
        "ts"
      >);
    }
    const text = await Bun.file(logPath()).text();
    expect(text.endsWith("\n")).toBe(true);
    expect(text.trim().split("\n")).toHaveLength(3);
    const events = await readLogFile(dir);
    expect(events.map((e) => (e as { insight: string }).insight)).toEqual([
      "a",
      "b",
      "c",
    ]);
  });

  test("appendEvent preserves nested data (round trip)", async () => {
    await appendEvent(dir, {
      type: "experiment",
      name: "lgbm-baseline",
      hypothesis_id: "H1",
      config: { lr: 0.1, layers: [64, 32], nested: { a: null } },
      metrics: { auc: 0.91 },
      observations: 'quotes " and\nnewlines are escaped',
    } as Omit<RalphEvent, "ts">);
    const [event] = await readLogFile(dir);
    expect(event).toMatchObject({
      type: "experiment",
      name: "lgbm-baseline",
      config: { lr: 0.1, layers: [64, 32], nested: { a: null } },
      metrics: { auc: 0.91 },
      observations: 'quotes " and\nnewlines are escaped',
    });
  });

  test("appendEvent appends after existing malformed content", async () => {
    await Bun.write(logPath(), "garbage line\n");
    await appendEvent(dir, {
      type: "learning",
      insight: "after garbage",
    } as Omit<RalphEvent, "ts">);
    const events = await readLogFile(dir);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ insight: "after garbage" });
  });

  test("appendEvent returns false when the log cannot be written", async () => {
    const blocked = await mkdtemp(join(tmpdir(), "ml-ralph-blocked-"));
    try {
      await Bun.write(join(blocked, ".ml-ralph"), "i am a file, not a dir");
      const ok = await appendEvent(blocked, {
        type: "learning",
        insight: "x",
      } as Omit<RalphEvent, "ts">);
      expect(ok).toBe(false);
    } finally {
      await rm(blocked, { recursive: true, force: true });
    }
  });

  test("appended events aggregate end to end", async () => {
    const append = (e: Record<string, unknown>) =>
      appendEvent(dir, e as unknown as Omit<RalphEvent, "ts">);
    await append({ type: "hypothesis", id: "H1", hypothesis: "h" });
    await append({
      type: "experiment",
      name: "e",
      hypothesis_id: "H1",
      metrics: { auc: 0.8 },
    });
    await append({
      type: "decision",
      hypothesis_id: "H1",
      action: "iterate",
      reason: "r",
    });
    const summary = aggregateEvents(await readLogFile(dir));
    expect(summary.hypotheses[0]).toMatchObject({
      id: "H1",
      status: "iterate",
    });
    expect(summary.hypotheses[0]?.experiments).toHaveLength(1);
  });

  test("readPrdFile and readKanbanFile return null when missing or invalid", async () => {
    expect(await readPrdFile(dir)).toBeNull();
    expect(await readKanbanFile(dir)).toBeNull();
    await Bun.write(join(dir, ".ml-ralph", "prd.json"), "{ not json");
    await Bun.write(join(dir, ".ml-ralph", "kanban.json"), "{ not json");
    expect(await readPrdFile(dir)).toBeNull();
    expect(await readKanbanFile(dir)).toBeNull();
  });

  test("readPrdFile and readKanbanFile parse valid files", async () => {
    await Bun.write(join(dir, ".ml-ralph", "prd.json"), '{"project":"p"}');
    await Bun.write(join(dir, ".ml-ralph", "kanban.json"), '{"backlog":[]}');
    expect(await readPrdFile(dir)).toMatchObject({ project: "p" });
    expect(await readKanbanFile(dir)).toMatchObject({ backlog: [] });
  });
});
