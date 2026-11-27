/**
 * `ml-ralph log` - validate an event against its schema, then append it to log.jsonl
 */

import { appendFile, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import {
  isRunnerOnlyEvent,
  logEventTypes,
  validateLogEvent,
} from "../../domain/validation/index.ts";

export interface LogCommandResult {
  /** Process exit code: 0 when the event was appended */
  code: number;
  stdout: string;
  stderr: string;
}

export interface LogCommandOptions {
  /** Directory to start looking for .ml-ralph/ from (default: cwd) */
  cwd?: string;
  /** Source of the JSON when the argument is "-" (default: process stdin) */
  readStdin?: () => Promise<string>;
}

const USAGE = `Usage: ml-ralph log <type> '<json>'
       ml-ralph log <type> - < event.json

Validates the event and appends one line to .ml-ralph/log.jsonl.
ts and type are added for you. Types: ${logEventTypes().join(", ")}`;

const fail = (stderr: string, code = 1): LogCommandResult => ({
  code,
  stdout: "",
  stderr: `${stderr}\n`,
});

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

/** Set by the runner on a worker's claude process: its events in log.jsonl carry this worker number */
export const WORKER_ENV = "ML_RALPH_WORKER";

/** Written into a worker's worktree `.ml-ralph/`: the CLI tools run there use the real project's state */
export const WORKER_MARKER = "worker.json";

/** The project a worker's worktree belongs to, from its marker; null when `dir` is not a worktree root */
async function readWorkerMarker(
  dir: string,
): Promise<{ worker: number; project: string } | null> {
  try {
    const value = (await Bun.file(
      join(dir, ".ml-ralph", WORKER_MARKER),
    ).json()) as { worker?: unknown; project?: unknown } | null;
    if (
      typeof value?.worker === "number" &&
      typeof value.project === "string" &&
      (await isDirectory(join(value.project, ".ml-ralph")))
    ) {
      return { worker: value.worker, project: value.project };
    }
  } catch {
    // Not a worktree root
  }
  return null;
}

/**
 * Walk up from `start` to the nearest directory containing .ml-ralph/.
 * `projectDir` holds the run's state; `workDir` is where the agent's code
 * lives. They are the same directory unless `start` is inside a worker's
 * git worktree, whose `.ml-ralph/worker.json` names the real project.
 */
export async function locateProject(
  start: string,
): Promise<{ projectDir: string; workDir: string } | null> {
  let dir = resolve(start);
  while (true) {
    if (await isDirectory(join(dir, ".ml-ralph"))) {
      const marker = await readWorkerMarker(dir);
      return { projectDir: marker?.project ?? dir, workDir: dir };
    }
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/** The directory holding the run's .ml-ralph/ state, from anywhere inside the project or one of its worktrees */
export async function findProjectDir(start: string): Promise<string | null> {
  return (await locateProject(start))?.projectDir ?? null;
}

/** The worker number to tag events with: the explicit one, else the runner's variable in the environment */
function workerTag(event: Record<string, unknown>): { worker: number } | null {
  if (typeof event.worker === "number") return null;
  const n = Number(process.env[WORKER_ENV]);
  return Number.isInteger(n) && n > 0 ? { worker: n } : null;
}

/** Append one event, stamped with ts, to .ml-ralph/log.jsonl without rewriting the file */
export async function appendLogLine(
  projectDir: string,
  event: Record<string, unknown>,
): Promise<void> {
  const logPath = join(projectDir, ".ml-ralph", "log.jsonl");
  const line = `${JSON.stringify({ ts: new Date().toISOString(), ...workerTag(event), ...event })}\n`;
  const file = Bun.file(logPath);
  // Start on a fresh line if an earlier writer left the log unterminated
  const needsNewline =
    file.size > 0 && (await file.slice(file.size - 1).text()) !== "\n";
  await appendFile(logPath, needsNewline ? `\n${line}` : line);
}

/** A runner-written event that failed its schema: why, in one block of text */
export interface InvalidRunnerEvent {
  type: string;
  message: string;
}

/**
 * Append an event the runner (or `ml-ralph eval`) wrote itself, but only when
 * it passes the same schema `ml-ralph log` applies. An invalid event is not
 * appended: it goes to stderr and to `onInvalid` (the TUI error line) and the
 * call returns false. Write failures still throw, as with appendLogLine.
 */
export async function appendValidatedEvent(
  projectDir: string,
  event: Record<string, unknown>,
  onInvalid?: (invalid: InvalidRunnerEvent) => void,
): Promise<boolean> {
  const type = typeof event.type === "string" ? event.type : "(missing)";
  const { ts: _ts, type: _type, ...body } = event;
  const validation = validateLogEvent(type, body);
  if (validation.valid) {
    await appendLogLine(projectDir, event);
    return true;
  }
  const lines = validation.errors.map((e) => `${e.field}: ${e.message}`);
  const message = `Invalid runner ${type} event, not logged: ${lines.join("; ")}`;
  if (onInvalid) onInvalid({ type, message });
  else process.stderr.write(`${message}\n`);
  return false;
}

/**
 * Run `ml-ralph log <type> '<json>'`. Appends nothing unless the event
 * validates; every failure names the offending field and what was expected.
 */
export async function runLogCommand(
  args: string[],
  options: LogCommandOptions = {},
): Promise<LogCommandResult> {
  const [type, rawJson, ...extra] = args;
  if (!type || rawJson === undefined || extra.length > 0) {
    return fail(USAGE, 2);
  }

  let text = rawJson;
  if (rawJson === "-") {
    text = await (options.readStdin ?? (() => Bun.stdin.text()))();
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return fail(`(root): not valid JSON (${reason}); nothing was logged`);
  }

  if (isRunnerOnlyEvent(type)) {
    return fail(
      `type: ${JSON.stringify(type)} is written by the runner only; nothing was logged`,
    );
  }

  const validation = validateLogEvent(type, parsed);
  if (!validation.valid) {
    const lines = validation.errors.map((e) => `${e.field}: ${e.message}`);
    return fail(
      `Invalid ${type} event, nothing was logged:\n${lines.join("\n")}`,
    );
  }

  // The worker tag comes from the runner's environment, never from the agent
  const {
    ts: _ts,
    worker: _worker,
    ...body
  } = parsed as Record<string, unknown>;
  if (body.type !== undefined && body.type !== type) {
    return fail(
      `type: JSON says ${JSON.stringify(body.type)} but the command says ${JSON.stringify(type)}; nothing was logged`,
    );
  }

  const projectDir = await findProjectDir(options.cwd ?? process.cwd());
  if (!projectDir) {
    return fail(
      "No .ml-ralph/ directory here or in any parent; run from your project directory. Nothing was logged.",
    );
  }

  await appendLogLine(projectDir, { type, ...body });

  return { code: 0, stdout: `Logged ${type} event\n`, stderr: "" };
}
