/**
 * Hypotheses panel - displays hypotheses from log.jsonl with visual styling
 */

import type { HypothesisWithStatus } from "../../infrastructure/ralph/index.ts";
import { Box, Text } from "../ink.tsx";
import { colors } from "../theme/colors.ts";

interface HypothesesPanelProps {
  hypotheses: HypothesisWithStatus[];
  offset?: number;
  limit?: number;
}

/**
 * Progress bar for experiments
 */
function ExperimentProgress({ count }: { count: number }) {
  if (count === 0) return null;

  const dots = "●".repeat(Math.min(count, 5)) + (count > 5 ? "+" : "");
  return (
    <Text color={colors.accentPurple}>
      {dots} {count} exp
    </Text>
  );
}

export function HypothesesPanel({
  hypotheses,
  offset = 0,
  limit = 5,
}: HypothesesPanelProps) {
  if (hypotheses.length === 0) {
    return (
      <Box flexDirection="column" padding={2}>
        <Box marginBottom={1}>
          <Text color={colors.accentYellow}>{"◇ "}</Text>
          <Text color={colors.text}>No hypotheses yet</Text>
        </Box>
        <Text color={colors.textSecondary}>
          Hypotheses are created as the agent strategizes and plans experiments.
        </Text>
        <Box marginTop={1}>
          <Text color={colors.textMuted}>
            Start the agent to begin generating hypotheses.
          </Text>
        </Box>
      </Box>
    );
  }

  const total = hypotheses.length;
  const safeOffset = Math.min(offset, Math.max(0, total - 1));
  const displayHypotheses = hypotheses.slice(safeOffset, safeOffset + limit);
  const hasMore = safeOffset + limit < total;
  const hasPrev = safeOffset > 0;

  return (
    <Box flexDirection="column" paddingX={1}>
      {/* Pagination info */}
      {(hasPrev || hasMore) && (
        <Box marginBottom={1}>
          <Text color={colors.textMuted}>
            Showing {safeOffset + 1}-{Math.min(safeOffset + limit, total)} of{" "}
            {total}
          </Text>
          <Text color={colors.textSecondary}> (j/k to scroll)</Text>
        </Box>
      )}

      {/* Hypotheses list */}
      {displayHypotheses.map((h) => (
        <HypothesisCard key={h.id} hypothesis={h} />
      ))}
    </Box>
  );
}

interface HypothesisCardProps {
  hypothesis: HypothesisWithStatus;
}

function HypothesisCard({ hypothesis }: HypothesisCardProps) {
  const defaultConfig = {
    color: colors.accentYellow,
    icon: "○",
    label: "PENDING",
  };

  const statusConfig: Record<
    string,
    { color: string; icon: string; label: string }
  > = {
    pending: defaultConfig,
    keep: { color: colors.accentGreen, icon: "✓", label: "KEPT" },
    reject: { color: colors.accentRed, icon: "✗", label: "REJECTED" },
    iterate: { color: colors.accentBlue, icon: "↻", label: "ITERATING" },
    pivot: { color: colors.accentPurple, icon: "⟳", label: "PIVOTED" },
  };

  const config = statusConfig[hypothesis.status] ?? defaultConfig;

  // Get latest metrics if any experiments
  const latestExperiment =
    hypothesis.experiments[hypothesis.experiments.length - 1];
  const metrics = latestExperiment?.metrics;

  return (
    <Box
      flexDirection="column"
      borderStyle="single"
      borderColor={config.color}
      paddingX={2}
      paddingY={1}
      marginBottom={1}
    >
      {/* Header row */}
      <Box justifyContent="space-between" marginBottom={1}>
        <Box>
          <Text color={config.color} bold>
            {hypothesis.id}
          </Text>
          <Text color={colors.textMuted}> • </Text>
          <ExperimentProgress count={hypothesis.experiments.length} />
        </Box>
        <Box>
          <Text backgroundColor={config.color} color={colors.bgPrimary}>
            {" "}
            {config.icon} {config.label}{" "}
          </Text>
        </Box>
      </Box>

      {/* Hypothesis text */}
      <Box marginBottom={1}>
        <Text color={colors.text}>{hypothesis.hypothesis}</Text>
      </Box>

      {/* Expected vs Actual */}
      <Box flexDirection="column">
        {hypothesis.expected && (
          <Box>
            <Text color={colors.textMuted}>Expected: </Text>
            <Text color={colors.textSecondary}>{hypothesis.expected}</Text>
          </Box>
        )}

        {metrics && (
          <Box>
            <Text color={colors.textMuted}>Results: </Text>
            <Text color={colors.accentGreen}>
              {Object.entries(metrics)
                .map(
                  ([k, v]) =>
                    `${k}=${typeof v === "number" ? v.toFixed(3) : v}`,
                )
                .join(", ")}
            </Text>
          </Box>
        )}
      </Box>

      {/* Decision reason */}
      {hypothesis.decision && (
        <Box
          marginTop={1}
          borderStyle="single"
          borderColor={colors.border}
          paddingX={1}
        >
          <Text color={colors.textMuted}>→ </Text>
          <Text color={colors.textSecondary}>{hypothesis.decision.reason}</Text>
        </Box>
      )}
    </Box>
  );
}
