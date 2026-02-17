/**
 * Hook for managing Claude chat state and interactions
 */

import { useCallback, useEffect, useRef, useState } from "react";
import {
  ClaudeClient,
  type SessionInfo,
  type ToolInfo,
  type TurnResult,
} from "../../infrastructure/claude-client/index.ts";

// ============================================================================
// Types
// ============================================================================

export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  timestamp: Date;
  isStreaming?: boolean;
  tools?: ToolCall[];
}

export interface ToolCall {
  id: string;
  name: string;
  status: "running" | "completed" | "error";
  result?: string;
}

export interface UseChatOptions {
  cwd: string;
  systemPrompt?: string;
  autoStart?: boolean;
}

export interface UseChatResult {
  // State
  messages: ChatMessage[];
  isConnected: boolean;
  isStreaming: boolean;
  sessionInfo: SessionInfo | null;
  error: string | null;
  totalCost: number;

  // Actions
  sendMessage: (content: string) => void;
  start: () => void;
  stop: () => void;
  clearMessages: () => void;
}

// ============================================================================
// Hook Implementation
// ============================================================================

export function useClaudeChat(options: UseChatOptions): UseChatResult {
  const { cwd, systemPrompt, autoStart = true } = options;

  // State
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [isConnected, setIsConnected] = useState(autoStart);
  const [isStreaming, setIsStreaming] = useState(false);
  const [sessionInfo, setSessionInfo] = useState<SessionInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [totalCost, setTotalCost] = useState(0);

  // Refs
  const clientRef = useRef<ClaudeClient | null>(null);
  const currentMessageIdRef = useRef<string | null>(null);
  const streamingTextRef = useRef<string>("");
  const activeToolsRef = useRef<Map<string, ToolCall>>(new Map());

  // Generate unique message ID
  const generateId = useCallback(() => {
    return `msg-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
  }, []);

  // Update current streaming message
  const updateStreamingMessage = useCallback(() => {
    const msgId = currentMessageIdRef.current;
    if (!msgId) return;

    setMessages((prev) =>
      prev.map((msg) =>
        msg.id === msgId
          ? {
              ...msg,
              content: streamingTextRef.current,
              tools: Array.from(activeToolsRef.current.values()),
            }
          : msg,
      ),
    );
  }, []);

  // Start the client
  const start = useCallback(() => {
    if (clientRef.current) return;

    setError(null);

    const client = new ClaudeClient(
      {
        cwd,
        systemPrompt,
        dangerouslySkipPermissions: true,
      },
      {
        onInit: (session) => {
          setSessionInfo(session);
          setIsConnected(true);
        },

        onTextDelta: (text) => {
          streamingTextRef.current += text;
          updateStreamingMessage();
        },

        onText: (_fullText) => {
          // Full text received, mark as not streaming
          setMessages((prev) =>
            prev.map((msg) =>
              msg.id === currentMessageIdRef.current
                ? { ...msg, isStreaming: false }
                : msg,
            ),
          );
        },

        onToolStart: (tool: ToolInfo) => {
          activeToolsRef.current.set(tool.id, {
            id: tool.id,
            name: tool.name,
            status: "running",
          });
          updateStreamingMessage();
        },

        onToolEnd: (toolId: string, result: string, isError: boolean) => {
          const tool = activeToolsRef.current.get(toolId);
          if (tool) {
            activeToolsRef.current.set(toolId, {
              ...tool,
              status: isError ? "error" : "completed",
              result,
            });
            updateStreamingMessage();
          }
        },

        onTurnComplete: (result: TurnResult) => {
          setIsStreaming(false);
          setTotalCost((prev) => prev + result.costUsd);

          // Finalize message
          setMessages((prev) =>
            prev.map((msg) =>
              msg.id === currentMessageIdRef.current
                ? {
                    ...msg,
                    content: result.text,
                    isStreaming: false,
                    tools: Array.from(activeToolsRef.current.values()),
                  }
                : msg,
            ),
          );

          // Reset refs
          currentMessageIdRef.current = null;
          streamingTextRef.current = "";
          activeToolsRef.current.clear();
        },

        onError: (err) => {
          setError(err.message);
          setIsStreaming(false);
        },
      },
    );

    client.start();
    clientRef.current = client;
    setIsConnected(true);
  }, [cwd, systemPrompt, updateStreamingMessage]);

  // Stop the client
  const stop = useCallback(() => {
    if (clientRef.current) {
      clientRef.current.stop();
      clientRef.current = null;
      setIsConnected(false);
      setIsStreaming(false);
    }
  }, []);

  // Send a message
  const sendMessage = useCallback(
    (content: string) => {
      if (!clientRef.current?.isRunning()) {
        setError("Client not connected");
        return;
      }

      // Add user message
      const userMsgId = generateId();
      setMessages((prev) => [
        ...prev,
        {
          id: userMsgId,
          role: "user",
          content,
          timestamp: new Date(),
        },
      ]);

      // Prepare assistant message placeholder
      const assistantMsgId = generateId();
      currentMessageIdRef.current = assistantMsgId;
      streamingTextRef.current = "";
      activeToolsRef.current.clear();

      setMessages((prev) => [
        ...prev,
        {
          id: assistantMsgId,
          role: "assistant",
          content: "",
          timestamp: new Date(),
          isStreaming: true,
          tools: [],
        },
      ]);

      setIsStreaming(true);
      setError(null);

      // Send to Claude
      clientRef.current.send(content);
    },
    [generateId],
  );

  // Clear messages
  const clearMessages = useCallback(() => {
    setMessages([]);
    setTotalCost(0);
  }, []);

  // Auto-start on mount if enabled
  useEffect(() => {
    if (autoStart) {
      start();
    }

    return () => {
      stop();
    };
  }, [autoStart, start, stop]);

  return {
    messages,
    isConnected,
    isStreaming,
    sessionInfo,
    error,
    totalCost,
    sendMessage,
    start,
    stop,
    clearMessages,
  };
}
