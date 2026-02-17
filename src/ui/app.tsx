/**
 * Main App component
 */

import { useCallback, useEffect, useRef, useState } from "react";
import type { AgentOrchestrator } from "../application/orchestrator/index.ts";
import { createOrchestrator } from "../application/orchestrator/index.ts";
import { useAppStore } from "../application/state/index.ts";
import { ensureInitialized } from "../infrastructure/ralph/index.ts";
import { useTmuxLayout } from "./hooks/index.ts";
import {
  Box,
  Text,
  useApp,
  useFocusManager,
  useInput,
  useStdout,
} from "./ink.tsx";
import { MonitorScreen } from "./screens/monitor.tsx";
import { OutputScreen } from "./screens/output.tsx";
import { PlanningScreen } from "./screens/planning.tsx";
import { colors } from "./theme/colors.ts";
// import { Logo } from "./widgets/logo.tsx";
import { ModeTabs } from "./widgets/tabs.tsx";

interface AppProps {
  projectPath: string;
  enableTeams?: boolean;
}

export function App({ projectPath, enableTeams }: AppProps) {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const { disableFocus } = useFocusManager();
  const orchestratorRef = useRef<AgentOrchestrator | null>(null);

  // Disable built-in Tab focus cycling — we handle Tab manually
  useEffect(() => {
    disableFocus();
  }, [disableFocus]);

  // Track terminal dimensions
  const [terminalHeight, setTerminalHeight] = useState(stdout?.rows ?? 24);
  // Quit confirmation state
  const [showQuitConfirm, setShowQuitConfirm] = useState(false);
  // Start confirmation state
  const [showStartConfirm, setShowStartConfirm] = useState(false);
  // Max iterations for agent run
  const [maxIterations, setMaxIterations] = useState(10);
  // Stop confirmation state
  const [showStopConfirm, setShowStopConfirm] = useState(false);
  // No PRD dialog state
  const [showNoPrdDialog, setShowNoPrdDialog] = useState(false);
  // Hint dialog state
  const [showHintDialog, setShowHintDialog] = useState(false);
  const [hintText, setHintText] = useState("");
  const [pendingHints, setPendingHints] = useState<string[]>([]);
  // Initialization state
  const [isInitialized, setIsInitialized] = useState(false);
  // Current iteration
  const [currentIteration, setCurrentIteration] = useState(0);
  // Agent start time for elapsed timer
  const [agentStartTime, setAgentStartTime] = useState(0);

  useEffect(() => {
    const handleResize = () => {
      if (stdout?.rows) {
        setTerminalHeight(stdout.rows);
      }
    };

    stdout?.on("resize", handleResize);
    return () => {
      stdout?.off("resize", handleResize);
    };
  }, [stdout]);

  const {
    mode,
    setMode,
    selectedTab,
    setSelectedTab,
    setProjectPath,
    loadProject,
    error,
    setError,
    agentStatus,
    setAgentStatus,
    config,
    activeJobs,
    stopTrainingJob,
    inputMode,
    setInputMode,
    scrollUp,
    scrollDown,
    backlogExpanded,
    setBacklogExpanded,
    scrollBacklogUp,
    scrollBacklogDown,
    completedExpanded,
    setCompletedExpanded,
    scrollCompletedUp,
    scrollCompletedDown,
    abandonedExpanded,
    setAbandonedExpanded,
    scrollAbandonedUp,
    scrollAbandonedDown,
    selectedExperimentId,
    experimentFlatList,
    selectNextExperiment,
    selectPrevExperiment,
    toggleExpandedExperiment,
    setExpandedExperimentId,
    appendAgentOutput,
    clearAgentOutput,
  } = useAppStore();

  // Tmux layout manager
  const tmuxLayout = useTmuxLayout({
    cwd: projectPath,
    sessionName: `ml-ralph-${projectPath.split("/").pop() || "default"}`,
  });

  // Initialize ml-ralph on mount
  useEffect(() => {
    const init = async () => {
      const success = await ensureInitialized(projectPath);
      setIsInitialized(success);
      if (!success) {
        setError("Failed to initialize ml-ralph. Check permissions.");
      }
    };
    init();
  }, [projectPath, setError]);

  // Teams enabled by default; CLI flag or config can override
  const teamsEnabled = enableTeams ?? config?.agent.enableTeams ?? true;

  // Initialize project on mount
  useEffect(() => {
    setProjectPath(projectPath);
    loadProject();
  }, [projectPath, setProjectPath, loadProject]);

  // Handle iteration change
  const handleIterationChange = useCallback((iteration: number) => {
    setCurrentIteration(iteration);
    // Hints are consumed at iteration start, so clear the list
    setPendingHints([]);
  }, []);

  // Handle completion
  const handleComplete = useCallback(
    (_reason: "project_complete" | "max_iterations") => {
      setAgentStatus("idle");
      setPendingHints([]);
    },
    [setAgentStatus],
  );

  // Create orchestrator when config is loaded
  useEffect(() => {
    if (config && !orchestratorRef.current) {
      orchestratorRef.current = createOrchestrator({
        projectPath,
        autoAdvance: config.agent.autoAdvance,
        enableTeams: teamsEnabled,
      });
      // Subscribe to events
      orchestratorRef.current.onIterationChange(handleIterationChange);
      orchestratorRef.current.onComplete(handleComplete);
      orchestratorRef.current.onOutput((event) => {
        appendAgentOutput(event);
      });
    }
  }, [config, projectPath, handleIterationChange, handleComplete]);

  // Handle mode changes - create/destroy tmux split
  useEffect(() => {
    if (!tmuxLayout.isInitialized) return;

    const switchLayout = async () => {
      try {
        if (mode === "planning") {
          await tmuxLayout.enterPlanningMode();
        } else {
          // Both monitor and output modes use the monitor layout
          await tmuxLayout.enterMonitorMode();
        }
      } catch {
        // Ignore tmux layout errors — TUI continues without split
      }
    };
    switchLayout();
  }, [
    mode,
    tmuxLayout.isInitialized,
    tmuxLayout.enterPlanningMode,
    tmuxLayout.enterMonitorMode,
  ]);

  // Perform actual quit - kill tmux session too
  const doQuit = async () => {
    if (orchestratorRef.current?.isRunning()) {
      orchestratorRef.current.stop();
    }
    // Kill the entire tmux session
    const sessionName = `ml-ralph-${projectPath.split("/").pop() || "default"}`;
    try {
      const proc = Bun.spawn(["tmux", "kill-session", "-t", sessionName], {
        stdout: "pipe",
        stderr: "pipe",
      });
      await proc.exited;
    } catch {
      // Ignore errors, just exit
    }
    exit();
  };

  // Start the agent
  const doStart = async () => {
    setShowStartConfirm(false);
    setAgentStatus("running");
    setCurrentIteration(0);
    setAgentStartTime(Date.now()); // Track start time for elapsed timer
    clearAgentOutput();
    setMode("monitor"); // Switch to monitor mode to see output
    try {
      orchestratorRef.current?.setMaxIterations(maxIterations);
      await orchestratorRef.current?.start();
    } catch (err) {
      const errorMsg =
        err instanceof Error
          ? err.message
          : err
            ? String(err)
            : "Unknown error starting agent";
      setError(errorMsg);
    } finally {
      setAgentStatus("idle");
      setPendingHints([]);
    }
  };

  // Handle keyboard input
  useInput((input, key) => {
    // Handle quit confirmation dialog
    if (showQuitConfirm) {
      if (input === "y" || input === "Y") {
        doQuit();
        return;
      }
      if (input === "n" || input === "N" || key.escape) {
        setShowQuitConfirm(false);
        return;
      }
      return; // Ignore other keys while dialog is open
    }

    // Handle start confirmation dialog
    if (showStartConfirm) {
      if (input === "y" || input === "Y") {
        doStart();
        return;
      }
      if (input === "n" || input === "N" || key.escape) {
        setShowStartConfirm(false);
        return;
      }
      // Handle number input for max iterations
      if (/^\d$/.test(input)) {
        setMaxIterations((prev) => {
          const newValue = prev * 10 + parseInt(input, 10);
          return newValue > 999 ? parseInt(input, 10) : newValue;
        });
        return;
      }
      // Backspace to delete last digit
      if (key.backspace || key.delete) {
        setMaxIterations((prev) => Math.floor(prev / 10) || 1);
        return;
      }
      return; // Ignore other keys while dialog is open
    }

    // Handle stop confirmation dialog
    if (showStopConfirm) {
      if (input === "y" || input === "Y") {
        orchestratorRef.current?.stop();
        setAgentStatus("idle");
        setPendingHints([]);
        setShowStopConfirm(false);
        return;
      }
      if (input === "n" || input === "N" || key.escape) {
        setShowStopConfirm(false);
        return;
      }
      return; // Ignore other keys while dialog is open
    }

    // Handle no PRD dialog
    if (showNoPrdDialog) {
      if (key.escape || input === "o" || input === "O") {
        setShowNoPrdDialog(false);
        return;
      }
      return; // Ignore other keys while dialog is open
    }

    // Handle hint dialog
    if (showHintDialog) {
      if (key.escape) {
        setShowHintDialog(false);
        setHintText("");
        return;
      }
      if (key.return) {
        if (hintText.trim()) {
          orchestratorRef.current?.addHint(hintText.trim());
          setPendingHints((prev) => [...prev, hintText.trim()]);
        }
        setShowHintDialog(false);
        setHintText("");
        return;
      }
      if (key.backspace || key.delete) {
        setHintText((prev) => prev.slice(0, -1));
        return;
      }
      // Regular character input
      if (input && !key.ctrl && !key.meta) {
        setHintText((prev) => prev + input);
        return;
      }
      return; // Ignore other keys while dialog is open
    }

    // Ctrl+C shows quit confirmation (instead of direct quit)
    if (key.ctrl && input === "c") {
      setShowQuitConfirm(true);
      return;
    }

    // Escape: exit input mode, clear error, or cancel quit
    if (key.escape) {
      if (inputMode) {
        setInputMode(false);
        return;
      }
      if (error) {
        setError(null);
        return;
      }
    }

    // When in input mode, don't process global shortcuts
    if (inputMode) {
      return;
    }

    // Focus terminal pane (press 'f' in planning mode)
    if (mode === "planning" && input === "f") {
      tmuxLayout.focusTerminal();
      return;
    }

    // Keep 'i' to focus terminal for familiarity
    if (mode === "planning" && input === "i") {
      tmuxLayout.focusTerminal();
      return;
    }

    // Quit - show confirmation
    if (input === "q") {
      setShowQuitConfirm(true);
      return;
    }

    // Switch modes (cycle: planning -> monitor -> output -> planning)
    if (key.tab) {
      const modes = ["planning", "monitor", "output"] as const;
      const idx = modes.indexOf(mode);
      const nextMode =
        idx === -1
          ? "planning"
          : (modes[(idx + 1) % modes.length] ?? "planning");
      setMode(nextMode);
      return;
    }

    // Tab shortcuts (work in both modes)
    if (input === "1") setSelectedTab("prd");
    if (input === "2") setSelectedTab("kanban");
    if (input === "3") setSelectedTab("learnings");
    if (input === "4") setSelectedTab("research");

    // Toggle backlog expansion (only on kanban tab)
    if (input === "b" && selectedTab === "kanban") {
      setBacklogExpanded(!backlogExpanded);
      return;
    }

    // Toggle completed expansion (only on kanban tab)
    if (input === "c" && selectedTab === "kanban") {
      setCompletedExpanded(!completedExpanded);
      return;
    }

    // Toggle abandoned expansion (only on kanban tab)
    if (input === "a" && selectedTab === "kanban") {
      setAbandonedExpanded(!abandonedExpanded);
      return;
    }

    // Scroll backlog when expanded (Shift+J/K)
    if (backlogExpanded && selectedTab === "kanban") {
      if (input === "J") {
        scrollBacklogDown();
        return;
      }
      if (input === "K") {
        scrollBacklogUp();
        return;
      }
    }

    // Scroll completed when expanded (Shift+J/K) - only if backlog not expanded
    if (
      completedExpanded &&
      !backlogExpanded &&
      !abandonedExpanded &&
      selectedTab === "kanban"
    ) {
      if (input === "J") {
        scrollCompletedDown();
        return;
      }
      if (input === "K") {
        scrollCompletedUp();
        return;
      }
    }

    // Scroll abandoned when expanded (Shift+J/K) - only if backlog/completed not expanded
    if (
      abandonedExpanded &&
      !backlogExpanded &&
      !completedExpanded &&
      selectedTab === "kanban"
    ) {
      if (input === "J") {
        scrollAbandonedDown();
        return;
      }
      if (input === "K") {
        scrollAbandonedUp();
        return;
      }
    }

    // Experiments tab navigation
    if (selectedTab === "experiments") {
      // j/k to navigate experiment selection
      if (input === "j" || key.downArrow) {
        selectNextExperiment(experimentFlatList);
        return;
      }
      if (input === "k" || key.upArrow) {
        selectPrevExperiment(experimentFlatList);
        return;
      }
      // Enter to toggle expand
      if (key.return) {
        if (selectedExperimentId) {
          toggleExpandedExperiment(selectedExperimentId);
        }
        return;
      }
      // Escape to collapse
      if (key.escape) {
        setExpandedExperimentId(null);
        return;
      }
    }

    // Scroll knowledge panel (j/k or arrow keys) - for other tabs
    if (input === "j" || key.downArrow) {
      scrollDown();
      return;
    }
    if (input === "k" || key.upArrow) {
      scrollUp();
      return;
    }

    // Start/stop agent
    if (input === "s") {
      if (agentStatus === "running") {
        setShowStopConfirm(true);
      } else {
        // Check if PRD exists before allowing start
        const checkPrd = async () => {
          const prdPath = `${projectPath}/.ml-ralph/prd.json`;
          const prdExists = await Bun.file(prdPath).exists();
          if (prdExists) {
            setShowStartConfirm(true);
          } else {
            setShowNoPrdDialog(true);
          }
        };
        checkPrd();
      }
      return;
    }

    // Add hint (only when agent is running)
    if (input === "h" && agentStatus === "running") {
      setShowHintDialog(true);
      return;
    }

    // Stop training jobs
    if (input === "t" && mode === "monitor") {
      const runningJob = activeJobs.find((j) => j.status === "running");
      if (runningJob) {
        stopTrainingJob(runningJob.id).catch((err: Error) => {
          setError(`Failed to stop training: ${err.message}`);
        });
      }
      return;
    }

    // Open W&B
    if (input === "w" && mode === "monitor") {
      const runningJobs = activeJobs.filter((j) => j.status === "running");
      const jobWithWandB =
        runningJobs.find((j) => j.wandbUrl) ??
        activeJobs.find((j) => j.wandbUrl);
      if (jobWithWandB?.wandbUrl) {
        import("bun").then(({ spawn }) => {
          spawn(["open", jobWithWandB.wandbUrl!]);
        });
      }
      return;
    }
  });

  // Warning if not in tmux
  const showTmuxWarning = !tmuxLayout.isInTmux && tmuxLayout.isInitialized;

  return (
    <Box flexDirection="column" height={terminalHeight}>
      {/* Logo - disabled for now
      <Box justifyContent="center">
        <Logo />
      </Box>
      */}

      {/* Navigation bar with mode tabs and help */}
      <Box paddingX={1} justifyContent="space-between" marginBottom={0}>
        <ModeTabs activeMode={mode} />
        <HelpBar
          mode={mode}
          agentStatus={agentStatus}
          pendingHintsCount={pendingHints.length}
        />
      </Box>

      {/* Tmux warning */}
      {showTmuxWarning && (
        <Box
          paddingX={1}
          borderStyle="single"
          borderColor={colors.accentYellow}
        >
          <Text color={colors.accentYellow}>
            Run inside tmux for the best experience: tmux new-session -s
            ml-ralph
          </Text>
        </Box>
      )}

      {/* Init warning */}
      {!isInitialized && (
        <Box
          paddingX={1}
          borderStyle="single"
          borderColor={colors.accentYellow}
        >
          <Text color={colors.accentYellow}>Initializing ml-ralph...</Text>
        </Box>
      )}

      {/* Error display */}
      {error && (
        <Box paddingX={1} borderStyle="single" borderColor={colors.accentRed}>
          <Text color={colors.accentRed}>Error: {error}</Text>
          <Text color={colors.textMuted}> (Esc to dismiss)</Text>
        </Box>
      )}

      {/* Main content */}
      <Box flexGrow={1}>
        {mode === "planning" ? (
          <PlanningScreen />
        ) : mode === "monitor" ? (
          <MonitorScreen
            currentIteration={currentIteration}
            startTime={agentStartTime}
            projectPath={projectPath}
            scrollActive={
              !showQuitConfirm &&
              !showStartConfirm &&
              !showStopConfirm &&
              !showNoPrdDialog &&
              !showHintDialog &&
              !inputMode
            }
          />
        ) : (
          <OutputScreen
            scrollActive={
              !showQuitConfirm &&
              !showStartConfirm &&
              !showStopConfirm &&
              !showNoPrdDialog &&
              !showHintDialog &&
              !inputMode
            }
          />
        )}
      </Box>

      {/* Quit confirmation dialog */}
      {showQuitConfirm && <QuitConfirmDialog />}

      {/* Start confirmation dialog */}
      {showStartConfirm && <StartConfirmDialog maxIterations={maxIterations} />}

      {/* Stop confirmation dialog */}
      {showStopConfirm && <StopConfirmDialog />}

      {/* No PRD dialog */}
      {showNoPrdDialog && <NoPrdDialog />}

      {/* Hint dialog */}
      {showHintDialog && (
        <HintDialog hintText={hintText} pendingHints={pendingHints} />
      )}
    </Box>
  );
}

/**
 * Help bar component with keyboard shortcuts
 */
function HelpBar({
  mode,
  agentStatus,
  pendingHintsCount,
}: {
  mode: "planning" | "monitor" | "output";
  agentStatus: string;
  pendingHintsCount: number;
}) {
  const Shortcut = ({
    keys,
    label,
    badge,
  }: {
    keys: string;
    label: string;
    badge?: number;
  }) => (
    <Box marginRight={2}>
      <Text backgroundColor={colors.bgTertiary} color={colors.text}>
        {" "}
        {keys}{" "}
      </Text>
      <Text color={colors.textSecondary}> {label}</Text>
      {badge !== undefined && badge > 0 && (
        <Text color={colors.accentYellow}> ({badge})</Text>
      )}
    </Box>
  );

  const nextMode =
    mode === "planning"
      ? "Monitor"
      : mode === "monitor"
        ? "Output"
        : "Planning";

  if (mode === "planning") {
    return (
      <Box>
        <Shortcut keys="Tab" label={nextMode} />
        <Shortcut keys="f" label="Terminal" />
        <Shortcut keys="1-5" label="Tabs" />
        <Shortcut keys="j/k" label="Scroll" />
        <Shortcut
          keys="s"
          label={agentStatus === "running" ? "Stop" : "Start"}
        />
        {agentStatus === "running" && (
          <Shortcut keys="h" label="Hint" badge={pendingHintsCount} />
        )}
        <Shortcut keys="q" label="Quit" />
      </Box>
    );
  }

  if (mode === "output") {
    return (
      <Box>
        <Shortcut keys="Tab" label={nextMode} />
        <Shortcut keys="[/]" label="Scroll" />
        <Shortcut keys="G" label="Follow" />
        <Shortcut
          keys="s"
          label={agentStatus === "running" ? "Stop" : "Start"}
        />
        {agentStatus === "running" && (
          <Shortcut keys="h" label="Hint" badge={pendingHintsCount} />
        )}
        <Shortcut keys="q" label="Quit" />
      </Box>
    );
  }

  return (
    <Box>
      <Shortcut keys="Tab" label={nextMode} />
      <Shortcut keys="1-5" label="Tabs" />
      <Shortcut keys="j/k" label="Scroll" />
      <Shortcut keys="[/]" label="Log" />
      <Shortcut keys="s" label={agentStatus === "running" ? "Stop" : "Start"} />
      {agentStatus === "running" && (
        <Shortcut keys="h" label="Hint" badge={pendingHintsCount} />
      )}
      <Shortcut keys="q" label="Quit" />
    </Box>
  );
}

/**
 * Confirmation dialog wrapper
 */
function ConfirmDialog({
  title,
  message,
  borderColor,
}: {
  title: string;
  message: string;
  borderColor: string;
}) {
  return (
    <Box
      position="absolute"
      flexDirection="column"
      alignItems="center"
      justifyContent="center"
      width="100%"
      height="100%"
      backgroundColor={colors.bgPrimary}
    >
      <Box
        flexDirection="column"
        borderStyle="double"
        borderColor={borderColor}
        paddingX={4}
        paddingY={1}
        backgroundColor={colors.bgSecondary}
      >
        <Text bold color={colors.text}>
          {title}
        </Text>
        <Box marginTop={1}>
          <Text color={colors.textSecondary}>{message}</Text>
        </Box>
        <Box marginTop={1} justifyContent="center" gap={3}>
          <Box>
            <Text backgroundColor={colors.accentGreen} color={colors.bgPrimary}>
              {" Y "}
            </Text>
            <Text color={colors.textSecondary}> Yes</Text>
          </Box>
          <Box>
            <Text backgroundColor={colors.accentRed} color={colors.bgPrimary}>
              {" N "}
            </Text>
            <Text color={colors.textSecondary}> No</Text>
          </Box>
        </Box>
      </Box>
    </Box>
  );
}

function QuitConfirmDialog() {
  return (
    <ConfirmDialog
      title="Quit ml-ralph?"
      message="This will close the tmux session."
      borderColor={colors.accentYellow}
    />
  );
}

function StartConfirmDialog({ maxIterations }: { maxIterations: number }) {
  return (
    <Box
      position="absolute"
      flexDirection="column"
      alignItems="center"
      justifyContent="center"
      width="100%"
      height="100%"
      backgroundColor={colors.bgPrimary}
    >
      <Box
        flexDirection="column"
        borderStyle="double"
        borderColor={colors.accentGreen}
        paddingX={4}
        paddingY={1}
        backgroundColor={colors.bgSecondary}
      >
        <Text bold color={colors.text}>
          Start ml-ralph agent?
        </Text>
        <Box marginTop={1}>
          <Text color={colors.textSecondary}>
            This will start the autonomous ML agent loop.
          </Text>
        </Box>
        <Box marginTop={1} gap={1}>
          <Text color={colors.textSecondary}>Max iterations:</Text>
          <Text color={colors.accentBlue} bold>
            {maxIterations}
          </Text>
          <Text color={colors.textMuted}>(type number to change)</Text>
        </Box>
        <Box marginTop={1} justifyContent="center" gap={3}>
          <Box>
            <Text backgroundColor={colors.accentGreen} color={colors.bgPrimary}>
              {" Y "}
            </Text>
            <Text color={colors.textSecondary}> Yes</Text>
          </Box>
          <Box>
            <Text backgroundColor={colors.accentRed} color={colors.bgPrimary}>
              {" N "}
            </Text>
            <Text color={colors.textSecondary}> No</Text>
          </Box>
        </Box>
      </Box>
    </Box>
  );
}

function StopConfirmDialog() {
  return (
    <ConfirmDialog
      title="Stop ml-ralph agent?"
      message="This will stop the current iteration."
      borderColor={colors.accentYellow}
    />
  );
}

/**
 * No PRD dialog - prompts user to create a PRD first
 */
function NoPrdDialog() {
  return (
    <Box
      position="absolute"
      flexDirection="column"
      alignItems="center"
      justifyContent="center"
      width="100%"
      height="100%"
    >
      <Box
        flexDirection="column"
        borderStyle="double"
        borderColor={colors.accentYellow}
        paddingX={3}
        paddingY={1}
      >
        <Text bold color={colors.text}>
          No PRD found
        </Text>
        <Box marginTop={1}>
          <Text color={colors.textSecondary}>
            Create a PRD before starting the agent.
          </Text>
        </Box>
        <Box marginTop={1}>
          <Text color={colors.textSecondary}>
            Use Claude Code in the terminal (press{" "}
            <Text color={colors.accentBlue}>f</Text>) to create one:
          </Text>
        </Box>
        <Box marginTop={1}>
          <Text color={colors.textMuted}>
            Tell Claude about your ML project and ask it to
          </Text>
        </Box>
        <Box>
          <Text color={colors.textMuted}>
            write a PRD to{" "}
            <Text color={colors.accentBlue}>.ml-ralph/prd.json</Text>
          </Text>
        </Box>
        <Box marginTop={1} justifyContent="center">
          <Box>
            <Text backgroundColor={colors.textMuted} color={colors.bgPrimary}>
              {" "}
              Esc{" "}
            </Text>
            <Text color={colors.textSecondary}> OK</Text>
          </Box>
        </Box>
      </Box>
    </Box>
  );
}

/**
 * Hint dialog - allows user to send hints to the running agent
 */
function HintDialog({
  hintText,
  pendingHints,
}: {
  hintText: string;
  pendingHints: string[];
}) {
  // Truncate hint text for display
  const displayText = hintText || " ";
  const maxWidth = 50;

  return (
    <Box
      position="absolute"
      flexDirection="column"
      alignItems="center"
      justifyContent="center"
      width="100%"
      height="100%"
      backgroundColor={colors.bgPrimary}
    >
      <Box
        flexDirection="column"
        borderStyle="double"
        borderColor={colors.accentBlue}
        paddingX={2}
        paddingY={1}
        backgroundColor={colors.bgSecondary}
      >
        {/* Header */}
        <Box marginBottom={1}>
          <Text bold color={colors.text}>
            Send hint to agent
          </Text>
          {pendingHints.length > 0 && (
            <Text color={colors.accentYellow}>
              {" "}
              ({pendingHints.length} queued)
            </Text>
          )}
        </Box>

        {/* Queued hints */}
        {pendingHints.length > 0 && (
          <Box flexDirection="column" marginBottom={1}>
            <Text color={colors.textMuted}>Queued for next iteration:</Text>
            {pendingHints.slice(-3).map((hint, i) => (
              <Box key={i}>
                <Text color={colors.accentYellow}> {i + 1}. </Text>
                <Text color={colors.textSecondary}>
                  {hint.length > 45 ? hint.slice(0, 45) + "..." : hint}
                </Text>
              </Box>
            ))}
            {pendingHints.length > 3 && (
              <Text color={colors.textMuted}>
                {" "}
                ... and {pendingHints.length - 3} more
              </Text>
            )}
          </Box>
        )}

        {/* Instructions */}
        <Box marginBottom={1}>
          <Text color={colors.textSecondary}>
            Type your hint (will be added to queue):
          </Text>
        </Box>

        {/* Text input area */}
        <Box
          borderStyle="single"
          borderColor={colors.accentBlue}
          paddingX={1}
          paddingY={0}
          minWidth={maxWidth}
        >
          <Text color={colors.text} wrap="truncate">
            {displayText}
            <Text color={colors.accentBlue} bold>
              |
            </Text>
          </Text>
        </Box>

        {/* Buttons */}
        <Box marginTop={1} gap={2}>
          <Box>
            <Text backgroundColor={colors.accentGreen} color={colors.bgPrimary}>
              {" Enter "}
            </Text>
            <Text color={colors.textSecondary}> Add to queue</Text>
          </Box>
          <Box>
            <Text backgroundColor={colors.bgTertiary} color={colors.text}>
              {" Esc "}
            </Text>
            <Text color={colors.textSecondary}> Close</Text>
          </Box>
        </Box>
      </Box>
    </Box>
  );
}
