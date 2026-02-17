/**
 * Tests for TmuxLayoutManager
 */

import { afterEach, describe, expect, test } from "bun:test";
import { TmuxLayoutManager } from "./layout-manager.ts";

const TEST_TIMEOUT = 10000;

describe("TmuxLayoutManager", () => {
  let manager: TmuxLayoutManager | null = null;

  afterEach(async () => {
    // Clean up
    if (manager) {
      await manager.enterMonitorMode();
      manager = null;
    }
  });

  test("isInsideTmux returns boolean", () => {
    const result = TmuxLayoutManager.isInsideTmux();
    expect(typeof result).toBe("boolean");
  });

  test("getCurrentSession returns string or null", () => {
    const result = TmuxLayoutManager.getCurrentSession();
    expect(result === null || typeof result === "string").toBe(true);
  });

  test(
    "initialize works when inside tmux",
    async () => {
      // Skip if not in tmux
      if (!TmuxLayoutManager.isInsideTmux()) {
        console.log("Skipping test - not inside tmux");
        return;
      }

      manager = new TmuxLayoutManager({
        sessionName: "ml-ralph-test",
        cwd: process.cwd(),
      });

      const success = await manager.initialize();
      expect(success).toBe(true);
      expect(manager.getIsInTmux()).toBe(true);
    },
    TEST_TIMEOUT,
  );

  test(
    "enterPlanningMode creates split pane",
    async () => {
      // Skip if not in tmux
      if (!TmuxLayoutManager.isInsideTmux()) {
        console.log("Skipping test - not inside tmux");
        return;
      }

      manager = new TmuxLayoutManager({
        sessionName: "ml-ralph-test",
        cwd: process.cwd(),
      });

      await manager.initialize();
      const success = await manager.enterPlanningMode();
      expect(success).toBe(true);
      expect(manager.hasTerminalPane()).toBe(true);
    },
    TEST_TIMEOUT,
  );

  test(
    "enterMonitorMode closes split pane",
    async () => {
      // Skip if not in tmux
      if (!TmuxLayoutManager.isInsideTmux()) {
        console.log("Skipping test - not inside tmux");
        return;
      }

      manager = new TmuxLayoutManager({
        sessionName: "ml-ralph-test",
        cwd: process.cwd(),
      });

      await manager.initialize();
      await manager.enterPlanningMode();
      expect(manager.hasTerminalPane()).toBe(true);

      const success = await manager.enterMonitorMode();
      expect(success).toBe(true);
      expect(manager.hasTerminalPane()).toBe(false);
    },
    TEST_TIMEOUT,
  );
});
