/**
 * Research panel - displays research from log.jsonl
 * Matches the visual structure of hypotheses-panel.tsx
 */

import type { ResearchEvent } from "../../infrastructure/ralph/index.ts";
import { Box, Text } from "../ink.tsx";
import { colors } from "../theme/colors.ts";

interface ResearchPanelProps {
  research: ResearchEvent[];
  offset?: number;
  limit?: number;
}

/**
 * Get configuration for research source type
 */
function getSourceConfig(source: string): {
  type: string;
  icon: string;
  color: string;
  label: string;
} {
  const lower = source.toLowerCase();

  if (lower.includes("kaggle")) {
    return {
      type: "kaggle",
      icon: "🏆",
      color: colors.accentYellow,
      label: "KAGGLE",
    };
  }
  if (
    lower.includes("paper") ||
    lower.includes("arxiv") ||
    lower.includes("research")
  ) {
    return {
      type: "paper",
      icon: "📄",
      color: colors.accentPurple,
      label: "PAPER",
    };
  }
  if (
    lower.includes("github") ||
    lower.includes("repo") ||
    lower.includes("code")
  ) {
    return {
      type: "github",
      icon: "💻",
      color: colors.accentGreen,
      label: "GITHUB",
    };
  }
  if (
    lower.includes("doc") ||
    lower.includes("documentation") ||
    lower.includes("guide")
  ) {
    return {
      type: "docs",
      icon: "📚",
      color: colors.accentBlue,
      label: "DOCS",
    };
  }
  if (
    lower.includes("blog") ||
    lower.includes("article") ||
    lower.includes("post")
  ) {
    return {
      type: "blog",
      icon: "📝",
      color: colors.accentCyan,
      label: "BLOG",
    };
  }
  return {
    type: "other",
    icon: "🔍",
    color: colors.accentBlue,
    label: "SOURCE",
  };
}

/**
 * Format relative time
 */
function formatRelativeTime(dateStr: string): string {
  const date = new Date(dateStr);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMins / 60);
  const diffDays = Math.floor(diffHours / 24);

  if (diffMins < 1) return "just now";
  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  if (diffDays < 7) return `${diffDays}d ago`;
  return date.toLocaleDateString();
}

export function ResearchPanel({
  research,
  offset = 0,
  limit = 5,
}: ResearchPanelProps) {
  if (research.length === 0) {
    return (
      <Box flexDirection="column" padding={2}>
        <Box marginBottom={1}>
          <Text color={colors.accentYellow}>{"◇ "}</Text>
          <Text color={colors.text}>No research yet</Text>
        </Box>
        <Text color={colors.textSecondary}>
          Research findings are collected as the agent explores solutions.
        </Text>
        <Box marginTop={1}>
          <Text color={colors.textMuted}>
            Start the agent to begin collecting research.
          </Text>
        </Box>
      </Box>
    );
  }

  // Sort by timestamp descending (newest first)
  const sortedResearch = [...research].sort(
    (a, b) => new Date(b.ts).getTime() - new Date(a.ts).getTime(),
  );

  const total = sortedResearch.length;
  const safeOffset = Math.min(offset, Math.max(0, total - 1));
  const displayResearch = sortedResearch.slice(safeOffset, safeOffset + limit);
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

      {/* Research list */}
      {displayResearch.map((item, index) => (
        <ResearchCard key={`${item.ts}-${index}`} item={item} />
      ))}
    </Box>
  );
}

interface ResearchCardProps {
  item: ResearchEvent;
}

function ResearchCard({ item }: ResearchCardProps) {
  const config = getSourceConfig(item.source);
  const timeAgo = formatRelativeTime(item.ts);

  // Type-safe access to optional fields
  const extendedItem = item as ResearchEvent & {
    url?: string;
    key_insights?: string[];
  };

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
            {config.icon}
          </Text>
          <Text color={colors.textMuted}> • </Text>
          <Text color={colors.textMuted}>{timeAgo}</Text>
        </Box>
        <Box>
          <Text backgroundColor={config.color} color={colors.bgPrimary}>
            {" "}
            {config.label}{" "}
          </Text>
        </Box>
      </Box>

      {/* Source name */}
      <Box marginBottom={1}>
        <Text color={colors.text} bold>
          {item.source}
        </Text>
      </Box>

      {/* Insight */}
      {item.insight && (
        <Box
          marginBottom={extendedItem.url || extendedItem.key_insights ? 1 : 0}
        >
          <Text color={colors.textSecondary}>{item.insight}</Text>
        </Box>
      )}

      {/* Key insights if available */}
      {extendedItem.key_insights && extendedItem.key_insights.length > 0 && (
        <Box flexDirection="column" marginBottom={extendedItem.url ? 1 : 0}>
          {extendedItem.key_insights.map((insight, i) => (
            <Box key={i}>
              <Text color={colors.accentGreen}> → </Text>
              <Text color={colors.textSecondary}>{insight}</Text>
            </Box>
          ))}
        </Box>
      )}

      {/* URL if available */}
      {extendedItem.url && (
        <Box>
          <Text color={colors.textMuted}>🔗 </Text>
          <Text color={colors.accentCyan}>{extendedItem.url}</Text>
        </Box>
      )}
    </Box>
  );
}
