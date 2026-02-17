/**
 * Current task widget - shows current story and hypothesis
 */

import type { Story } from "../../domain/types/index.ts";
import { Box, Text } from "../ink.tsx";
import { colors } from "../theme/colors.ts";

interface CurrentTaskProps {
  story: Story | null;
}

export function CurrentTask({ story }: CurrentTaskProps) {
  if (!story) {
    return (
      <Box
        flexDirection="column"
        borderStyle="single"
        borderColor={colors.textMuted}
        paddingX={1}
      >
        <Text color={colors.textMuted}>No active story</Text>
      </Box>
    );
  }

  return (
    <Box
      flexDirection="column"
      borderStyle="single"
      borderColor={colors.accentBlue}
      paddingX={1}
    >
      <Text color={colors.textMuted}>Current Story</Text>
      <Box gap={1}>
        <Text color={colors.accentBlue} bold>
          {story.id}:
        </Text>
        <Text color={colors.textPrimary}>{story.title}</Text>
      </Box>

      <Text color={colors.textMuted} dimColor>
        ─────────────────────────
      </Text>

      <Text color={colors.textMuted}>Hypothesis:</Text>
      <Text color={colors.textSecondary} wrap="wrap">
        {story.hypothesis}
      </Text>
    </Box>
  );
}
