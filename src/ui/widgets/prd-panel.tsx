/**
 * PRD panel - displays the full PRD content with compact visual styling
 */

import type { PRD } from "../../infrastructure/ralph/index.ts";
import { Box, Text } from "../ink.tsx";
import { colors } from "../theme/colors.ts";

interface PrdPanelProps {
  prd: PRD | null;
}

/**
 * Status badge with icon
 */
function StatusBadge({ status }: { status: string }) {
  const defaultConfig = { color: colors.accentYellow, icon: "○" };
  const configs: Record<string, { color: string; icon: string }> = {
    approved: { color: colors.accentGreen, icon: "✓" },
    complete: { color: colors.accentBlue, icon: "●" },
    draft: defaultConfig,
    active: { color: colors.accentPurple, icon: "▶" },
  };

  const config = configs[status] ?? defaultConfig;

  return (
    <Text backgroundColor={config.color} color={colors.bgPrimary} bold>
      {" "}
      {config.icon} {status.toUpperCase()}{" "}
    </Text>
  );
}

/**
 * Compact section with colored header
 */
function Section({
  title,
  icon,
  color,
  children,
  flex,
}: {
  title: string;
  icon: string;
  color: string;
  children: React.ReactNode;
  flex?: number;
}) {
  return (
    <Box
      flexDirection="column"
      borderStyle="single"
      borderColor={color}
      paddingX={1}
      paddingY={0}
      flexGrow={flex}
      marginRight={flex ? 1 : 0}
    >
      <Box>
        <Text color={color}>{icon}</Text>
        <Text color={color} bold>
          {" "}
          {title}
        </Text>
      </Box>
      {children}
    </Box>
  );
}

export function PrdPanel({ prd }: PrdPanelProps) {
  if (!prd) {
    return (
      <Box flexDirection="column" padding={2}>
        <Box marginBottom={1}>
          <Text color={colors.accentYellow}>{"◇ "}</Text>
          <Text color={colors.text}>No PRD found</Text>
        </Box>
        <Text color={colors.textSecondary}>
          Use Claude Code in the terminal (press{" "}
          <Text color={colors.accentBlue}>f</Text>) to create one.
        </Text>
      </Box>
    );
  }

  const hasCriteria = prd.success_criteria && prd.success_criteria.length > 0;
  const hasConstraints = prd.constraints && prd.constraints.length > 0;
  const hasInScope = prd.scope?.in && prd.scope.in.length > 0;
  const hasOutScope = prd.scope?.out && prd.scope.out.length > 0;

  return (
    <Box flexDirection="column" paddingX={1}>
      {/* Header with project name and status */}
      <Box justifyContent="space-between" marginBottom={1}>
        <Text color={colors.text} bold>
          {prd.project || "Untitled Project"}
        </Text>
        <StatusBadge status={prd.status} />
      </Box>

      {/* Problem - full width */}
      {prd.problem && (
        <Box
          borderStyle="single"
          borderColor={colors.accentRed}
          paddingX={1}
          marginBottom={1}
        >
          <Text color={colors.accentRed}>?</Text>
          <Text color={colors.text}> {prd.problem}</Text>
        </Box>
      )}

      {/* Goal - full width */}
      {prd.goal && (
        <Box
          borderStyle="single"
          borderColor={colors.accentGreen}
          paddingX={1}
          marginBottom={1}
        >
          <Text color={colors.accentGreen}>◎</Text>
          <Text color={colors.text}> {prd.goal}</Text>
        </Box>
      )}

      {/* Success Criteria & Constraints - side by side */}
      {(hasCriteria || hasConstraints) && (
        <Box marginBottom={1}>
          {/* Success Criteria */}
          {hasCriteria && (
            <Section
              title="CRITERIA"
              icon="✓"
              color={colors.accentGreen}
              flex={1}
            >
              {prd.success_criteria!.map((criterion, i) => (
                <Box key={i}>
                  <Text color={colors.accentGreen}>○</Text>
                  <Text color={colors.text}> {criterion}</Text>
                </Box>
              ))}
            </Section>
          )}

          {/* Constraints */}
          {hasConstraints && (
            <Section
              title="CONSTRAINTS"
              icon="⚠"
              color={colors.accentYellow}
              flex={1}
            >
              {prd.constraints!.map((constraint, i) => (
                <Box key={i}>
                  <Text color={colors.accentYellow}>!</Text>
                  <Text color={colors.text}> {constraint}</Text>
                </Box>
              ))}
            </Section>
          )}
        </Box>
      )}

      {/* Scope - side by side */}
      {(hasInScope || hasOutScope) && (
        <Box>
          {/* In Scope */}
          {hasInScope && (
            <Section
              title="IN SCOPE"
              icon="+"
              color={colors.accentBlue}
              flex={1}
            >
              {prd.scope!.in!.map((item, i) => (
                <Box key={i}>
                  <Text color={colors.text}>• {item}</Text>
                </Box>
              ))}
            </Section>
          )}

          {/* Out of Scope */}
          {hasOutScope && (
            <Section
              title="OUT OF SCOPE"
              icon="−"
              color={colors.accentRed}
              flex={1}
            >
              {prd.scope!.out!.map((item, i) => (
                <Box key={i}>
                  <Text color={colors.textMuted}>• {item}</Text>
                </Box>
              ))}
            </Section>
          )}
        </Box>
      )}
    </Box>
  );
}
