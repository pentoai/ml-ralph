/**
 * Tests for TmuxLayoutManager
 */

import { afterEach, describe, expect, test } from "bun:test";
import { TmuxLayoutManager } from "./layout-manager.ts";

const TEST_TIMEOUT = 10000;
const insideTmux = TmuxLayoutManager.isInsideTmux();

describe("TmuxLayoutManager", () => {
  let manager: TmuxLayoutManager | null = null;

  afterEach(async () => {
    // Clean up
    if (manager) {
      const paneId = manager.getTerminalPaneId();
      if (paneId) {
        Bun.spawnSync(["tmux", "kill-pane", "-t", paneId]);
      }
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

  test.if(insideTmux)(
    "initialize works when inside tmux",
    async () => {
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

  test.if(insideTmux)(
    "enterPlanningMode creates split pane",
    async () => {
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

  test.if(insideTmux)(
    "enterMonitorMode minimizes split pane but keeps it",
    async () => {
      manager = new TmuxLayoutManager({
        sessionName: "ml-ralph-test",
        cwd: process.cwd(),
      });

      await manager.initialize();
      await manager.enterPlanningMode();
      expect(manager.hasTerminalPane()).toBe(true);

      const success = await manager.enterMonitorMode();
      expect(success).toBe(true);
      // The pane is shrunk to one column, not closed, so the session survives
      expect(manager.hasTerminalPane()).toBe(true);
      const paneId = manager.getTerminalPaneId() as string;
      const width = Bun.spawnSync([
        "tmux",
        "display-message",
        "-p",
        "-t",
        paneId,
        "#{pane_width}",
      ])
        .stdout.toString()
        .trim();
      expect(width).toBe("1");
    },
    TEST_TIMEOUT,
  );
});
