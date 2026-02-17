/**
 * Output screen - Raw agent stream events (text, tool calls, tool results)
 *
 * Shows the inner Claude agent's real-time iteration output.
 * Scroll: [ up, ] down, G follow latest
 */

import { useEffect, useRef, useState } from "react";
import { useAppStore } from "../../application/state/index.ts";
import type { StreamEvent } from "../../infrastructure/ralph/index.ts";
import { Box, Text, useInput } from "../ink.tsx";
import { colors } from "../theme/colors.ts";

// ── Event renderer ──────────────────────────────────────────────────

function StreamEventItem({ event }: { event: StreamEvent }) {
  if (event.type === "iteration_marker") {
    return (
      <Text wrap="truncate">
        <Text color={colors.accentPurple} bold>
          {event.content}
        </Text>
      </Text>
    );
  }

  if (event.type === "text") {
    // Agent reasoning — dimmed, wrap long text
    return (
      <Text wrap="wrap" color={colors.textMuted}>
        {event.content}
      </Text>
    );
  }

  if (event.type === "tool_call") {
    const name = event.toolName ?? "Tool";
    const desc = event.content;
    const agent = event.agentName ? ` (${event.agentName})` : "";
    return (
      <Text wrap="truncate">
        <Text color={colors.accentBlue} bold>
          [{name}]
        </Text>
        {desc ? <Text color={colors.textSecondary}> {desc}</Text> : null}
        {agent ? <Text color={colors.accentPurple}>{agent}</Text> : null}
      </Text>
    );
  }

  if (event.type === "tool_result") {
    const ok = !event.isError;
    return (
      <Text wrap="truncate">
        <Text color={ok ? colors.accentGreen : colors.accentRed}>
          {ok ? "  -> ok" : "  -> FAILED"}
        </Text>
      </Text>
    );
  }

  if (event.type === "error") {
    return (
      <Text wrap="wrap" color={colors.accentRed} bold>
        ERROR: {event.content}
      </Text>
    );
  }

  return null;
}

// ── Scroll ──────────────────────────────────────────────────────────

const PAGE_SIZE = 5;

interface OutputScreenProps {
  /** Disable scroll keys during dialogs */
  scrollActive?: boolean;
}

export function OutputScreen({ scrollActive = true }: OutputScreenProps) {
  const { agentOutput, agentStatus } = useAppStore();
  const maxVisible = 30;

  const [scrollPos, setScrollPos] = useState(0);
  const [following, setFollowing] = useState(true);

  const total = agentOutput.length;
  const maxScrollPos = Math.max(0, total - maxVisible);

  const maxRef = useRef(maxScrollPos);
  maxRef.current = maxScrollPos;

  // Auto-follow
  useEffect(() => {
    if (following) setScrollPos(Math.max(0, total - maxVisible));
  }, [total, following, maxVisible]);

  // Scroll keys — reuse [ ] G pattern from activity feed
  useInput(
    (input) => {
      const max = maxRef.current;
      if (input === "[") {
        setScrollPos((p) => Math.max(0, p - PAGE_SIZE));
        setFollowing(false);
      } else if (input === "]") {
        setScrollPos((p) => {
          const next = Math.min(max, p + PAGE_SIZE);
          if (next >= max) setFollowing(true);
          return next;
        });
      } else if (input === "G") {
        setScrollPos(max);
        setFollowing(true);
      }
    },
    { isActive: scrollActive },
  );

  // Empty state
  if (total === 0) {
    return (
      <Box flexDirection="column" padding={1} flexGrow={1}>
        <Box paddingX={1} marginBottom={1}>
          <Text color={colors.accentBlue} bold>
            Agent Output
          </Text>
          <Text color={colors.textMuted}> — raw stream events</Text>
        </Box>
        <Box paddingX={1}>
          <Text color={colors.textMuted}>
            {agentStatus === "running"
              ? "Waiting for output..."
              : "No output yet — press 's' to start the agent."}
          </Text>
        </Box>
      </Box>
    );
  }

  // Visible window
  const pos = Math.min(scrollPos, maxScrollPos);
  const visible = agentOutput.slice(pos, pos + maxVisible);
  const above = pos;
  const below = Math.max(0, total - pos - maxVisible);

  return (
    <Box flexDirection="column" flexGrow={1}>
      {/* Header */}
      <Box paddingX={1} justifyContent="space-between">
        <Box>
          <Text color={colors.accentBlue} bold>
            Agent Output
          </Text>
          <Text color={colors.textMuted}> — {total} events</Text>
        </Box>
        <Text
          color={
            agentStatus === "running" ? colors.accentGreen : colors.textMuted
          }
        >
          {agentStatus === "running" ? "● Running" : "○ Idle"}
        </Text>
      </Box>

      {/* Scroll-up indicator */}
      {above > 0 && (
        <Box paddingX={1}>
          <Text color={colors.textMuted} dimColor>
            {"↑ "}
            {above} earlier — [
          </Text>
        </Box>
      )}

      {/* Events */}
      <Box flexDirection="column" paddingX={1} flexGrow={1} overflow="hidden">
        {visible.map((event, i) => (
          <StreamEventItem key={pos + i} event={event} />
        ))}
      </Box>

      {/* Scroll-down indicator */}
      {below > 0 && (
        <Box paddingX={1}>
          <Text color={colors.accentYellow}>
            {"↓ "}
            {below} newer
          </Text>
          <Text color={colors.textMuted}>{" — ] · "}</Text>
          <Text color={colors.accentGreen}>G</Text>
          <Text color={colors.textMuted}>{" follow"}</Text>
        </Box>
      )}
    </Box>
  );
}
