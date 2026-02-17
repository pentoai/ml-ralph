/**
 * Status bar widget - persistent across all screens
 */

import { useAppStore } from "../../application/state/index.ts";
import { countStoriesByStatus } from "../../domain/logic/index.ts";
import { Box, Text } from "../ink.tsx";
import { colors } from "../theme/colors.ts";

export function StatusBar() {
  const { agentStatus, prd, activeJobs, mode } = useAppStore();

  const storyCounts = prd ? countStoriesByStatus(prd.stories) : null;
  const currentStory = prd?.stories.find((s) => s.status === "in_progress");

  const statusColor =
    agentStatus === "running"
      ? colors.statusRunning
      : agentStatus === "paused"
        ? colors.accentYellow
        : colors.textMuted;

  return (
    <Box
      borderStyle="single"
      borderColor={colors.textMuted}
      paddingX={1}
      justifyContent="space-between"
    >
      <Box gap={2}>
        <Text>
          Status:{" "}
          <Text color={statusColor}>
            {agentStatus.charAt(0).toUpperCase() + agentStatus.slice(1)}
          </Text>
        </Text>

        {currentStory && (
          <Text>
            Story:{" "}
            <Text color={colors.accentBlue}>
              {currentStory.id}: {currentStory.title.slice(0, 30)}
              {currentStory.title.length > 30 ? "..." : ""}
            </Text>
          </Text>
        )}

        {storyCounts && (
          <Text>
            Progress: <Text color={colors.accentGreen}>{storyCounts.done}</Text>
            /<Text>{storyCounts.total}</Text>
          </Text>
        )}

        {activeJobs.length > 0 && (
          <Text>
            Jobs: <Text color={colors.accentYellow}>{activeJobs.length}</Text>
          </Text>
        )}
      </Box>

      <Text color={colors.textMuted}>
        Mode: {mode.charAt(0).toUpperCase() + mode.slice(1)}
      </Text>
    </Box>
  );
}
