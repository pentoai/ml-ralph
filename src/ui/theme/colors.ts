/**
 * Color theme for ml-ralph TUI
 */

export const colors = {
  // Background
  bgPrimary: "#1a1a2e",
  bgSecondary: "#16213e",
  bgTertiary: "#0f3460",

  // Text
  text: "#eaeaea",
  textPrimary: "#eaeaea",
  textSecondary: "#a0a0a0",
  textMuted: "#666666",

  // Borders
  border: "#444444",

  // Accents
  accentBlue: "#60A5FA",
  accentGreen: "#4ADE80",
  accentRed: "#F87171",
  accentYellow: "#FBBF24",
  accentPurple: "#A78BFA",
  accentCyan: "#22D3EE",

  // Status
  statusRunning: "#60A5FA",
  statusSuccess: "#4ADE80",
  statusError: "#F87171",
  statusPending: "#a0a0a0",

  // Impact levels
  impactHigh: "#F87171",
  impactMedium: "#FBBF24",
  impactLow: "#4ADE80",
} as const;

export type ColorName = keyof typeof colors;

/**
 * Get color for story status
 */
export function getStoryStatusColor(
  status: "pending" | "in_progress" | "done" | "superseded",
): string {
  switch (status) {
    case "pending":
      return colors.statusPending;
    case "in_progress":
      return colors.statusRunning;
    case "done":
      return colors.statusSuccess;
    case "superseded":
      return colors.textMuted;
  }
}

/**
 * Get color for impact level
 */
export function getImpactColor(impact: "high" | "medium" | "low"): string {
  switch (impact) {
    case "high":
      return colors.impactHigh;
    case "medium":
      return colors.impactMedium;
    case "low":
      return colors.impactLow;
  }
}

/**
 * Get symbol for story status
 */
export function getStoryStatusSymbol(
  status: "pending" | "in_progress" | "done" | "superseded",
): string {
  switch (status) {
    case "pending":
      return "○";
    case "in_progress":
      return "→";
    case "done":
      return "✓";
    case "superseded":
      return "⊘";
  }
}
