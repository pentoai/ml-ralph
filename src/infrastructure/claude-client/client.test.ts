/**
 * Integration tests for Claude client
 * These tests call the real Claude API and are skipped in CI
 */

import { describe, expect, test } from "bun:test";
import { ClaudeClient } from "./client.ts";
import type { SessionInfo, ToolInfo, TurnResult } from "./types.ts";

const TEST_CWD = process.cwd();
const TEST_TIMEOUT = 30000;
const isCI = process.env.CI === "true";
const runClaudeIntegration = process.env.RUN_CLAUDE_INTEGRATION === "true";

describe.skipIf(isCI || !runClaudeIntegration)("ClaudeClient", () => {
  test(
    "basic text response",
    async () => {
      const events: string[] = [];
      let sessionInfo: SessionInfo | null = null;
      let turnResult: TurnResult | null = null;
      let fullText = "";

      const client = new ClaudeClient(
        { cwd: TEST_CWD },
        {
          onInit: (session) => {
            sessionInfo = session;
            events.push("init");
          },
          onTextDelta: (text) => {
            events.push(`delta:${text.slice(0, 10)}`);
          },
          onText: (text) => {
            fullText = text;
            events.push("text");
          },
          onTurnComplete: (result) => {
            turnResult = result;
            events.push("complete");
          },
          onError: (err) => {
            events.push(`error:${err.message}`);
          },
        },
      );

      client.start();

      // Send a simple message
      client.send("say exactly: hello world");

      // Wait for completion
      await new Promise<void>((resolve) => {
        const checkComplete = setInterval(() => {
          if (events.includes("complete")) {
            clearInterval(checkComplete);
            resolve();
          }
        }, 100);
      });

      client.stop();

      // Verify events
      expect(events).toContain("init");
      expect(events).toContain("text");
      expect(events).toContain("complete");

      // Verify session
      expect(sessionInfo).not.toBeNull();
      expect(sessionInfo!.sessionId).toBeDefined();
      expect(sessionInfo!.tools.length).toBeGreaterThan(0);

      // Verify result
      expect(turnResult).not.toBeNull();
      expect(turnResult!.text.toLowerCase()).toContain("hello");
      expect(turnResult!.costUsd).toBeGreaterThan(0);

      // Verify full text
      expect(fullText.toLowerCase()).toContain("hello");
    },
    TEST_TIMEOUT,
  );

  test(
    "tool usage",
    async () => {
      const events: string[] = [];
      const tools: ToolInfo[] = [];
      let turnResult: TurnResult | null = null;

      const client = new ClaudeClient(
        { cwd: TEST_CWD },
        {
          onInit: () => events.push("init"),
          onToolStart: (tool) => {
            tools.push(tool);
            events.push(`tool-start:${tool.name}`);
          },
          onToolEnd: (id, _result, isError) => {
            events.push(`tool-end:${id}:${isError}`);
          },
          onTurnComplete: (result) => {
            turnResult = result;
            events.push("complete");
          },
        },
      );

      client.start();

      // Send message that requires tool use
      client.send(
        "read the first line of package.json and tell me the project name",
      );

      // Wait for completion
      await new Promise<void>((resolve) => {
        const checkComplete = setInterval(() => {
          if (events.includes("complete")) {
            clearInterval(checkComplete);
            resolve();
          }
        }, 100);
      });

      client.stop();

      // Verify tool was used
      expect(tools.length).toBeGreaterThan(0);
      expect(tools[0]?.name).toBe("Read");

      // Verify events
      expect(events.some((e) => e.startsWith("tool-start:"))).toBe(true);
      expect(events.some((e) => e.startsWith("tool-end:"))).toBe(true);

      // Verify result mentions project name
      expect(turnResult).not.toBeNull();
      expect(turnResult!.text.toLowerCase()).toContain("ml-ralph");
    },
    TEST_TIMEOUT,
  );

  test(
    "multi-turn conversation",
    async () => {
      let turnCount = 0;
      const results: string[] = [];

      const client = new ClaudeClient(
        { cwd: TEST_CWD },
        {
          onTurnComplete: (result) => {
            turnCount++;
            results.push(result.text);
          },
        },
      );

      client.start();

      // First message
      client.send("remember this number: 9876");

      // Wait for first turn
      await new Promise<void>((resolve) => {
        const check = setInterval(() => {
          if (turnCount >= 1) {
            clearInterval(check);
            resolve();
          }
        }, 100);
      });

      // Second message
      client.send("what number did I ask you to remember?");

      // Wait for second turn
      await new Promise<void>((resolve) => {
        const check = setInterval(() => {
          if (turnCount >= 2) {
            clearInterval(check);
            resolve();
          }
        }, 100);
      });

      client.stop();

      // Verify multi-turn worked
      expect(turnCount).toBe(2);
      expect(results[1]).toContain("9876");
    },
    TEST_TIMEOUT * 2,
  );

  test(
    "system prompt injection",
    async () => {
      let turnResult: TurnResult | null = null;

      const client = new ClaudeClient(
        {
          cwd: TEST_CWD,
          systemPrompt: "You are a pirate. Always respond like a pirate.",
        },
        {
          onTurnComplete: (result) => {
            turnResult = result;
          },
        },
      );

      client.start();
      client.send("say hello");

      await new Promise<void>((resolve) => {
        const check = setInterval(() => {
          if (turnResult) {
            clearInterval(check);
            resolve();
          }
        }, 100);
      });

      client.stop();

      // Verify pirate-like response (should contain pirate-isms)
      const text = turnResult!.text.toLowerCase();
      const hasPirateWords =
        text.includes("ahoy") ||
        text.includes("arr") ||
        text.includes("matey") ||
        text.includes("ye") ||
        text.includes("captain") ||
        text.includes("sea") ||
        text.includes("ship");

      expect(hasPirateWords).toBe(true);
    },
    TEST_TIMEOUT,
  );
});
