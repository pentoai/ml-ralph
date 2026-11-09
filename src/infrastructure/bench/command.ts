/**
 * `ml-ralph bench` - run the suite, or compare two results files
 */

import { resolve } from "node:path";
import { formatComparison, readBenchResults } from "./compare.ts";
import { type BenchOptions, runBench } from "./run-bench.ts";

export interface BenchCommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

const USAGE = `Usage:
  ml-ralph bench [--suite <file>] [--task <id>]...   Run the suite; writes results/<timestamp>.json next to the suite
  ml-ralph bench --compare <a.json> <b.json>         Table of success, holdout gap, USD and caught per task

Default suite: bench/suite.json in the ml-ralph package. Needs an authenticated claude CLI.`;

const DEFAULT_SUITE = resolve(import.meta.dir, "../../../bench/suite.json");

const fail = (stderr: string, code = 1): BenchCommandResult => ({
  code,
  stdout: "",
  stderr: `${stderr}\n`,
});

/** Run `ml-ralph bench` with the arguments after the command name */
export async function runBenchCommand(
  args: string[],
  overrides: Partial<BenchOptions> = {},
): Promise<BenchCommandResult> {
  if (args.includes("--help") || args.includes("-h")) {
    return { code: 0, stdout: `${USAGE}\n`, stderr: "" };
  }

  const compareAt = args.indexOf("--compare");
  if (compareAt !== -1) {
    const [a, b, ...extra] = args.slice(compareAt + 1);
    if (!a || !b || extra.length > 0 || args.length !== compareAt + 3) {
      return fail(USAGE, 2);
    }
    const [first, second] = await Promise.all([
      readBenchResults(a),
      readBenchResults(b),
    ]);
    if (!first.ok) return fail(first.error);
    if (!second.ok) return fail(second.error);
    return {
      code: 0,
      stdout: formatComparison(
        { label: a, results: first.results },
        { label: b, results: second.results },
      ),
      stderr: "",
    };
  }

  let suitePath = DEFAULT_SUITE;
  const only: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    const value = args[i + 1];
    if ((flag === "--suite" || flag === "--task") && value) {
      if (flag === "--suite") suitePath = resolve(value);
      else only.push(value);
      i++;
    } else {
      return fail(USAGE, 2);
    }
  }

  const outcome = await runBench({
    suitePath,
    only,
    onProgress: (line) => process.stderr.write(`${line}\n`),
    ...overrides,
  });
  if (!outcome.ok) return fail(`bench: ${outcome.error}`);

  const { tasks } = outcome.results;
  const passed = tasks.filter((t) => t.success).length;
  return {
    code: 0,
    stdout: `${passed}/${tasks.length} tasks succeeded. Results: ${outcome.file}\n`,
    stderr: "",
  };
}
