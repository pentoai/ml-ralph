/**
 * Types for Claude CLI stream-json protocol
 */

// ============================================================================
// Input Types
// ============================================================================

export interface InputMessage {
  type: "user";
  message: {
    role: "user";
    content: string;
  };
}

// ============================================================================
// Output Types
// ============================================================================

export type OutputMessage =
  | SystemInitMessage
  | StreamEventMessage
  | AssistantMessage
  | UserMessage
  | ResultMessage;

// System init message (first message on session start)
export interface SystemInitMessage {
  type: "system";
  subtype: "init";
  session_id: string;
  cwd: string;
  tools: string[];
  model: string;
  permissionMode: string;
  mcp_servers: string[];
  agents: string[];
  skills: string[];
  claude_code_version: string;
  uuid: string;
}

// Stream event wrapper
export interface StreamEventMessage {
  type: "stream_event";
  event: StreamEvent;
  session_id: string;
  parent_tool_use_id: string | null;
  uuid: string;
}

// Stream event types
export type StreamEvent =
  | MessageStartEvent
  | ContentBlockStartEvent
  | ContentBlockDeltaEvent
  | ContentBlockStopEvent
  | MessageDeltaEvent
  | MessageStopEvent;

export interface MessageStartEvent {
  type: "message_start";
  message: {
    model: string;
    id: string;
    role: "assistant";
    content: ContentBlock[];
    stop_reason: string | null;
    usage: Usage;
  };
}

export interface ContentBlockStartEvent {
  type: "content_block_start";
  index: number;
  content_block: ContentBlock;
}

export interface ContentBlockDeltaEvent {
  type: "content_block_delta";
  index: number;
  delta: Delta;
}

export interface ContentBlockStopEvent {
  type: "content_block_stop";
  index: number;
}

export interface MessageDeltaEvent {
  type: "message_delta";
  delta: {
    stop_reason: "end_turn" | "tool_use" | null;
    stop_sequence: string | null;
  };
  usage: Usage;
}

export interface MessageStopEvent {
  type: "message_stop";
}

// Content blocks
export type ContentBlock = TextContentBlock | ToolUseContentBlock;

export interface TextContentBlock {
  type: "text";
  text: string;
}

export interface ToolUseContentBlock {
  type: "tool_use";
  id: string;
  name: string;
  input: Record<string, unknown>;
}

// Deltas
export type Delta = TextDelta | InputJsonDelta;

export interface TextDelta {
  type: "text_delta";
  text: string;
}

export interface InputJsonDelta {
  type: "input_json_delta";
  partial_json: string;
}

// Usage tracking
export interface Usage {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}

// Assistant message (full message during streaming)
export interface AssistantMessage {
  type: "assistant";
  message: {
    model: string;
    id: string;
    role: "assistant";
    content: ContentBlock[];
    stop_reason: string | null;
    usage: Usage;
  };
  session_id: string;
  parent_tool_use_id: string | null;
  uuid: string;
}

// User message (tool results)
export interface UserMessage {
  type: "user";
  message: {
    role: "user";
    content: ToolResultContent[];
  };
  session_id: string;
  parent_tool_use_id: string | null;
  uuid: string;
  tool_use_result?: {
    stdout: string;
    stderr: string;
    interrupted: boolean;
    isImage: boolean;
  };
}

export interface ToolResultContent {
  tool_use_id: string;
  type: "tool_result";
  content: string;
  is_error: boolean;
}

// Result message (final)
export interface ResultMessage {
  type: "result";
  subtype: "success" | "error";
  is_error: boolean;
  duration_ms: number;
  duration_api_ms: number;
  num_turns: number;
  result: string;
  session_id: string;
  total_cost_usd: number;
  usage: Usage;
  modelUsage: Record<string, ModelUsage>;
  uuid: string;
  error?: string;
}

export interface ModelUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens?: number;
  cacheCreationInputTokens?: number;
  costUSD: number;
}

// ============================================================================
// Client Types
// ============================================================================

export interface ClaudeClientOptions {
  cwd: string;
  systemPrompt?: string;
  model?: "sonnet" | "opus" | "haiku";
  dangerouslySkipPermissions?: boolean;
}

export interface ClaudeClientEvents {
  onInit?: (session: SessionInfo) => void;
  onTextDelta?: (text: string) => void;
  onText?: (fullText: string) => void;
  onToolStart?: (tool: ToolInfo) => void;
  onToolEnd?: (toolId: string, result: string, isError: boolean) => void;
  onTurnComplete?: (result: TurnResult) => void;
  onError?: (error: Error) => void;
}

export interface SessionInfo {
  sessionId: string;
  model: string;
  tools: string[];
  cwd: string;
}

export interface ToolInfo {
  id: string;
  name: string;
}

export interface TurnResult {
  text: string;
  costUsd: number;
  durationMs: number;
  numTurns: number;
}
