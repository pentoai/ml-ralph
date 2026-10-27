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

/** Walk up from `start` to the nearest directory containing .ml-ralph/ */
export async function findProjectDir(start: string): Promise<string | null> {
  let dir = resolve(start);
  while (true) {
    if (await isDirectory(join(dir, ".ml-ralph"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/** Append one event, stamped with ts, to .ml-ralph/log.jsonl without rewriting the file */
export async function appendLogLine(
  projectDir: string,
  event: Record<string, unknown>,
): Promise<void> {
  const logPath = join(projectDir, ".ml-ralph", "log.jsonl");
  const line = `${JSON.stringify({ ts: new Date().toISOString(), ...event })}\n`;
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
  process.stderr.write(`${message}\n`);
  onInvalid?.({ type, message });
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

  const { ts: _ts, ...body } = parsed as Record<string, unknown>;
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
