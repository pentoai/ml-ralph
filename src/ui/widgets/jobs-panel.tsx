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
}

export function JobsPanel({
  jobs,
  selectedIndex,
  notice,
  log,
}: JobsPanelProps) {
  if (jobs.length === 0 && !notice) return null;
  return (
    <Box flexDirection="column" paddingX={1}>
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
            ── {log.jobId} log (last {log.lines.length} lines) ──
          </Text>
          {log.lines.map((line, i) => (
            <Text key={i}>{line}</Text>
          ))}
        </Box>
      )}
    </Box>
  );
}
