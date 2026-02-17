/**
 * Activity Feed — shows Ralph's structured log events
 *
 * Only displays events from log.jsonl (hypotheses, experiments,
 * decisions, learnings, phases, etc.). Stream events (Claude's
 * raw thinking and tool calls) are intentionally excluded.
 *
 * Scroll: [ up, ] down, G follow latest
 */

import { useEffect, useMemo, useRef, useState } from "react";
import type { RalphEvent } from "../../infrastructure/ralph/templates.ts";
import { Box, Text, useInput, useStdout } from "../ink.tsx";
import { colors } from "../theme/colors.ts";
import { CognitiveMap } from "./cognitive-map.tsx";
import { formatLogActivity } from "./log-event-formatter.ts";

// ── Helpers ──────────────────────────────────────────────────────────

function formatElapsed(startTime: number): string {
  const elapsed = Math.floor((Date.now() - startTime) / 1000);
  const minutes = Math.floor(elapsed / 60);
  const seconds = elapsed % 60;
  if (minutes === 0) return `${seconds}s`;
  return `${minutes}m ${seconds}s`;
}

// ── Status Bar ───────────────────────────────────────────────────────

function StatusBar({
  iteration,
  startTime,
  isRunning,
}: {
  iteration: number;
  startTime: number;
  isRunning: boolean;
}) {
  if (!isRunning && iteration === 0) return null;

  return (
    <Box
      borderStyle="single"
      borderColor={colors.accentBlue}
      paddingX={1}
      marginBottom={1}
    >
      <Box marginRight={2}>
        <Text color={isRunning ? colors.accentGreen : colors.textMuted}>
          {isRunning ? "●" : "○"}
        </Text>
        <Text color={colors.textMuted}> </Text>
        <Text color={colors.text} bold>
          Iteration {iteration}
        </Text>
      </Box>
      {startTime > 0 && (
        <Box>
          <Text color={colors.textMuted}>│ </Text>
          <Text color={colors.textSecondary}>{formatElapsed(startTime)}</Text>
        </Box>
      )}
    </Box>
  );
}

// ── Log event renderers ─────────────────────────────────────────────

const HIGH_SIGNAL = new Set([
  "hypothesis",
  "learning",
  "decision",
  "research",
  "mental_model",
  "path_analysis",
  "data_verified",
  "result_verification",
  "success_verified",
]);

const MIN_WRAP_WIDTH = 24;
const MIN_VISIBLE_LINES = 8;
const RESERVED_SCREEN_ROWS = 14;
const MONITOR_LEFT_PANEL_RATIO = 0.4;
const PANEL_CHROME_COLUMNS = 4;

export const __testing = {
  computeVisibleLineBudget,
  computeTextWidth,
  padForStableRedraw,
  wrapTextForDisplay,
};

function computeVisibleLineBudget(
  terminalRows: number,
  explicit?: number,
): number {
  if (explicit !== undefined) return Math.max(MIN_VISIBLE_LINES, explicit);
  return Math.max(MIN_VISIBLE_LINES, terminalRows - RESERVED_SCREEN_ROWS);
}

function computeTextWidth(terminalColumns: number): number {
  return Math.max(
    MIN_WRAP_WIDTH,
    Math.floor(terminalColumns * MONITOR_LEFT_PANEL_RATIO) - PANEL_CHROME_COLUMNS,
  );
}

function wrapTextForDisplay(text: string, maxWidth: number): string[] {
  if (!text) return [""];
  const width = Math.max(MIN_WRAP_WIDTH, Math.floor(maxWidth));
  const words = text.replace(/\s+/g, " ").trim().split(" ");
  if (words.length === 0) return [""];

  const lines: string[] = [];
  let current = "";

  for (const word of words) {
    if (word.length > width) {
      if (current) {
        lines.push(current);
        current = "";
      }
      for (let i = 0; i < word.length; i += width) {
        lines.push(word.slice(i, i + width));
      }
      continue;
    }

    if (!current) {
      current = word;
      continue;
    }

    if (current.length + 1 + word.length <= width) {
      current += ` ${word}`;
    } else {
      lines.push(current);
      current = word;
    }
  }

  if (current) lines.push(current);
  return lines;
}

function padForStableRedraw(text: string, width: number): string {
  if (text.length >= width) return text;
  return text.padEnd(width, " ");
}

interface ActivityVisualLine {
  bold: boolean;
  color: string;
  id: string;
  text: string;
}

// ── Scroll ───────────────────────────────────────────────────────────

const PAGE_SIZE = 5;

interface ActivityFeedProps {
  logEvents?: RalphEvent[];
  /** Max visible text lines (default 25) */
  maxVisible?: number;
  currentIteration?: number;
  startTime?: number;
  isRunning?: boolean;
  /** Disable scroll keys during dialogs */
  scrollActive?: boolean;
}

// ── Main Feed ────────────────────────────────────────────────────────

export function ActivityFeed({
  logEvents,
  maxVisible,
  currentIteration = 0,
  startTime = 0,
  isRunning = false,
  scrollActive = true,
}: ActivityFeedProps) {
  const { stdout } = useStdout();
  const [scrollPos, setScrollPos] = useState(0);
  const [following, setFollowing] = useState(true);
  const visibleLineBudget = computeVisibleLineBudget(stdout?.rows ?? 24, maxVisible);
  const maxLineWidth = computeTextWidth(stdout?.columns ?? 120);

  // ── Convert log events to activities ──
  const activities = useMemo(() => {
    if (!logEvents?.length) return [];
    return logEvents.map((e, i) => formatLogActivity(e, i));
  }, [logEvents]);

  const visualLines = useMemo(() => {
    const lines: ActivityVisualLine[] = [];

    for (const activity of activities) {
      const t = activity.logEventType ?? "";

      // Experiments are displayed in the dedicated experiments panel.
      if (t === "experiment") continue;

      const icon = activity.logEventIcon ?? ".";
      const colorKey = activity.logEventColor ?? "textMuted";
      const color =
        (colors as Record<string, string>)[colorKey] || colors.textMuted;
      const dim = activity.logEventDim ?? !HIGH_SIGNAL.has(t);
      const c = dim ? colors.textMuted : color;
      const INDENT = "  ";
      const wrapped = wrapTextForDisplay(
        `${icon} ${activity.content}`,
        maxLineWidth - INDENT.length,
      );

      for (let i = 0; i < wrapped.length; i += 1) {
        const text = wrapped[i] ?? "";
        lines.push({
          id: `${activity.id}:${i}`,
          text: i === 0 ? text : `${INDENT}${text}`,
          color: c,
          bold: t === "strategic_retreat",
        });
      }
    }

    return lines;
  }, [activities, maxLineWidth]);

  const total = visualLines.length;
  const maxScrollPos = Math.max(0, total - visibleLineBudget);

  const maxRef = useRef(maxScrollPos);
  maxRef.current = maxScrollPos;

  // ── Auto-follow ──
  useEffect(() => {
    if (following) setScrollPos(Math.max(0, total - visibleLineBudget));
  }, [total, following, visibleLineBudget]);

  // ── Scroll keys ──
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

  // ── Empty state ──
  if (!activities.length) {
    return (
      <Box flexDirection="column" padding={1}>
        <StatusBar
          iteration={currentIteration}
          startTime={startTime}
          isRunning={isRunning}
        />
        <Text color={colors.textMuted}>
          {isRunning
            ? "Waiting for log events..."
            : "No output yet — press 's' to start."}
        </Text>
      </Box>
    );
  }

  // ── Visible window ──
  const pos = Math.min(scrollPos, maxScrollPos);
  const visible = visualLines.slice(pos, pos + visibleLineBudget);
  const above = pos;
  const below = Math.max(0, total - pos - visibleLineBudget);

  // Render feed lines + scroll indicators as a single <Text> block
  // with \n separators. Multiple <Text> elements in an opentui column
  // Box overlap; a single text block with nested spans avoids this.
  return (
    <Box flexDirection="column">
      <StatusBar
        iteration={currentIteration}
        startTime={startTime}
        isRunning={isRunning}
      />

      {logEvents && logEvents.length > 0 && (
        <CognitiveMap logEvents={logEvents} />
      )}

      <Text>
        {above > 0 && (
          <Text color={colors.textMuted} dimColor>
            {`\u2191 ${above} earlier -- [`}
          </Text>
        )}
        {visible.map((line, i) => (
          <Text key={line.id} color={line.color} bold={line.bold}>
            {(i > 0 || above > 0 ? "\n" : "") + line.text}
          </Text>
        ))}
        {below > 0 && (
          <Text color={colors.textMuted}>
            {`\n\u2193 ${below} newer -- ] \u00B7 G follow`}
          </Text>
        )}
      </Text>
    </Box>
  );
}
