import { createElement } from "react";
import { Text } from "../ink.tsx";

interface MarkdownProps {
  children?: React.ReactNode;
}

export function Markdown({ children }: MarkdownProps) {
  if (typeof children === "string") {
    return createElement("markdown", { content: children });
  }

  if (children === null || children === undefined) {
    return null;
  }

  return <Text wrap="wrap">{String(children)}</Text>;
}
