/**
 * Kanban panel - displays the working plan with a visual board layout
 */

import type {
  AbandonedTask,
  CompletedTask,
  Kanban,
  KanbanTask,
} from "../../infrastructure/ralph/index.ts";
import { Box, Text } from "../ink.tsx";
import { colors } from "../theme/colors.ts";

interface KanbanPanelProps {
  kanban: Kanban | null;
  offset?: number;
  limit?: number;
  backlogExpanded?: boolean;
  backlogOffset?: number;
  completedExpanded?: boolean;
  completedOffset?: number;
  abandonedExpanded?: boolean;
  abandonedOffset?: number;
}

/**
 * Backlog task item
 */
function BacklogItem({ task, index }: { task: KanbanTask; index: number }) {
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Box>
        <Text color={colors.textMuted}>{index + 1}. </Text>
        <Text color={colors.text}>{task.title}</Text>
      </Box>
      {task.why && (
        <Box marginLeft={3}>
          <Text color={colors.textSecondary}>{task.why}</Text>
        </Box>
      )}
      {task.notes && (
        <Box marginLeft={3}>
          <Text color={colors.textMuted}>Note: {task.notes}</Text>
        </Box>
      )}
    </Box>
  );
}

/**
 * Summary bar showing pipeline overview
 */
function PipelineSummary({ kanban }: { kanban: Kanban }) {
  const focusCount = kanban.current_focus ? 1 : 0;
  const nextCount = kanban.up_next.length;
  const backlogCount = kanban.backlog.length;
  const doneCount = kanban.completed.length;

  return (
    <Box marginBottom={1}>
      <Box marginRight={2}>
        <Text backgroundColor={colors.accentBlue} color={colors.bgPrimary} bold>
          {" "}
          {focusCount}{" "}
        </Text>
        <Text color={colors.textMuted}> Focus</Text>
      </Box>
      <Box marginRight={2}>
        <Text
          backgroundColor={colors.accentYellow}
          color={colors.bgPrimary}
          bold
        >
          {" "}
          {nextCount}{" "}
        </Text>
        <Text color={colors.textMuted}> Next</Text>
      </Box>
      <Box marginRight={2}>
        <Text backgroundColor={colors.bgTertiary} color={colors.text}>
          {" "}
          {backlogCount}{" "}
        </Text>
        <Text color={colors.textMuted}> Backlog</Text>
      </Box>
      <Box>
        <Text
          backgroundColor={colors.accentGreen}
          color={colors.bgPrimary}
          bold
        >
          {" "}
          {doneCount}{" "}
        </Text>
        <Text color={colors.textMuted}> Done</Text>
      </Box>
    </Box>
  );
}

/**
 * Visual progress bar
 */
function ProgressBar({ done, total }: { done: number; total: number }) {
  const width = 20;
  const filled = total > 0 ? Math.round((done / total) * width) : 0;
  const empty = width - filled;

  return (
    <Box>
      <Text color={colors.accentGreen}>{"█".repeat(filled)}</Text>
      <Text color={colors.bgTertiary}>{"░".repeat(empty)}</Text>
      <Text color={colors.textMuted}>
        {" "}
        {done}/{total}
      </Text>
    </Box>
  );
}

/**
 * Current focus card - the main highlight
 */
function CurrentFocusCard({ task }: { task: KanbanTask }) {
  return (
    <Box
      flexDirection="column"
      borderStyle="double"
      borderColor={colors.accentBlue}
      paddingX={2}
      paddingY={1}
    >
      {/* Header with title */}
      <Box marginBottom={1}>
        <Text color={colors.accentBlue} bold>
          {"▶ "}
        </Text>
        <Text color={colors.text} bold>
          {task.title}
        </Text>
      </Box>

      {/* Why - the reasoning */}
      {task.why && (
        <Box marginBottom={1}>
          <Text color={colors.textSecondary}>{task.why}</Text>
        </Box>
      )}

      {/* Metadata row - ID and Phase only */}
      <Box marginBottom={task.expected_outcome ? 1 : 0}>
        {task.id && (
          <Box marginRight={3}>
            <Text color={colors.textMuted}>ID </Text>
            <Text backgroundColor={colors.accentBlue} color={colors.bgPrimary}>
              {" "}
              {task.id}{" "}
            </Text>
          </Box>
        )}
        {task.phase && (
          <Box>
            <Text color={colors.textMuted}>Phase </Text>
            <Text
              backgroundColor={colors.accentPurple}
              color={colors.bgPrimary}
            >
              {" "}
              {task.phase}{" "}
            </Text>
          </Box>
        )}
      </Box>

      {/* Expected outcome - on its own line */}
      {task.expected_outcome && (
        <Box flexDirection="column">
          <Text color={colors.textMuted}>Expected outcome:</Text>
          <Box marginLeft={2}>
            <Text color={colors.accentGreen}>→ </Text>
            <Text color={colors.text}>{task.expected_outcome}</Text>
          </Box>
        </Box>
      )}
    </Box>
  );
}

/**
 * Up next task item
 */
function UpNextItem({
  task,
  index,
  isLast,
}: {
  task: KanbanTask;
  index: number;
  isLast: boolean;
}) {
  const connector = index === 0 ? "┌" : isLast ? "└" : "├";
  const line = isLast ? " " : "│";

  return (
    <Box flexDirection="column">
      <Box>
        <Text color={colors.accentYellow}>{connector}─ </Text>
        <Text
          backgroundColor={colors.accentYellow}
          color={colors.bgPrimary}
          bold
        >
          {" "}
          {index + 1}{" "}
        </Text>
        <Text color={colors.text} bold>
          {" "}
          {task.title}
        </Text>
        {task.depends_on && <Text color={colors.textMuted}> → after </Text>}
        {task.depends_on && (
          <Text color={colors.accentBlue}>{task.depends_on}</Text>
        )}
      </Box>
      {task.why && (
        <Box>
          <Text color={colors.accentYellow}>{line} </Text>
          <Text color={colors.textSecondary}>{task.why}</Text>
        </Box>
      )}
    </Box>
  );
}

/**
 * Completed task item - with outcome
 */
function CompletedItem({ task }: { task: CompletedTask }) {
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Box>
        <Text backgroundColor={colors.accentGreen} color={colors.bgPrimary}>
          {" "}
          ✓{" "}
        </Text>
        <Text color={colors.text}> {task.title}</Text>
      </Box>
      {task.outcome && (
        <Box marginLeft={3}>
          <Text color={colors.textMuted}>→ </Text>
          <Text color={colors.textSecondary}>{task.outcome}</Text>
        </Box>
      )}
    </Box>
  );
}

/**
 * Abandoned task item - with reason
 */
function AbandonedItem({ task }: { task: AbandonedTask }) {
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Box>
        <Text backgroundColor={colors.accentRed} color={colors.bgPrimary}>
          {" "}
          ✗{" "}
        </Text>
        <Text color={colors.textMuted} strikethrough>
          {" "}
          {task.title}
        </Text>
      </Box>
      {task.reason && (
        <Box marginLeft={3}>
          <Text color={colors.textMuted}>→ </Text>
          <Text color={colors.textSecondary}>{task.reason}</Text>
        </Box>
      )}
    </Box>
  );
}

/**
 * Section header with decorative line
 */
function SectionHeader({
  title,
  color,
  count,
}: {
  title: string;
  color: string;
  count?: number;
}) {
  return (
    <Box marginTop={1} marginBottom={0}>
      <Text color={color} bold>
        {title}
      </Text>
      {count !== undefined && <Text color={colors.textMuted}> ({count})</Text>}
      <Text color={colors.border}> {"─".repeat(30)}</Text>
    </Box>
  );
}

export function KanbanPanel({
  kanban,
  offset: _offset = 0,
  limit: _limit = 10,
  backlogExpanded = false,
  backlogOffset = 0,
  completedExpanded = false,
  completedOffset = 0,
  abandonedExpanded = false,
  abandonedOffset = 0,
}: KanbanPanelProps) {
  if (!kanban) {
    return (
      <Box flexDirection="column" padding={2}>
        <Text color={colors.textMuted}>No kanban.json found.</Text>
        <Text color={colors.textSecondary}>
          The agent will create one when it starts working.
        </Text>
      </Box>
    );
  }

  const isEmpty =
    !kanban.current_focus &&
    kanban.up_next.length === 0 &&
    kanban.backlog.length === 0 &&
    kanban.completed.length === 0;

  if (isEmpty) {
    return (
      <Box flexDirection="column" padding={2}>
        <Box marginBottom={1}>
          <Text color={colors.accentYellow}>{"◇ "}</Text>
          <Text color={colors.text}>Kanban is empty</Text>
        </Box>
        <Text color={colors.textSecondary}>
          The agent will populate this with tasks as it plans and works.
        </Text>
      </Box>
    );
  }

  const totalTasks =
    (kanban.current_focus ? 1 : 0) +
    kanban.up_next.length +
    kanban.backlog.length +
    kanban.completed.length;

  return (
    <Box flexDirection="column" paddingX={1}>
      {/* Pipeline Summary */}
      <PipelineSummary kanban={kanban} />

      {/* Progress */}
      {totalTasks > 0 && (
        <Box marginBottom={1}>
          <Text color={colors.textMuted}>Progress: </Text>
          <ProgressBar done={kanban.completed.length} total={totalTasks} />
        </Box>
      )}

      {/* Last update reason */}
      {kanban.update_reason && (
        <Box marginBottom={1}>
          <Text color={colors.textMuted}>Last update: </Text>
          <Text color={colors.textSecondary} italic>
            {kanban.update_reason}
          </Text>
        </Box>
      )}

      {/* Current Focus */}
      {kanban.current_focus && (
        <Box flexDirection="column" marginBottom={1}>
          <SectionHeader title="CURRENT FOCUS" color={colors.accentBlue} />
          <CurrentFocusCard task={kanban.current_focus} />
        </Box>
      )}

      {/* Up Next - The 5-6 step lookahead */}
      {kanban.up_next.length > 0 && (
        <Box flexDirection="column" marginBottom={1}>
          <SectionHeader
            title="UP NEXT"
            color={colors.accentYellow}
            count={kanban.up_next.length}
          />
          <Box flexDirection="column">
            {kanban.up_next.slice(0, 5).map((task, i, arr) => (
              <UpNextItem
                key={task.id || i}
                task={task}
                index={i}
                isLast={i === arr.length - 1 || i === 4}
              />
            ))}
          </Box>
          {kanban.up_next.length > 5 && (
            <Box marginTop={1}>
              <Text color={colors.textMuted}>
                {" "}
                + {kanban.up_next.length - 5} more tasks planned
              </Text>
            </Box>
          )}
        </Box>
      )}

      {/* Backlog */}
      {kanban.backlog.length > 0 && (
        <Box flexDirection="column" marginBottom={1} marginTop={1}>
          {/* Backlog header - always visible */}
          <Box>
            <Text
              color={backlogExpanded ? colors.accentCyan : colors.textMuted}
            >
              {backlogExpanded ? "▼" : "▶"}{" "}
            </Text>
            <Text
              color={backlogExpanded ? colors.accentCyan : colors.textMuted}
              bold
            >
              BACKLOG{" "}
            </Text>
            <Text backgroundColor={colors.bgTertiary} color={colors.text}>
              {" "}
              {kanban.backlog.length}{" "}
            </Text>
            <Text color={colors.textSecondary}> ideas</Text>
            <Text color={colors.textMuted}> (press </Text>
            <Text color={colors.accentCyan}>b</Text>
            <Text color={colors.textMuted}>
              {" "}
              to {backlogExpanded ? "collapse" : "expand"})
            </Text>
          </Box>

          {/* Expanded backlog items */}
          {backlogExpanded && (
            <Box
              flexDirection="column"
              marginTop={1}
              borderStyle="single"
              borderColor={colors.border}
              paddingX={2}
              paddingY={1}
            >
              {/* Scroll hint */}
              {kanban.backlog.length > 5 && (
                <Box marginBottom={1}>
                  <Text color={colors.textMuted}>
                    Showing {backlogOffset + 1}-
                    {Math.min(backlogOffset + 5, kanban.backlog.length)} of{" "}
                    {kanban.backlog.length}
                  </Text>
                  <Text color={colors.textSecondary}>
                    {" "}
                    (Shift+J/K to scroll)
                  </Text>
                </Box>
              )}

              {/* Backlog items */}
              {kanban.backlog
                .slice(backlogOffset, backlogOffset + 5)
                .map((task, i) => (
                  <BacklogItem
                    key={task.id || i}
                    task={task}
                    index={backlogOffset + i}
                  />
                ))}

              {/* More items indicator */}
              {backlogOffset + 5 < kanban.backlog.length && (
                <Text color={colors.textMuted}>
                  ... {kanban.backlog.length - backlogOffset - 5} more below
                </Text>
              )}
            </Box>
          )}
        </Box>
      )}

      {/* Completed */}
      {kanban.completed.length > 0 && (
        <Box flexDirection="column" marginBottom={1} marginTop={1}>
          {/* Completed header - always visible */}
          <Box>
            <Text
              color={completedExpanded ? colors.accentGreen : colors.textMuted}
            >
              {completedExpanded ? "▼" : "▶"}{" "}
            </Text>
            <Text
              color={completedExpanded ? colors.accentGreen : colors.textMuted}
              bold
            >
              COMPLETED{" "}
            </Text>
            <Text backgroundColor={colors.accentGreen} color={colors.bgPrimary}>
              {" "}
              {kanban.completed.length}{" "}
            </Text>
            <Text color={colors.textSecondary}> done</Text>
            <Text color={colors.textMuted}> (press </Text>
            <Text color={colors.accentGreen}>c</Text>
            <Text color={colors.textMuted}>
              {" "}
              to {completedExpanded ? "collapse" : "expand"})
            </Text>
          </Box>

          {/* Expanded completed items */}
          {completedExpanded && (
            <Box
              flexDirection="column"
              marginTop={1}
              borderStyle="single"
              borderColor={colors.accentGreen}
              paddingX={2}
              paddingY={1}
            >
              {/* Scroll hint */}
              {kanban.completed.length > 5 && (
                <Box marginBottom={1}>
                  <Text color={colors.textMuted}>
                    Showing {completedOffset + 1}-
                    {Math.min(completedOffset + 5, kanban.completed.length)} of{" "}
                    {kanban.completed.length}
                  </Text>
                  <Text color={colors.textSecondary}>
                    {" "}
                    (Shift+J/K to scroll)
                  </Text>
                </Box>
              )}

              {/* Completed items - show newest first */}
              {[...kanban.completed]
                .reverse()
                .slice(completedOffset, completedOffset + 5)
                .map((task, i) => (
                  <CompletedItem key={task.id || i} task={task} />
                ))}

              {/* More items indicator */}
              {completedOffset + 5 < kanban.completed.length && (
                <Text color={colors.textMuted}>
                  ... {kanban.completed.length - completedOffset - 5} more below
                </Text>
              )}
            </Box>
          )}
        </Box>
      )}

      {/* Abandoned */}
      {kanban.abandoned.length > 0 && (
        <Box flexDirection="column" marginBottom={1} marginTop={1}>
          {/* Abandoned header - always visible */}
          <Box>
            <Text
              color={abandonedExpanded ? colors.accentRed : colors.textMuted}
            >
              {abandonedExpanded ? "▼" : "▶"}{" "}
            </Text>
            <Text
              color={abandonedExpanded ? colors.accentRed : colors.textMuted}
              bold
            >
              ABANDONED{" "}
            </Text>
            <Text backgroundColor={colors.accentRed} color={colors.bgPrimary}>
              {" "}
              {kanban.abandoned.length}{" "}
            </Text>
            <Text color={colors.textSecondary}> dropped</Text>
            <Text color={colors.textMuted}> (press </Text>
            <Text color={colors.accentRed}>a</Text>
            <Text color={colors.textMuted}>
              {" "}
              to {abandonedExpanded ? "collapse" : "expand"})
            </Text>
          </Box>

          {/* Expanded abandoned items */}
          {abandonedExpanded && (
            <Box
              flexDirection="column"
              marginTop={1}
              borderStyle="single"
              borderColor={colors.accentRed}
              paddingX={2}
              paddingY={1}
            >
              {/* Scroll hint */}
              {kanban.abandoned.length > 5 && (
                <Box marginBottom={1}>
                  <Text color={colors.textMuted}>
                    Showing {abandonedOffset + 1}-
                    {Math.min(abandonedOffset + 5, kanban.abandoned.length)} of{" "}
                    {kanban.abandoned.length}
                  </Text>
                  <Text color={colors.textSecondary}>
                    {" "}
                    (Shift+J/K to scroll)
                  </Text>
                </Box>
              )}

              {/* Abandoned items - show newest first */}
              {[...kanban.abandoned]
                .reverse()
                .slice(abandonedOffset, abandonedOffset + 5)
                .map((task, i) => (
                  <AbandonedItem key={task.id || i} task={task} />
                ))}

              {/* More items indicator */}
              {abandonedOffset + 5 < kanban.abandoned.length && (
                <Text color={colors.textMuted}>
                  ... {kanban.abandoned.length - abandonedOffset - 5} more below
                </Text>
              )}
            </Box>
          )}
        </Box>
      )}
    </Box>
  );
}
