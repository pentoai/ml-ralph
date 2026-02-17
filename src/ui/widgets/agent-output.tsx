/**
 * Agent output widget - displays streaming output from Claude Code
 */

import type { StreamEvent } from "../../infrastructure/ralph/index.ts";
import { Box, Text } from "../ink.tsx";
import { colors } from "../theme/colors.ts";

interface AgentOutputProps {
  events: StreamEvent[];
  maxLines?: number;
  currentIteration?: number;
}

export function AgentOutput({
  events,
  maxLines = 50,
  currentIteration = 0,
}: AgentOutputProps) {
  if (events.length === 0) {
    return (
      <Box flexDirection="column" padding={1}>
        <Text color={colors.textMuted}>No output yet</Text>
        <Text color={colors.textMuted}>Press 's' to start the agent.</Text>
      </Box>
    );
  }

  // Show the last N events
  const displayEvents = events.slice(-maxLines);

  return (
    <Box flexDirection="column">
      {currentIteration > 0 && (
        <Box marginBottom={1}>
          <Text color={colors.accentBlue} bold>
            Iteration {currentIteration}
          </Text>
        </Box>
      )}
      {displayEvents.map((event, index) => (
        <OutputEvent key={`${event.type}-${index}`} event={event} />
      ))}
    </Box>
  );
}

interface OutputEventProps {
  event: StreamEvent;
}

function OutputEvent({ event }: OutputEventProps) {
  switch (event.type) {
    case "iteration_marker":
      return (
        <Box marginY={1}>
          <Text color={colors.accentYellow} bold>
            {event.content}
          </Text>
        </Box>
      );

    case "text":
      return <TextOutput text={event.content} />;

    case "tool_call":
      return (
        <Box>
          <Text color={colors.textMuted}>► </Text>
          <Text color={colors.accentBlue}>{event.toolName}</Text>
          {event.content && (
            <Text color={colors.textSecondary}>
              : {event.content.slice(0, 60)}
              {event.content.length > 60 ? "..." : ""}
            </Text>
          )}
        </Box>
      );

    case "tool_result":
      return (
        <Text color={event.isError ? colors.accentRed : colors.accentGreen}>
          {event.isError ? " ✗" : " ✓"}
        </Text>
      );

    case "error":
      return <Text color={colors.accentRed}>Error: {event.content}</Text>;

    default:
      return null;
  }
}

function TextOutput({ text }: { text: string }) {
  // Detect errors
  if (
    text.toLowerCase().includes("error") ||
    text.toLowerCase().includes("failed")
  ) {
    return <Text color={colors.accentRed}>{text}</Text>;
  }

  // Detect success/completion markers
  if (
    text.includes("<iteration_complete>") ||
    text.includes("<project_complete>")
  ) {
    return <Text color={colors.accentGreen}>{text}</Text>;
  }

  // Detect phase markers
  if (
    text.includes("ORIENT") ||
    text.includes("RESEARCH") ||
    text.includes("HYPOTHESIZE") ||
    text.includes("EXECUTE") ||
    text.includes("ANALYZE") ||
    text.includes("VALIDATE") ||
    text.includes("DECIDE")
  ) {
    return <Text color={colors.accentBlue}>{text}</Text>;
  }

  // Default
  return <Text color={colors.textPrimary}>{text}</Text>;
}

// Keep old interface for backward compatibility
interface LegacyAgentOutputProps {
  lines: string[];
  maxLines?: number;
}

export function LegacyAgentOutput({
  lines,
  maxLines = 20,
}: LegacyAgentOutputProps) {
  if (lines.length === 0) {
    return (
      <Box flexDirection="column" padding={1}>
        <Text color={colors.textMuted}>No output yet</Text>
        <Text color={colors.textMuted}>
          Start the agent to see execution output.
        </Text>
      </Box>
    );
  }

  // Show the last N lines
  const displayLines = lines.slice(-maxLines);

  return (
    <Box flexDirection="column">
      {displayLines.map((line, index) => (
        <OutputLine key={`${line}-${index}`} line={line} />
      ))}
    </Box>
  );
}

interface OutputLineProps {
  line: string;
}

function OutputLine({ line }: OutputLineProps) {
  // Detect tool usage patterns
  if (line.startsWith("> ") || line.startsWith("─")) {
    return <Text color={colors.accentBlue}>{line}</Text>;
  }

  // Detect errors
  if (
    line.toLowerCase().includes("error") ||
    line.toLowerCase().includes("failed")
  ) {
    return <Text color={colors.accentRed}>{line}</Text>;
  }

  // Detect success
  if (
    line.toLowerCase().includes("success") ||
    line.toLowerCase().includes("complete")
  ) {
    return <Text color={colors.accentGreen}>{line}</Text>;
  }

  // Default
  return <Text color={colors.textPrimary}>{line}</Text>;
}

interface ToolActivityProps {
  tool: string;
  status: "running" | "completed" | "error";
  input?: string;
}

export function ToolActivity({ tool, status, input }: ToolActivityProps) {
  const statusColor =
    status === "running"
      ? colors.accentYellow
      : status === "completed"
        ? colors.accentGreen
        : colors.accentRed;

  const statusIcon =
    status === "running" ? "◐" : status === "completed" ? "✓" : "✗";

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={statusColor}
      paddingX={1}
      marginY={1}
    >
      <Box gap={1}>
        <Text color={statusColor}>{statusIcon}</Text>
        <Text color={colors.accentBlue} bold>
          {tool}
        </Text>
      </Box>
      {input && (
        <Text color={colors.textSecondary} wrap="truncate">
          {input.slice(0, 60)}
          {input.length > 60 ? "..." : ""}
        </Text>
      )}
    </Box>
  );
}
