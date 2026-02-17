/**
 * Claude chat widget - embedded Claude Code chat interface
 */

import { useState } from "react";
import type { ChatMessage, ToolCall } from "../hooks/index.ts";
import { Box, Text, useInput } from "../ink.tsx";
import { colors } from "../theme/colors.ts";
import Spinner from "./spinner.tsx";

// ============================================================================
// Props
// ============================================================================

interface ClaudeChatProps {
  messages: ChatMessage[];
  isConnected: boolean;
  isStreaming: boolean;
  error: string | null;
  inputMode: boolean;
  onSendMessage: (content: string) => void;
}

// ============================================================================
// Main Component
// ============================================================================

export function ClaudeChat({
  messages,
  isConnected,
  isStreaming,
  error,
  inputMode,
  onSendMessage,
}: ClaudeChatProps) {
  const [input, setInput] = useState("");

  // Handle input
  useInput(
    (char, key) => {
      if (!inputMode) return;

      if (key.return && input.trim() && !isStreaming) {
        onSendMessage(input.trim());
        setInput("");
      } else if (key.backspace || key.delete) {
        setInput((prev) => prev.slice(0, -1));
      } else if (!key.ctrl && !key.meta && !key.escape && char) {
        setInput((prev) => prev + char);
      }
    },
    { isActive: inputMode },
  );

  // Get visible messages (last N)
  const visibleMessages = messages.slice(-20);

  return (
    <Box flexDirection="column" flexGrow={1}>
      {/* Messages area */}
      <Box flexDirection="column" flexGrow={1} overflowY="hidden">
        {visibleMessages.length === 0 ? (
          <EmptyState isConnected={isConnected} inputMode={inputMode} />
        ) : (
          visibleMessages.map((msg, idx) => (
            <MessageBubble
              key={msg.id}
              message={msg}
              isLast={idx === visibleMessages.length - 1}
            />
          ))
        )}

        {/* Streaming indicator */}
        {isStreaming && !visibleMessages.some((m) => m.isStreaming) && (
          <Box paddingX={1} paddingY={0}>
            <Text color={colors.accentYellow}>
              <Spinner type="dots" />
            </Text>
            <Text color={colors.textMuted}> Thinking...</Text>
          </Box>
        )}

        {/* Error display */}
        {error && !error.includes("exited with code") && (
          <Box paddingX={1} marginTop={1}>
            <Text color={colors.accentRed}>⚠ {error}</Text>
          </Box>
        )}
      </Box>

      {/* Input area */}
      <Box
        borderStyle="round"
        borderColor={inputMode ? colors.accentGreen : colors.border}
        paddingX={1}
      >
        <Text color={inputMode ? colors.accentGreen : colors.textMuted}>
          {inputMode ? "› " : "› "}
        </Text>
        <Text color={inputMode ? colors.text : colors.textMuted}>
          {input || (inputMode ? "" : "press i to chat")}
        </Text>
        {inputMode && <Text color={colors.accentGreen}>▎</Text>}
      </Box>
    </Box>
  );
}

// ============================================================================
// Empty State
// ============================================================================

interface EmptyStateProps {
  isConnected: boolean;
  inputMode: boolean;
}

function EmptyState({ isConnected, inputMode }: EmptyStateProps) {
  if (!isConnected) {
    return (
      <Box flexDirection="column" padding={1}>
        <Box>
          <Text color={colors.accentYellow}>
            <Spinner type="dots" />
          </Text>
          <Text color={colors.textMuted}> Starting Claude...</Text>
        </Box>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" padding={1}>
      <Text color={colors.textMuted}>
        {inputMode
          ? "Type your message and press Enter"
          : "Press i to start chatting"}
      </Text>
    </Box>
  );
}

// ============================================================================
// Message Bubble
// ============================================================================

interface MessageBubbleProps {
  message: ChatMessage;
  isLast: boolean;
}

function MessageBubble({ message, isLast }: MessageBubbleProps) {
  const isUser = message.role === "user";

  return (
    <Box
      flexDirection="column"
      paddingX={1}
      paddingTop={0}
      paddingBottom={isLast ? 0 : 1}
    >
      {/* Role indicator */}
      <Box>
        <Text color={isUser ? colors.accentGreen : colors.accentBlue} bold>
          {isUser ? "You" : "Claude"}
        </Text>
        {message.isStreaming && (
          <Text color={colors.textMuted}>
            {" "}
            <Spinner type="dots" />
          </Text>
        )}
      </Box>

      {/* Message content */}
      <Box marginLeft={2} flexDirection="column">
        {message.content ? (
          <Text wrap="wrap">{message.content}</Text>
        ) : message.isStreaming ? (
          <Text color={colors.textMuted}>...</Text>
        ) : null}
      </Box>

      {/* Tool calls */}
      {message.tools && message.tools.length > 0 && (
        <Box marginLeft={2} flexDirection="column" marginTop={0}>
          {message.tools.map((tool) => (
            <ToolCallDisplay key={tool.id} tool={tool} />
          ))}
        </Box>
      )}
    </Box>
  );
}

// ============================================================================
// Tool Call Display
// ============================================================================

interface ToolCallDisplayProps {
  tool: ToolCall;
}

function ToolCallDisplay({ tool }: ToolCallDisplayProps) {
  const statusColor =
    tool.status === "running"
      ? colors.accentYellow
      : tool.status === "completed"
        ? colors.textMuted
        : colors.accentRed;

  const statusIcon =
    tool.status === "running" ? "◐" : tool.status === "completed" ? "✓" : "✗";

  return (
    <Box>
      <Text color={statusColor}>
        {tool.status === "running" ? <Spinner type="dots" /> : statusIcon}{" "}
      </Text>
      <Text color={colors.textMuted}>{tool.name}</Text>
    </Box>
  );
}
