/**
 * Activity Aggregator - groups stream events into semantic activities
 */

import type { StreamEvent } from "../../infrastructure/ralph/index.ts";

export interface Activity {
  id: string;
  type:
    | "thinking"
    | "tool"
    | "tool_group"
    | "phase"
    | "milestone"
    | "error"
    | "iteration"
    | "log_event"
    | "team_event";
  status: "pending" | "running" | "success" | "error";
  content: string;

  // For tool activities
  toolName?: string;
  toolDetails?: string;

  // For tool groups
  tools?: Array<{ name: string; detail: string; status: "success" | "error" }>;

  // For phase changes
  phase?: string;

  // For log events
  logEventType?: string;
  logEventColor?: string;
  logEventIcon?: string;
  logEventDim?: boolean;

  // Agent teams
  agentName?: string;
  teamEvent?: string;

  // Timestamps
  startedAt: number;
  completedAt?: number;
}

/**
 * Icons for different tool types
 */
const TOOL_ICONS: Record<string, string> = {
  Read: "📂",
  Write: "📝",
  Edit: "✏️",
  Bash: "🔧",
  Glob: "🔍",
  Grep: "🔎",
  Task: "🤖",
  WebFetch: "🌐",
  WebSearch: "🔎",
  TeamCreate: "👥",
  SendMessage: "💬",
  TaskCreate: "📋",
  TaskUpdate: "📋",
  default: "►",
};

/**
 * Get icon for a tool
 */
export function getToolIcon(toolName: string): string {
  const icons: Record<string, string> = TOOL_ICONS;
  return icons[toolName] ?? "►";
}

// Phase is now read from kanban.json, not detected from text

/**
 * Detect if this is a state file update
 */
function detectMilestone(toolName: string, content: string): string | null {
  if (toolName === "Write" || toolName === "Edit") {
    if (content.includes("kanban.json")) {
      return "kanban";
    }
    // log.jsonl milestones suppressed — real events shown via log stream
    if (content.includes("prd.json")) {
      return "prd";
    }
  }
  return null;
}

/**
 * Shorten file path for display
 */
function shortenPath(path: string): string {
  const parts = path.split("/");
  if (parts.length <= 2) return path;
  return parts.slice(-2).join("/");
}

/**
 * Activity Aggregator class
 * Buffers stream events and emits grouped activities
 */
export class ActivityAggregator {
  private activities: Activity[] = [];
  private pendingTool: {
    name: string;
    detail: string;
    startedAt: number;
  } | null = null;
  private fileReadBuffer: Array<{ name: string; detail: string }> = [];
  private lastFileReadTime = 0;
  private activityCounter = 0;

  /**
   * Process a stream event and return any new activities
   */
  process(event: StreamEvent): Activity[] {
    const newActivities: Activity[] = [];

    switch (event.type) {
      case "iteration_marker":
        // Flush any pending activities
        newActivities.push(...this.flush());

        newActivities.push({
          id: this.nextId(),
          type: "iteration",
          status: "success",
          content: event.content,
          startedAt: Date.now(),
        });
        break;

      case "text":
        // Flush pending tools before text
        newActivities.push(...this.flush());

        // All text is thinking/narrative (phase comes from kanban)
        newActivities.push({
          id: this.nextId(),
          type: "thinking",
          status: "success",
          content: event.content,
          startedAt: Date.now(),
        });
        break;

      case "tool_call": {
        // Intercept team events before normal tool processing
        if (event.teamEvent) {
          newActivities.push(...this.flush());
          newActivities.push({
            id: this.nextId(),
            type: "team_event",
            status: "success",
            content: event.content,
            toolName: event.toolName,
            agentName: event.agentName,
            teamEvent: event.teamEvent,
            startedAt: Date.now(),
          });
          break;
        }

        const toolName = event.toolName || "Unknown";
        const toolDetail = event.content || "";

        // Check if this is a file read that can be grouped
        if (toolName === "Read") {
          const now = Date.now();
          // Group reads within 500ms of each other
          if (
            now - this.lastFileReadTime < 500 &&
            this.fileReadBuffer.length > 0
          ) {
            this.fileReadBuffer.push({
              name: toolName,
              detail: shortenPath(toolDetail),
            });
          } else {
            // Flush previous reads if any
            newActivities.push(...this.flushFileReads());
            this.fileReadBuffer.push({
              name: toolName,
              detail: shortenPath(toolDetail),
            });
          }
          this.lastFileReadTime = now;
          this.pendingTool = {
            name: toolName,
            detail: toolDetail,
            startedAt: now,
          };
        } else {
          // Flush any buffered reads
          newActivities.push(...this.flushFileReads());

          // Store pending tool for pairing with result
          this.pendingTool = {
            name: toolName,
            detail: toolDetail,
            startedAt: Date.now(),
          };
        }
        break;
      }

      case "tool_result":
        if (this.pendingTool) {
          const milestone = detectMilestone(
            this.pendingTool.name,
            this.pendingTool.detail,
          );
          const isError = event.isError || false;

          // If this completes a file read buffer, update the buffer
          if (
            this.pendingTool.name === "Read" &&
            this.fileReadBuffer.length > 0
          ) {
            if (isError) {
              // On error, flush immediately with error
              const activity = this.createFileReadActivity();
              if (activity) {
                activity.status = "error";
                newActivities.push(activity);
              }
              this.fileReadBuffer = [];
            }
            // Otherwise wait for more reads or a flush trigger
          } else if (milestone) {
            newActivities.push({
              id: this.nextId(),
              type: "milestone",
              status: isError ? "error" : "success",
              content: `Updated ${milestone}`,
              toolName: this.pendingTool.name,
              toolDetails: shortenPath(this.pendingTool.detail),
              startedAt: this.pendingTool.startedAt,
              completedAt: Date.now(),
            });
          } else {
            newActivities.push({
              id: this.nextId(),
              type: "tool",
              status: isError ? "error" : "success",
              content: this.pendingTool.detail,
              toolName: this.pendingTool.name,
              toolDetails: this.pendingTool.detail,
              startedAt: this.pendingTool.startedAt,
              completedAt: Date.now(),
            });
          }
          this.pendingTool = null;
        }
        break;

      case "error":
        newActivities.push(...this.flush());
        newActivities.push({
          id: this.nextId(),
          type: "error",
          status: "error",
          content: event.content,
          startedAt: Date.now(),
        });
        break;
    }

    // Store activities
    this.activities.push(...newActivities);

    return newActivities;
  }

  /**
   * Flush any pending activities
   */
  flush(): Activity[] {
    const activities: Activity[] = [];

    // Flush file reads
    activities.push(...this.flushFileReads());

    // Flush pending tool without result (shouldn't happen normally)
    if (this.pendingTool && this.pendingTool.name !== "Read") {
      activities.push({
        id: this.nextId(),
        type: "tool",
        status: "running",
        content: this.pendingTool.detail,
        toolName: this.pendingTool.name,
        toolDetails: this.pendingTool.detail,
        startedAt: this.pendingTool.startedAt,
      });
      this.pendingTool = null;
    }

    return activities;
  }

  /**
   * Flush buffered file reads as a group
   */
  private flushFileReads(): Activity[] {
    if (this.fileReadBuffer.length === 0) return [];

    const activity = this.createFileReadActivity();
    this.fileReadBuffer = [];
    this.pendingTool = null;

    return activity ? [activity] : [];
  }

  /**
   * Create a file read activity from the buffer
   */
  private createFileReadActivity(): Activity | null {
    if (this.fileReadBuffer.length === 0) return null;

    if (this.fileReadBuffer.length === 1) {
      const file = this.fileReadBuffer[0]!;
      return {
        id: this.nextId(),
        type: "tool",
        status: "success",
        content: file.detail,
        toolName: "Read",
        toolDetails: file.detail,
        startedAt: Date.now(),
        completedAt: Date.now(),
      };
    }

    // Multiple files - create a group
    return {
      id: this.nextId(),
      type: "tool_group",
      status: "success",
      content: `Read ${this.fileReadBuffer.length} files`,
      toolName: "Read",
      tools: this.fileReadBuffer.map((f) => ({
        name: "Read",
        detail: f.detail,
        status: "success" as const,
      })),
      startedAt: Date.now(),
      completedAt: Date.now(),
    };
  }

  /**
   * Get all activities
   */
  getActivities(): Activity[] {
    return this.activities;
  }

  /**
   * Clear all activities
   */
  clear(): void {
    this.activities = [];
    this.pendingTool = null;
    this.fileReadBuffer = [];
    this.activityCounter = 0;
  }

  /**
   * Generate next activity ID
   */
  private nextId(): string {
    return `activity-${++this.activityCounter}`;
  }
}
