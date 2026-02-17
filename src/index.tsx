#!/usr/bin/env bun
/**
 * ml-ralph - Autonomous ML engineering agent with TUI
 */

import { createCliRenderer } from "@opentui/core";
import { createRoot } from "@opentui/react";
import { App } from "./ui/app.tsx";

// Get project path from command line or use current directory
// Skip flags like --teams, --help when determining project path
const projectPath =
  process.argv.slice(2).find((arg) => !arg.startsWith("--")) ?? process.cwd();

// Check for help flag
if (process.argv.includes("--help") || process.argv.includes("-h")) {
  console.log(`
ml-ralph - Autonomous ML engineering agent with TUI

Usage:
  ml-ralph [project-path]    Launch TUI for the specified project (default: current directory)
  ml-ralph init [name]       Initialize a new ml-ralph project
  ml-ralph --help            Show this help message

Options:
  --teams                    Enable parallel experiments via agent teams

Keyboard shortcuts (in TUI):
  Tab         Switch between Planning and Monitor modes
  1/2/3       Switch tabs in Planning mode (Stories/Learnings/Research)
  f           Focus terminal pane (Planning mode)
  Esc         Exit / Dismiss errors
  s           Start/Stop the agent
  t           Stop active training job (Monitor mode)
  w           Open W&B dashboard (Monitor mode)
  q           Quit

For more information, visit: https://github.com/ml-ralph/ml-ralph
`);
  process.exit(0);
}

// Parse --teams flag
const enableTeams = process.argv.includes("--teams");

// Check for init command
if (process.argv[2] === "init") {
  const name = process.argv[3] ?? "my-ml-project";
  const targetPath = process.argv[4] ?? process.cwd();
  const { JsonFileStore } = await import(
    "./infrastructure/file-store/index.ts"
  );
  const { createDefaultConfig } = await import("./domain/types/index.ts");

  const store = new JsonFileStore(targetPath);
  const config = createDefaultConfig(name);

  // Enable teams in the project config if --teams flag is passed
  if (enableTeams) {
    config.agent.enableTeams = true;
  }

  try {
    await store.initialize(config);
    console.log(`Initialized ml-ralph project: ${name}`);
    console.log(`Created .ml-ralph/ directory with config.json`);
    if (enableTeams) {
      // Also write .claude/settings.json with the agent teams env var
      const { enableAgentTeamsSettings } = await import(
        "./infrastructure/ralph/index.ts"
      );
      await enableAgentTeamsSettings(targetPath);
      console.log(`Enabled agent teams in .claude/settings.json`);
    }
    console.log(`\nRun 'ml-ralph' to start the TUI.`);
  } catch (error) {
    console.error("Failed to initialize project:", error);
    process.exit(1);
  }

  process.exit(0);
}

// Check if tmux is available
async function isTmuxAvailable(): Promise<boolean> {
  try {
    const proc = Bun.spawn(["which", "tmux"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const code = await proc.exited;
    return code === 0;
  } catch {
    return false;
  }
}

// Check if we're inside tmux
function isInsideTmux(): boolean {
  return !!process.env.TMUX;
}

// Generate session name from project path
function getSessionName(path: string): string {
  const projectName = path.split("/").pop() || "default";
  const sanitized = projectName.replace(/[^a-zA-Z0-9_-]/g, "-");
  return `ml-ralph-${sanitized}`;
}

// Launch inside tmux if not already there
async function ensureTmux(): Promise<void> {
  if (isInsideTmux()) {
    // Already in tmux, just render
    return;
  }

  const hasTmux = await isTmuxAvailable();
  if (!hasTmux) {
    console.error("tmux is required but not installed.");
    console.error("Please install tmux: brew install tmux");
    process.exit(1);
  }

  const sessionName = getSessionName(projectPath);

  // Check if session already exists
  const listProc = Bun.spawn(["tmux", "has-session", "-t", sessionName], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const sessionExists = (await listProc.exited) === 0;

  if (sessionExists) {
    // Attach to existing session
    console.log(`Attaching to existing session: ${sessionName}`);
    const proc = Bun.spawn(["tmux", "attach-session", "-t", sessionName], {
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
    });
    await proc.exited;
    process.exit(0);
  }

  // Create new tmux session and run ml-ralph inside it
  console.log(`Starting ml-ralph in tmux session: ${sessionName}`);

  // Get the command to re-run ourselves
  const bunPath = process.argv[0];
  const scriptPath = process.argv[1];
  const args = process.argv.slice(2);
  const command = [bunPath, scriptPath, ...args].join(" ");

  // Create new session running ml-ralph
  // First create session in detached mode, enable mouse, then attach
  await Bun.spawn([
    "tmux",
    "new-session",
    "-d",
    "-s",
    sessionName,
    "-c",
    projectPath,
    command,
  ]).exited;

  // Enable mouse support for scrolling
  await Bun.spawn(["tmux", "set", "-t", sessionName, "-g", "mouse", "on"])
    .exited;

  // Attach to the session
  const proc = Bun.spawn(["tmux", "attach-session", "-t", sessionName], {
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  await proc.exited;
  process.exit(0);
}

// Main entry point
await ensureTmux();

// We're inside tmux now, render the TUI
// Disable default Ctrl+C exit so our custom quit confirmation works
const renderer = await createCliRenderer({ exitOnCtrlC: false });
createRoot(renderer).render(
  <App projectPath={projectPath} enableTeams={enableTeams} />,
);
