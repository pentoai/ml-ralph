/**
 * Monitor screen - Agent output + Knowledge panel
 *
 * Shows agent activity feed on the left and knowledge tabs on the right.
 */

import { useAppStore } from "../../application/state/index.ts";
import { useLogStream } from "../hooks/index.ts";
import { Box, Text } from "../ink.tsx";
import { colors } from "../theme/colors.ts";
import { ActivityFeed } from "../widgets/activity-feed.tsx";
import { KnowledgePanel } from "../widgets/knowledge-panel.tsx";

interface MonitorScreenProps {
  currentIteration?: number;
  startTime?: number;
  projectPath?: string;
  /** Disable scroll keys (e.g. when a dialog is open) */
  scrollActive?: boolean;
}

export function MonitorScreen({
  currentIteration = 0,
  startTime = 0,
  projectPath = "",
  scrollActive = true,
}: MonitorScreenProps) {
  const { agentStatus } = useAppStore();

  const resolvedPath = projectPath || process.cwd();

  // Stream log.jsonl events incrementally
  const { events: logEvents } = useLogStream({
    projectPath: resolvedPath,
    pollInterval: 1000,
  });

  return (
    <Box flexDirection="row" height="100%">
      {/* Left panel - Activity feed (40%) */}
      <Box
        flexDirection="column"
        width="40%"
        borderStyle="single"
        borderColor={
          agentStatus === "running" ? colors.accentBlue : colors.textMuted
        }
      >
        <Box paddingX={1} justifyContent="space-between">
          <Text color={colors.accentBlue} bold>
            Activity
          </Text>
          <Text
            color={
              agentStatus === "running" ? colors.accentGreen : colors.textMuted
            }
          >
            {agentStatus === "running" ? "● Running" : "○ Idle"}
          </Text>
        </Box>
        <Box flexDirection="column" paddingX={1} flexGrow={1} overflow="hidden">
          <ActivityFeed
            logEvents={logEvents}
            currentIteration={currentIteration}
            startTime={startTime}
            isRunning={agentStatus === "running"}
            scrollActive={scrollActive}
          />
        </Box>
      </Box>

      {/* Right panel - Knowledge tabs (60%) */}
      <Box flexDirection="column" width="60%">
        <KnowledgePanel />
      </Box>
    </Box>
  );
}
