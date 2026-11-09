/**
 * Bench infrastructure - the self-benchmark suite runner and results comparison
 */

export type { AuthStatusRunner, ClaudeAuth } from "./auth.ts";
export { checkClaudeAuth } from "./auth.ts";
export type { BenchCommandResult } from "./command.ts";
export { runBenchCommand } from "./command.ts";
export { formatComparison, readBenchResults } from "./compare.ts";
export type { BenchOptions, BenchOutcome } from "./run-bench.ts";
export { readLogFacts, runBench, runTask } from "./run-bench.ts";
