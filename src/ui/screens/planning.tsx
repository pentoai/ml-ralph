/**
 * Planning screen - Knowledge panel only
 *
 * In tmux split mode, this shows on the right side while the terminal is on the left.
 * The tmux pane handles Claude Code, this just shows the knowledge tabs.
 */

import { Box } from "../ink.tsx";
import { KnowledgePanel } from "../widgets/knowledge-panel.tsx";

export function PlanningScreen() {
  return (
    <Box flexDirection="column" flexGrow={1}>
      <KnowledgePanel />
    </Box>
  );
}
