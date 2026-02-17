/**
 * Metrics chart widget - displays training metrics with ASCII visualization
 */

import type { TrainingJob } from "../../domain/types/index.ts";
import { Box, Text } from "../ink.tsx";
import { colors } from "../theme/colors.ts";

interface MetricsChartProps {
  job: TrainingJob;
  onStop?: () => void;
}

export function MetricsChart({ job }: MetricsChartProps) {
  const statusColor = getStatusColor(job.status);
  const statusIcon = getStatusIcon(job.status);
  const metrics = job.latestMetrics ?? {};

  // Calculate runtime
  const runtime = getRuntime(job.startedAt, job.completedAt);

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={statusColor}
      paddingX={1}
      marginBottom={1}
    >
      {/* Header */}
      <Box justifyContent="space-between">
        <Box gap={1}>
          <Text color={statusColor}>{statusIcon}</Text>
          <Text color={colors.accentBlue} bold>
            {job.experimentId}
          </Text>
        </Box>
        <Text color={colors.textMuted}>{runtime}</Text>
      </Box>

      {/* Metrics */}
      {Object.keys(metrics).length > 0 ? (
        <Box flexDirection="column" marginTop={1}>
          {/* Epoch/Step progress */}
          {metrics.epoch !== undefined && (
            <EpochProgress
              current={metrics.epoch}
              total={metrics.totalEpochs}
            />
          )}

          {/* Key metrics */}
          <Box flexDirection="row" gap={3} marginTop={1}>
            {renderMetric("loss", metrics.loss ?? metrics.train_loss)}
            {renderMetric("val_loss", metrics.val_loss)}
            {renderMetric("acc", metrics.accuracy ?? metrics.val_accuracy)}
          </Box>

          {/* Mini sparkline for loss if history available */}
          {typeof metrics.loss === "number" && (
            <Box marginTop={1}>
              <Text color={colors.textMuted}>loss: </Text>
              <Sparkline values={generateMockHistory(metrics.loss)} />
            </Box>
          )}
        </Box>
      ) : (
        <Box marginTop={1}>
          <Text color={colors.textMuted}>Waiting for metrics...</Text>
        </Box>
      )}

      {/* W&B link */}
      {job.wandbUrl && (
        <Box marginTop={1}>
          <Text color={colors.textMuted}>W&B: </Text>
          <Text color={colors.accentBlue}>{truncateUrl(job.wandbUrl)}</Text>
        </Box>
      )}
    </Box>
  );
}

interface EpochProgressProps {
  current: number;
  total?: number;
}

function EpochProgress({ current, total }: EpochProgressProps) {
  const displayTotal = total ?? 100;
  const progress = Math.min(current / displayTotal, 1);
  const barWidth = 20;
  const filled = Math.round(progress * barWidth);
  const empty = barWidth - filled;

  return (
    <Box gap={1}>
      <Text color={colors.textSecondary}>epoch</Text>
      <Text color={colors.accentGreen}>{"█".repeat(filled)}</Text>
      <Text color={colors.textMuted}>{"░".repeat(empty)}</Text>
      <Text color={colors.textPrimary}>
        {current}/{total ?? "?"}
      </Text>
    </Box>
  );
}

function renderMetric(name: string, value: number | undefined) {
  if (value === undefined) return null;

  const formatted = value < 1 ? value.toFixed(4) : value.toFixed(2);
  const valueColor = getMetricColor(name, value);

  return (
    <Box key={name}>
      <Text color={colors.textMuted}>{name}: </Text>
      <Text color={valueColor}>{formatted}</Text>
    </Box>
  );
}

interface SparklineProps {
  values: number[];
  width?: number;
}

function Sparkline({ values, width = 15 }: SparklineProps) {
  if (values.length === 0) return null;

  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || 1;

  // Use block characters for sparkline
  const blocks = ["▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"];

  // Take the last `width` values
  const displayValues = values.slice(-width);

  const sparkline = displayValues
    .map((v) => {
      const normalized = (v - min) / range;
      const index = Math.min(
        Math.floor(normalized * blocks.length),
        blocks.length - 1,
      );
      return blocks[index];
    })
    .join("");

  return <Text color={colors.accentYellow}>{sparkline}</Text>;
}

function getStatusColor(status: string): string {
  switch (status) {
    case "running":
      return colors.accentGreen;
    case "completed":
      return colors.accentBlue;
    case "stopped":
      return colors.accentYellow;
    case "failed":
      return colors.accentRed;
    default:
      return colors.textMuted;
  }
}

function getStatusIcon(status: string): string {
  switch (status) {
    case "running":
      return "◐";
    case "completed":
      return "✓";
    case "stopped":
      return "◼";
    case "failed":
      return "✗";
    default:
      return "○";
  }
}

function getMetricColor(name: string, value: number): string {
  // Loss should be low (green when low, red when high)
  if (name.includes("loss")) {
    if (value < 0.1) return colors.accentGreen;
    if (value < 0.5) return colors.accentYellow;
    return colors.accentRed;
  }

  // Accuracy should be high (green when high, red when low)
  if (name.includes("acc")) {
    if (value > 0.9) return colors.accentGreen;
    if (value > 0.7) return colors.accentYellow;
    return colors.accentRed;
  }

  return colors.textPrimary;
}

function getRuntime(startedAt: string, completedAt?: string): string {
  const start = new Date(startedAt).getTime();
  const end = completedAt ? new Date(completedAt).getTime() : Date.now();
  const diff = end - start;

  const hours = Math.floor(diff / 3600000);
  const minutes = Math.floor((diff % 3600000) / 60000);
  const seconds = Math.floor((diff % 60000) / 1000);

  if (hours > 0) {
    return `${hours}h ${minutes}m`;
  }
  if (minutes > 0) {
    return `${minutes}m ${seconds}s`;
  }
  return `${seconds}s`;
}

function truncateUrl(url: string): string {
  if (url.length <= 40) return url;
  return `...${url.slice(-37)}`;
}

// Generate mock history for sparkline demo (will be replaced with actual W&B data)
function generateMockHistory(current: number): number[] {
  const history: number[] = [];
  let val = current * 3; // Start higher
  for (let i = 0; i < 15; i++) {
    history.push(val);
    val = val * 0.9 + current * 0.1 + (Math.random() - 0.5) * 0.1;
  }
  history.push(current);
  return history;
}

/**
 * Compact job list item for multiple jobs
 */
interface JobListItemProps {
  job: TrainingJob;
  selected?: boolean;
  onSelect?: () => void;
}

export function JobListItem({ job, selected }: JobListItemProps) {
  const statusColor = getStatusColor(job.status);
  const statusIcon = getStatusIcon(job.status);
  const metrics = job.latestMetrics;

  return (
    <Box
      borderStyle={selected ? "single" : undefined}
      borderColor={selected ? colors.accentBlue : undefined}
      paddingX={1}
    >
      <Box gap={2}>
        <Text color={statusColor}>{statusIcon}</Text>
        <Text color={colors.textPrimary}>{job.experimentId}</Text>
        {metrics?.loss !== undefined && (
          <Text color={colors.textMuted}>loss: {metrics.loss.toFixed(4)}</Text>
        )}
        {metrics?.epoch !== undefined && (
          <Text color={colors.textMuted}>epoch: {metrics.epoch}</Text>
        )}
      </Box>
    </Box>
  );
}
