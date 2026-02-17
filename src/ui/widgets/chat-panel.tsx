/**
 * Chat panel widget - for PRD creation conversation
 * Features: Markdown rendering, tool display, scrolling
 */

import { useState } from "react";
import type { ChatMessage, ToolCall } from "../../domain/types/index.ts";
import { Box, Text, useInput } from "../ink.tsx";
import { colors } from "../theme/colors.ts";
import { Markdown } from "./markdown.tsx";
import Spinner from "./spinner.tsx";

interface ChatPanelProps {
  messages: ChatMessage[];
  onSendMessage: (content: string) => void;
  isLoading?: boolean;
  currentTool?: string | null;
  maxMessages?: number;
  inputMode?: boolean;
}

export function ChatPanel({
  messages,
  onSendMessage,
  isLoading = false,
  currentTool = null,
  maxMessages = 20,
  inputMode = false,
}: ChatPanelProps) {
  const [input, setInput] = useState("");

  useInput((inputChar, key) => {
    if (!inputMode) return;

    if (key.return && input.trim() && !isLoading) {
      onSendMessage(input.trim());
      setInput("");
    } else if (key.backspace || key.delete) {
      setInput((prev) => prev.slice(0, -1));
    } else if (!key.ctrl && !key.meta && !key.escape && inputChar) {
      setInput((prev) => prev + inputChar);
    }
  });

  // Show last N messages
  const displayMessages = messages.slice(-maxMessages);

  return (
    <Box flexDirection="column" height="100%">
      {/* Messages area */}
      <Box flexDirection="column" flexGrow={1} overflowY="hidden">
        {displayMessages.length === 0 ? (
          <Box padding={1}>
            <Text color={colors.textMuted}>
              Start a conversation to create your PRD.
            </Text>
          </Box>
        ) : (
          displayMessages.map((msg) => (
            <MessageBubble key={msg.id} message={msg} />
          ))
        )}

        {/* Loading indicator */}
        {isLoading && (
          <Box paddingX={1} paddingY={0}>
            <Text color={colors.accentYellow}>
              <Spinner type="dots" />{" "}
              {currentTool ? (
                <Text>
                  <Text bold>{currentTool}</Text>
                </Text>
              ) : (
                "Thinking..."
              )}
            </Text>
          </Box>
        )}
      </Box>

      {/* Input area */}
      <Box
        borderStyle="round"
        borderColor={inputMode ? colors.accentBlue : colors.textMuted}
        paddingX={1}
        marginTop={1}
      >
        <Text color={inputMode ? colors.accentGreen : colors.textMuted}>
          {inputMode ? "› " : "> "}
        </Text>
        <Text>{input || (inputMode ? "" : "(press i to type)")}</Text>
        {inputMode && <Text color={colors.accentBlue}>▌</Text>}
      </Box>
    </Box>
  );
}

interface MessageBubbleProps {
  message: ChatMessage;
}

function MessageBubble({ message }: MessageBubbleProps) {
  const isUser = message.role === "user";

  return (
    <Box flexDirection="column" paddingX={1} paddingY={0} marginBottom={1}>
      {/* Role indicator */}
      <Box>
        <Text
          color={isUser ? colors.accentGreen : colors.accentBlue}
          bold
          dimColor={false}
        >
          {isUser ? "You" : "Claude"}
        </Text>
      </Box>

      {/* Message content with markdown */}
      <Box marginLeft={1} flexDirection="column">
        {message.content ? (
          <Markdown>{message.content}</Markdown>
        ) : (
          <Text color={colors.textMuted}>...</Text>
        )}
      </Box>

      {/* Tool calls display */}
      {message.toolCalls && message.toolCalls.length > 0 && (
        <Box marginLeft={1} flexDirection="column" marginTop={0}>
          {message.toolCalls.map((tool) => (
            <ToolCallDisplay key={tool.id} tool={tool} />
          ))}
        </Box>
      )}
    </Box>
  );
}

interface ToolCallDisplayProps {
  tool: ToolCall;
}

function ToolCallDisplay({ tool }: ToolCallDisplayProps) {
  const statusColor =
    tool.status === "running"
      ? colors.accentYellow
      : tool.status === "completed"
        ? colors.accentGreen
        : colors.accentRed;

  const statusIcon =
    tool.status === "running" ? "◐" : tool.status === "completed" ? "✓" : "✗";

  return (
    <Box>
      <Text color={statusColor}>{statusIcon} </Text>
      <Text color={colors.textMuted}>{tool.tool}</Text>
    </Box>
  );
}
