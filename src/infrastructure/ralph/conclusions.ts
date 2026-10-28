/**
 * conclusions.md - the distilled, revisable claims the agent carries between
 * iterations. The runner inlines it plus the last N log events into each
 * prompt, so prompt size stays flat as log.jsonl grows, and rejects edits that
 * are too long or not justified by a `conclusions_changed` event.
 */

import { join } from "node:path";

export const CONCLUSIONS_FILE = ".ml-ralph/conclusions.md";
export const MAX_CONCLUSIONS_WORDS = 300;
export const DEFAULT_RECENT_EVENTS = 30;
export const CONCLUSIONS_CHANGE_REASONS = [
  "contradiction",
  "new_category",
  "flipped_recommendation",
  "refinement",
] as const;

/** One event line is cut here so a single huge event cannot grow the prompt */
const MAX_EVENT_CHARS = 1500;

export type ConclusionsRejection = "too_long" | "no_justification";

export function countWords(text: string): number {
  return text.split(/\s+/).filter(Boolean).length;
}

export async function readConclusions(projectPath: string): Promise<string> {
  const file = Bun.file(join(projectPath, CONCLUSIONS_FILE));
  return (await file.exists()) ? file.text() : "";
}

/** Create an empty conclusions.md when the project has none */
export async function ensureConclusions(projectPath: string): Promise<void> {
  const path = join(projectPath, CONCLUSIONS_FILE);
  if (!(await Bun.file(path).exists())) await Bun.write(path, "");
}

/** How many recent log events to inline: config.json `recent_events`, default 30 */
export async function readRecentEventsCount(
  projectPath: string,
): Promise<number> {
  try {
    const config = await Bun.file(
      join(projectPath, ".ml-ralph/config.json"),
    ).json();
    const n = config?.recent_events;
    if (typeof n === "number" && Number.isInteger(n) && n >= 0) return n;
  } catch {
    // No or unreadable config: the default applies
  }
  return DEFAULT_RECENT_EVENTS;
}

async function readLogLines(projectPath: string): Promise<string[]> {
  const file = Bun.file(join(projectPath, ".ml-ralph/log.jsonl"));
  if (!(await file.exists())) return [];
  return (await file.text()).split("\n").filter((l) => l.trim());
}

export async function countLogLines(projectPath: string): Promise<number> {
  return (await readLogLines(projectPath)).length;
}

function parseEvent(line: string): Record<string, unknown> | null {
  try {
    const event = JSON.parse(line);
    return event && typeof event === "object" ? event : null;
  } catch {
    return null;
  }
}

/** The prompt section holding conclusions.md and the last N log events */
export async function buildContextPrompt(projectPath: string): Promise<string> {
  const [conclusions, lines, count] = await Promise.all([
    readConclusions(projectPath),
    readLogLines(projectPath),
    readRecentEventsCount(projectPath),
  ]);
  const recent = (count > 0 ? lines.slice(-count) : []).map((l) =>
    l.length > MAX_EVENT_CHARS ? `${l.slice(0, MAX_EVENT_CHARS)}...` : l,
  );
  return `

## Conclusions (.ml-ralph/conclusions.md)
${conclusions.trim() || "(empty - nothing distilled yet)"}

## Last ${recent.length} log events (log.jsonl holds the full history; read it only for a specific lookup)
${recent.join("\n") || "(no events yet)"}`;
}

/**
 * Check an iteration's edit to conclusions.md. `eventsAfter` are the log lines
 * the iteration appended. Returns null when the file is unchanged or the
 * change is allowed.
 */
export function checkConclusions(
  before: string,
  after: string,
  eventsAfter: string[],
): { reason: ConclusionsRejection; detail: string; words: number } | null {
  if (before === after) return null;
  const words = countWords(after);
  if (words > MAX_CONCLUSIONS_WORDS) {
    return {
      reason: "too_long",
      detail: `conclusions.md has ${words} words; the limit is ${MAX_CONCLUSIONS_WORDS}`,
      words,
    };
  }
  const justified = eventsAfter.some((line) => {
    const event = parseEvent(line);
    return (
      event?.type === "conclusions_changed" &&
      (CONCLUSIONS_CHANGE_REASONS as readonly unknown[]).includes(event.reason)
    );
  });
  if (!justified) {
    return {
      reason: "no_justification",
      detail: `conclusions.md changed without a conclusions_changed event whose reason is one of ${CONCLUSIONS_CHANGE_REASONS.join(", ")}`,
      words,
    };
  }
  return null;
}

/**
 * Enforce the rules after an iteration: on a violation restore `before`.
 * `logLinesBefore` is the log length when the iteration started.
 */
export async function enforceConclusions(
  projectPath: string,
  before: string,
  logLinesBefore: number,
): Promise<{
  reason: ConclusionsRejection;
  detail: string;
  words: number;
} | null> {
  const [after, lines] = await Promise.all([
    readConclusions(projectPath),
    readLogLines(projectPath),
  ]);
  const rejection = checkConclusions(
    before,
    after,
    lines.slice(logLinesBefore),
  );
  if (rejection) await Bun.write(join(projectPath, CONCLUSIONS_FILE), before);
  return rejection;
}
