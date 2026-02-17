/**
 * Story list widget
 */

import type { Story } from "../../domain/types/index.ts";
import { Box, Text } from "../ink.tsx";
import {
  colors,
  getStoryStatusColor,
  getStoryStatusSymbol,
} from "../theme/colors.ts";

interface StoryListProps {
  stories: Story[];
  maxHeight?: number;
}

export function StoryList({ stories, maxHeight }: StoryListProps) {
  if (stories.length === 0) {
    return (
      <Box flexDirection="column" padding={1}>
        <Text color={colors.textMuted}>No stories yet</Text>
        <Text color={colors.textMuted}>
          Create a PRD to define your project stories.
        </Text>
      </Box>
    );
  }

  const displayStories = maxHeight ? stories.slice(0, maxHeight) : stories;

  return (
    <Box flexDirection="column">
      {displayStories.map((story) => (
        <StoryItem key={story.id} story={story} />
      ))}
      {maxHeight && stories.length > maxHeight && (
        <Text color={colors.textMuted}>
          ... and {stories.length - maxHeight} more
        </Text>
      )}
    </Box>
  );
}

interface StoryItemProps {
  story: Story;
}

function StoryItem({ story }: StoryItemProps) {
  const statusSymbol = getStoryStatusSymbol(story.status);
  const statusColor = getStoryStatusColor(story.status);
  const isCurrent = story.status === "in_progress";

  return (
    <Box flexDirection="column" marginBottom={1}>
      <Box gap={1}>
        <Text color={statusColor}>{statusSymbol}</Text>
        <Text color={colors.textMuted}>{story.id}</Text>
        <Text color={colors.textMuted}>{story.type}</Text>
        <Text
          color={isCurrent ? colors.accentBlue : colors.textPrimary}
          bold={isCurrent}
        >
          {story.title}
        </Text>
        {isCurrent && <Text color={colors.accentBlue}>← current</Text>}
        {story.supersededBy && (
          <Text color={colors.textMuted}>(→ {story.supersededBy})</Text>
        )}
      </Box>
      <Box marginLeft={3}>
        <Text color={colors.textSecondary} wrap="truncate">
          {story.description.slice(0, 70)}
          {story.description.length > 70 ? "..." : ""}
        </Text>
      </Box>
    </Box>
  );
}
