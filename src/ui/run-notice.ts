/**
 * Run stop notice - the line the TUI shows after the runner ends a run
 */

import type { RunCompleteReason } from "../infrastructure/ralph/index.ts";

const NOTICES: Record<RunCompleteReason, string> = {
  completed:
    "Run complete: the verifier approved and the sealed holdout met the success criteria (see the run_complete event in log.jsonl)",
  contract_changed:
    "Run stopped: reason contract_changed (a locked eval file was changed and you chose to stop)",
  holdout_access:
    "Run stopped: reason holdout_access (a tool call named the sealed holdout path; the claude session was killed, see the holdout_access event in log.jsonl)",
  max_iterations:
    "Run stopped: reason max_iterations (the iteration limit was reached; the run is not complete)",
};

/** Why the run ended, as the notice the TUI keeps until it is dismissed */
export function runStopNotice(reason: RunCompleteReason): string {
  return NOTICES[reason];
}
