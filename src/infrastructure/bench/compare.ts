/**
 * Bench compare - side-by-side table of two results files
 */

import type {
  BenchResults,
  BenchTaskResult,
} from "../../domain/types/index.ts";
import { validateBenchResults } from "../../domain/validation/index.ts";

/** Read and validate a bench results file; the error names the file */
export async function readBenchResults(
  path: string,
): Promise<{ ok: true; results: BenchResults } | { ok: false; error: string }> {
  let parsed: unknown;
  try {
    parsed = await Bun.file(path).json();
  } catch (error) {
    const missing = !(await Bun.file(path).exists());
    return {
      ok: false,
      error: missing
        ? `${path} does not exist`
        : `${path} is not valid JSON (${error instanceof Error ? error.message : String(error)})`,
    };
  }
  const valid = validateBenchResults(parsed);
  if (!valid.valid) {
    const detail = valid.errors
      .map((e) => `${e.field} ${e.message}`)
      .join("; ");
    return {
      ok: false,
      error: `${path} is not a bench results file: ${detail}`,
    };
  }
  return { ok: true, results: valid.results };
}

const MISSING = "missing";

const yesNo = (v: boolean | null | undefined) =>
  v === null || v === undefined ? "-" : v ? "yes" : "no";
const num = (v: number | null | undefined, digits: number) =>
  typeof v === "number" ? v.toFixed(digits) : "-";

function cells(t: BenchTaskResult | undefined) {
  if (!t) {
    return { success: MISSING, gap: MISSING, usd: MISSING, caught: MISSING };
  }
  return {
    success: t.error ? "error" : yesNo(t.success),
    gap: num(t.holdout_gap, 3),
    usd: num(t.usd, 2),
    caught: yesNo(t.caught),
  };
}

/**
 * Table with one row per task id found in either file (a's order, then b's
 * extras). Each cell reads "a -> b"; a task absent from one file shows
 * "missing" on that side, and a task that errored shows "error" as its success.
 */
export function formatComparison(
  a: { label: string; results: BenchResults },
  b: { label: string; results: BenchResults },
): string {
  const byId = (r: BenchResults) => new Map(r.tasks.map((t) => [t.id, t]));
  const mapA = byId(a.results);
  const mapB = byId(b.results);
  const ids = [...new Set([...mapA.keys(), ...mapB.keys()])];

  const header = ["task", "success", "holdout gap", "USD", "caught"];
  const rows = ids.map((id) => {
    const l = cells(mapA.get(id));
    const r = cells(mapB.get(id));
    const note =
      !mapA.has(id) || !mapB.has(id)
        ? ` (only in ${mapA.has(id) ? a.label : b.label})`
        : "";
    return [
      `${id}${note}`,
      `${l.success} -> ${r.success}`,
      `${l.gap} -> ${r.gap}`,
      `${l.usd} -> ${r.usd}`,
      `${l.caught} -> ${r.caught}`,
    ];
  });

  const widths = header.map((h, i) =>
    Math.max(h.length, ...rows.map((row) => (row[i] as string).length)),
  );
  const line = (row: string[]) =>
    row
      .map((c, i) => c.padEnd(widths[i] as number))
      .join("  ")
      .trimEnd();
  return [
    `a: ${a.label}`,
    `b: ${b.label}`,
    "",
    line(header),
    line(widths.map((w) => "-".repeat(w))),
    ...rows.map(line),
    "",
  ].join("\n");
}
