/**
 * Chat types - PRD creation conversation history
 */

import type { ChatPurpose, ChatRole } from "./enums.ts";

export interface ToolCall {
  id: string;
  tool: string; // Tool name
  input: unknown; // Tool input
  output?: unknown; // Tool output (if completed)
  status: "running" | "completed" | "error";
}

export interface ChatMessage {
  id: string; // UUID
  timestamp: string; // ISO timestamp
  role: ChatRole;
  content: string;

  // If assistant used tools
  toolCalls?: ToolCall[];
}

export interface ChatSession {
  id: string; // UUID
  purpose: ChatPurpose;
  createdAt: string; // ISO timestamp
  updatedAt: string; // ISO timestamp
  messages: ChatMessage[];
}

/**
 * Create a new chat message
 */
export function createChatMessage(
  role: ChatRole,
  content: string,
  toolCalls?: ToolCall[],
): ChatMessage {
  return {
    id: crypto.randomUUID(),
    timestamp: new Date().toISOString(),
    role,
    content,
    toolCalls,
  };
}

/**
 * Create a new chat session
 */
export function createChatSession(purpose: ChatPurpose): ChatSession {
  const now = new Date().toISOString();
  return {
    id: crypto.randomUUID(),
    purpose,
    createdAt: now,
    updatedAt: now,
    messages: [],
  };
}
