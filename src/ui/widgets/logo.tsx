/**
 * ML-RALPH logo/branding component
 */

import { Box, Text } from "../ink.tsx";
import { colors } from "../theme/colors.ts";

/**
 * Retro terminal style ASCII logo
 */
export function Logo() {
  return (
    <Box flexDirection="column">
      <Text color={colors.accentBlue}>
        {
          "┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓"
        }
      </Text>
      <Text>
        <Text color={colors.accentBlue}>{"┃ "}</Text>
        <Text color={colors.accentPurple}>
          {"███╗   ███╗██╗      ██████╗  █████╗ ██╗     ██████╗ ██╗  ██╗"}
        </Text>
        <Text color={colors.accentBlue}>{"       ┃"}</Text>
      </Text>
      <Text>
        <Text color={colors.accentBlue}>{"┃ "}</Text>
        <Text color={colors.accentPurple}>
          {"████╗ ████║██║      ██╔══██╗██╔══██╗██║     ██╔══██╗██║  ██║"}
        </Text>
        <Text color={colors.accentBlue}>{"       ┃"}</Text>
      </Text>
      <Text>
        <Text color={colors.accentBlue}>{"┃ "}</Text>
        <Text color={colors.accentPurple}>
          {"██╔████╔██║██║█████╗██████╔╝███████║██║     ██████╔╝███████║"}
        </Text>
        <Text color={colors.accentBlue}>{"       ┃"}</Text>
      </Text>
      <Text>
        <Text color={colors.accentBlue}>{"┃ "}</Text>
        <Text color={colors.accentPurple}>
          {"██║╚██╔╝██║██║╚════╝██╔══██╗██╔══██║██║     ██╔═══╝ ██╔══██║"}
        </Text>
        <Text color={colors.accentBlue}>{"       ┃"}</Text>
      </Text>
      <Text>
        <Text color={colors.accentBlue}>{"┃ "}</Text>
        <Text color={colors.accentPurple}>
          {"██║ ╚═╝ ██║███████╗ ██║  ██║██║  ██║███████╗██║     ██║  ██║"}
        </Text>
        <Text color={colors.accentBlue}>{"       ┃"}</Text>
      </Text>
      <Text>
        <Text color={colors.accentBlue}>{"┃ "}</Text>
        <Text color={colors.accentPurple}>
          {"╚═╝     ╚═╝╚══════╝ ╚═╝  ╚═╝╚═╝  ╚═╝╚══════╝╚═╝     ╚═╝  ╚═╝"}
        </Text>
        <Text color={colors.accentBlue}>{"       ┃"}</Text>
      </Text>
      <Text color={colors.accentBlue}>
        {
          "┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛"
        }
      </Text>
    </Box>
  );
}

/**
 * Single-line styled logo for compact spaces
 */
export function LogoInline() {
  return (
    <Text>
      <Text color={colors.accentBlue} bold>
        ML
      </Text>
      <Text color={colors.textMuted}>·</Text>
      <Text color={colors.accentPurple} bold>
        RALPH
      </Text>
    </Text>
  );
}
