/**
 * Active training jobs (runs/active.json): list, selection, notice and log tail
 */

import type { TrainingJob } from "../../domain/types/index.ts";
import { Box, Text } from "../ink.tsx";
import { colors } from "../theme/colors.ts";

interface JobsPanelProps {
  jobs: TrainingJob[];
  selectedIndex: number;
  notice: string | null;
  log: { jobId: string; lines: string[] } | null;
  /** Rows the panel may use in total; the log tail shrinks to fit */
  maxRows: number;
}

export function JobsPanel({
  jobs,
  selectedIndex,
  notice,
  log,
  maxRows,
}: JobsPanelProps) {
  if (jobs.length === 0 && !notice) return null;
  // header + one row per job + notice + log header leave the rest for the tail
  const logRows = Math.max(0, maxRows - 1 - jobs.length - (notice ? 1 : 0) - 1);
  const shown = log ? log.lines.slice(-logRows) : [];
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
            ── {log.jobId} log (last {shown.length} of {log.lines.length} lines)
            ──
          </Text>
          {shown.map((line, i) => (
            <Text key={i}>{line}</Text>
          ))}
        </Box>
      )}
    </Box>
  );
}
