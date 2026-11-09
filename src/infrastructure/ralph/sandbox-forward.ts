/**
 * Request-file bridge between the sandbox container and the host runner.
 *
 * The container's `ml-ralph` shim writes <dir>/requests/<id>.json
 * ({argv, cwd, stdin}) into the mounted project; the runner executes `log`,
 * `eval` or `job start` on the host and answers with <dir>/responses/<id>.json
 * ({code, stdout, stderr}). Nothing else is forwarded, and no socket is mounted.
 */

import {
  mkdir,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { isAbsolute, join, relative } from "node:path";
import { runEvalCommand } from "./eval-command.ts";
import { runJobCommand } from "./jobs.ts";
import { runLogCommand } from "./log-command.ts";

export const FORWARD_DIR = ".ml-ralph/sandbox";
const POLL_MS = 100;
const REQUEST_ID = /^[a-f0-9]{8,64}$/;

export interface ForwardedResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface Forwarder {
  /** Stop polling; requests already running finish on the host */
  stop: () => void;
}

const refuse = (stderr: string, code = 2): ForwardedResult => ({
  code,
  stdout: "",
  stderr: `${stderr}\n`,
});

/** Run one request on the host; `cwd` must be inside the project */
export async function executeRequest(
  request: unknown,
  projectPath: string,
  env: Record<string, string | undefined>,
): Promise<ForwardedResult> {
  const req = request as {
    argv?: unknown;
    cwd?: unknown;
    stdin?: unknown;
  } | null;
  const argv = req?.argv;
  if (
    !Array.isArray(argv) ||
    argv.some((a) => typeof a !== "string") ||
    argv.length === 0
  ) {
    return refuse("sandbox: malformed request");
  }
  if (typeof req?.cwd !== "string" || !isAbsolute(req.cwd)) {
    return refuse("sandbox: request has no absolute cwd");
  }
  let cwd: string;
  try {
    const [root, real] = await Promise.all([
      realpath(projectPath),
      realpath(req.cwd),
    ]);
    const rel = relative(root, real);
    if (rel.startsWith("..") || isAbsolute(rel)) {
      return refuse("sandbox: the working directory is outside the project", 1);
    }
    cwd = real;
  } catch {
    return refuse("sandbox: the working directory does not exist", 1);
  }

  const [command, ...args] = argv as string[];
  switch (command) {
    case "log": {
      const stdin = typeof req.stdin === "string" ? req.stdin : "";
      return runLogCommand(args, { cwd, readStdin: async () => stdin });
    }
    case "eval":
      return runEvalCommand(args, { cwd, env });
    case "job":
      return runJobCommand(args, { cwd, capture: true });
    default:
      return refuse(
        `sandbox: \`ml-ralph ${command}\` is not available inside the sandbox (only log, eval, job)`,
      );
  }
}

/**
 * Serve requests until stopped. `env` carries the iteration and experiment-cap
 * variables the claude process would have had on the host.
 */
export async function startForwarder(options: {
  projectPath: string;
  env: Record<string, string | undefined>;
}): Promise<Forwarder> {
  const base = join(options.projectPath, FORWARD_DIR);
  const requests = join(base, "requests");
  const responses = join(base, "responses");
  await rm(base, { recursive: true, force: true });
  await mkdir(requests, { recursive: true });
  await mkdir(responses, { recursive: true });

  const seen = new Set<string>();
  const serve = async (file: string) => {
    const id = file.slice(0, -".json".length);
    let result: ForwardedResult;
    try {
      const text = await readFile(join(requests, file), "utf8");
      await rm(join(requests, file), { force: true });
      result = await executeRequest(
        JSON.parse(text),
        options.projectPath,
        options.env,
      );
    } catch (error) {
      result = refuse(
        `sandbox: request failed (${error instanceof Error ? error.message : String(error)})`,
        1,
      );
    }
    const tmp = join(responses, `${id}.tmp`);
    await writeFile(tmp, JSON.stringify(result));
    await rename(tmp, join(responses, file));
  };

  let polling = false;
  const poll = async () => {
    if (polling) return;
    polling = true;
    try {
      for (const file of await readdir(requests).catch(() => [] as string[])) {
        if (!file.endsWith(".json") || seen.has(file)) continue;
        if (!REQUEST_ID.test(file.slice(0, -".json".length))) continue;
        seen.add(file);
        void serve(file);
      }
    } finally {
      polling = false;
    }
  };
  const timer = setInterval(poll, POLL_MS);
  return { stop: () => clearInterval(timer) };
}
