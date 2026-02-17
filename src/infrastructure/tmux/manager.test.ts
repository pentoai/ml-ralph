/**
 * Tests for TmuxManager
 */

import { afterEach, describe, expect, test } from "bun:test";
import { TmuxManager } from "./manager.ts";
import type { TmuxPaneContent } from "./types.ts";

const TEST_SESSION_PREFIX = "ml-ralph-test";
const TEST_TIMEOUT = 10000;

function getTestSessionName(): string {
  return `${TEST_SESSION_PREFIX}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}

describe("TmuxManager", () => {
  let manager: TmuxManager | null = null;

  afterEach(async () => {
    // Clean up any test sessions
    if (manager) {
      await manager.kill();
      manager = null;
    }
  });

  test("isAvailable returns true when tmux is installed", async () => {
    const available = await TmuxManager.isAvailable();
    expect(available).toBe(true);
  });

  test(
    "creates a new session",
    async () => {
      const sessionName = getTestSessionName();
      manager = new TmuxManager({
        name: sessionName,
        cwd: process.cwd(),
        width: 80,
        height: 24,
      });

      const started = await manager.start();
      expect(started).toBe(true);

      const exists = await manager.sessionExists();
      expect(exists).toBe(true);
    },
    TEST_TIMEOUT,
  );

  test(
    "reuses existing session",
    async () => {
      const sessionName = getTestSessionName();

      // Create first manager
      manager = new TmuxManager({
        name: sessionName,
        cwd: process.cwd(),
      });
      await manager.start();

      // Send a command to mark this session
      await manager.sendKeys("export TEST_MARKER=first");
      await manager.sendKeys("Enter");
      await Bun.sleep(200);

      // Stop (but don't kill)
      manager.stop();

      // Create second manager with same name
      const manager2 = new TmuxManager({
        name: sessionName,
        cwd: process.cwd(),
      });
      const started = await manager2.start();
      expect(started).toBe(true);

      // The session should still exist with our marker
      await manager2.sendKeys("echo $TEST_MARKER");
      await manager2.sendKeys("Enter");
      await Bun.sleep(300);

      const content = await manager2.capturePane(false);
      expect(content).not.toBeNull();
      expect(content!.text).toContain("first");

      // Clean up
      await manager2.kill();
      manager = null; // Prevent double cleanup
    },
    TEST_TIMEOUT,
  );

  test(
    "captures pane content",
    async () => {
      const sessionName = getTestSessionName();
      manager = new TmuxManager({
        name: sessionName,
        cwd: process.cwd(),
        width: 80,
        height: 24,
      });
      await manager.start();

      // Send a command
      await manager.sendKeys("echo 'CAPTURE_TEST_12345'");
      await manager.sendKeys("Enter");
      await Bun.sleep(500);

      const content = await manager.capturePane(false);
      expect(content).not.toBeNull();
      expect(content!.text).toContain("CAPTURE_TEST_12345");
      expect(content!.lines.length).toBeGreaterThan(0);
      expect(content!.width).toBeGreaterThan(0);
      expect(content!.height).toBeGreaterThan(0);
    },
    TEST_TIMEOUT,
  );

  test(
    "captures pane content with ANSI colors",
    async () => {
      const sessionName = getTestSessionName();
      manager = new TmuxManager({
        name: sessionName,
        cwd: process.cwd(),
      });
      await manager.start();

      // Send a command that produces colored output
      await manager.sendKeys("ls --color=always");
      await manager.sendKeys("Enter");
      await Bun.sleep(500);

      const content = await manager.capturePane(true);
      expect(content).not.toBeNull();
      // ANSI escape codes start with \x1b[ or show as [
      // The -e flag should preserve some escape sequences
      expect(content!.text.length).toBeGreaterThan(0);
    },
    TEST_TIMEOUT,
  );

  test(
    "sends keys correctly",
    async () => {
      const sessionName = getTestSessionName();
      manager = new TmuxManager({
        name: sessionName,
        cwd: process.cwd(),
      });
      await manager.start();

      // Send multiple keys
      const success = await manager.sendKeys("echo hello");
      expect(success).toBe(true);

      await manager.sendKeys("Enter");
      await Bun.sleep(300);

      const content = await manager.capturePane(false);
      expect(content!.text).toContain("hello");
    },
    TEST_TIMEOUT,
  );

  test(
    "sends literal text with special characters",
    async () => {
      const sessionName = getTestSessionName();
      manager = new TmuxManager({
        name: sessionName,
        cwd: process.cwd(),
      });
      await manager.start();

      // Send text with special characters that would normally be interpreted
      const success = await manager.sendText("echo 'test with spaces'");
      expect(success).toBe(true);

      await manager.sendKeys("Enter");
      await Bun.sleep(300);

      const content = await manager.capturePane(false);
      expect(content!.text).toContain("test with spaces");
    },
    TEST_TIMEOUT,
  );

  test(
    "runs initial command",
    async () => {
      const sessionName = getTestSessionName();
      manager = new TmuxManager({
        name: sessionName,
        cwd: process.cwd(),
        initialCommand: "echo 'INITIAL_COMMAND_RAN'",
      });
      await manager.start();
      // Wait longer for shell to initialize and command to execute
      await Bun.sleep(1000);

      const content = await manager.capturePane(false);
      expect(content!.text).toContain("INITIAL_COMMAND_RAN");
    },
    TEST_TIMEOUT,
  );

  test(
    "polls for content updates",
    async () => {
      const sessionName = getTestSessionName();
      const updates: TmuxPaneContent[] = [];

      manager = new TmuxManager(
        {
          name: sessionName,
          cwd: process.cwd(),
        },
        {
          onContentUpdate: (content) => updates.push(content),
        },
      );
      await manager.start();

      // Start polling
      manager.startPolling(50);

      // Wait for some updates
      await Bun.sleep(200);

      // Should have received multiple updates
      expect(updates.length).toBeGreaterThan(2);

      // Stop polling
      manager.stopPolling();
      const countAfterStop = updates.length;

      await Bun.sleep(200);
      // Should not receive more updates after stopping
      expect(updates.length).toBe(countAfterStop);
    },
    TEST_TIMEOUT,
  );

  test(
    "kills session",
    async () => {
      const sessionName = getTestSessionName();
      manager = new TmuxManager({
        name: sessionName,
        cwd: process.cwd(),
      });
      await manager.start();

      const existsBefore = await manager.sessionExists();
      expect(existsBefore).toBe(true);

      const killed = await manager.kill();
      expect(killed).toBe(true);

      const existsAfter = await manager.sessionExists();
      expect(existsAfter).toBe(false);

      manager = null; // Prevent double cleanup
    },
    TEST_TIMEOUT,
  );

  test(
    "lists sessions",
    async () => {
      const sessionName = getTestSessionName();
      manager = new TmuxManager({
        name: sessionName,
        cwd: process.cwd(),
      });
      await manager.start();

      const sessions = await TmuxManager.listSessions();
      const ourSession = sessions.find((s) => s.name === sessionName);

      expect(ourSession).toBeDefined();
      expect(ourSession!.windows).toBe(1);
      expect(ourSession!.attached).toBe(false);
    },
    TEST_TIMEOUT,
  );
});
