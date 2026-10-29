/**
 * Active training jobs (runs/active.json): list, selection, notice and log tail
 */

import type { TrainingJob } from "../../domain/types/index.ts";
import { Box, Text } from "../ink.tsx";
import { colors } from "../theme/colors.ts";

/** Rows left for log lines once the header, job rows, notice and log header are placed */
function computeLogRows(
  maxRows: number,
  jobCount: number,
  hasNotice: boolean,
): number {
  return Math.max(0, maxRows - 1 - jobCount - (hasNotice ? 1 : 0) - 1);
}

/** Clamp a scroll offset (lines up from the newest line) to what the lines allow */
function clampLogScroll(offset: number, total: number, rows: number): number {
  return Math.max(0, Math.min(offset, total - rows));
}

/** The window of lines to show; offset 0 follows the newest line */
function windowLog(lines: string[], rows: number, offset: number) {
  const up = clampLogScroll(offset, lines.length, rows);
  const end = lines.length - up;
  return { shown: lines.slice(Math.max(0, end - rows), end), up, end };
}

export const __testing = { computeLogRows, clampLogScroll, windowLog };

interface JobsPanelProps {
  jobs: TrainingJob[];
  selectedIndex: number;
  notice: string | null;
  log: { jobId: string; lines: string[] } | null;
  /** Lines the log is scrolled up from its newest line (0 follows the job) */
  logScroll: number;
  /** Rows the panel may use in total; the log tail shrinks to fit */
  maxRows: number;
}

export function JobsPanel({
  jobs,
  selectedIndex,
  notice,
  log,
  logScroll,
  maxRows,
}: JobsPanelProps) {
  if (jobs.length === 0 && !notice) return null;
  // header + one row per job + notice + log header leave the rest for the tail
  const logRows = computeLogRows(maxRows, jobs.length, !!notice);
  const { shown, up, end } = log
    ? windowLog(log.lines, logRows, logScroll)
    : { shown: [] as string[], up: 0, end: 0 };
  return (
    <Box
      flexDirection="column"
      paddingX={1}
      height={Math.min(
        maxRows,
        1 + jobs.length + (notice ? 1 : 0) + (log ? 1 + shown.length : 0),
      )}
      overflow="hidden"
    >
      <Text color={colors.accentBlue} bold>
        Jobs ({jobs.length}) ↑/↓ select · t stop · w log
      </Text>
      {jobs.map((job, i) => (
        <Text
          key={job.id}
          color={
            i === selectedIndex ? colors.accentGreen : colors.textSecondary
          }
        >
          {i === selectedIndex ? "▶ " : "  "}
          {job.id} pid {job.pid} · {job.startedAt} · {job.command}
        </Text>
      ))}
      {notice && <Text color={colors.accentYellow}>{notice}</Text>}
      {log && (
        <Box flexDirection="column">
          <Text color={colors.textMuted}>
            ── {log.jobId} log (
            {up > 0
              ? `lines ${end - shown.length + 1}-${end} of ${log.lines.length}`
              : `last ${shown.length} of ${log.lines.length} lines`}
            ) j/k PgUp/PgDn scroll ──
          </Text>
          {shown.map((line, i) => (
            <Text key={i}>{line}</Text>
          ))}
        </Box>
      )}
    </Box>
  );
}
