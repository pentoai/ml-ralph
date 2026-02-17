import { EventEmitter } from "node:events";
import { type KeyEvent, TextAttributes } from "@opentui/core";
import {
  useKeyboard,
  useRenderer,
  useTerminalDimensions,
} from "@opentui/react";
import {
  createContext,
  createElement,
  useContext,
  useEffect,
  useMemo,
  useRef,
} from "react";

type Size = number | `${number}%` | "auto";

type InkBorderStyle = "single" | "double" | "round" | "rounded" | "heavy";
type OpenTUIBorderStyle = "single" | "double" | "rounded" | "heavy";

interface CommonLayoutProps {
  alignItems?: string;
  backgroundColor?: string;
  border?: boolean | Array<"top" | "right" | "bottom" | "left">;
  borderColor?: string;
  borderStyle?: InkBorderStyle;
  color?: string;
  flex?: number;
  flexDirection?: "row" | "column" | "row-reverse" | "column-reverse";
  flexGrow?: number;
  gap?: number | `${number}%`;
  height?: Size;
  justifyContent?: string;
  margin?: number | `${number}%` | "auto";
  marginBottom?: number | `${number}%` | "auto";
  marginLeft?: number | `${number}%` | "auto";
  marginRight?: number | `${number}%` | "auto";
  marginTop?: number | `${number}%` | "auto";
  marginX?: number | `${number}%` | "auto";
  marginY?: number | `${number}%` | "auto";
  maxHeight?: Size;
  maxWidth?: Size;
  minHeight?: Size;
  minWidth?: Size;
  overflow?: "hidden" | "visible";
  overflowX?: "hidden" | "visible";
  overflowY?: "hidden" | "visible";
  padding?: number | `${number}%`;
  paddingBottom?: number | `${number}%`;
  paddingLeft?: number | `${number}%`;
  paddingRight?: number | `${number}%`;
  paddingTop?: number | `${number}%`;
  paddingX?: number | `${number}%`;
  paddingY?: number | `${number}%`;
  position?: "relative" | "absolute";
  width?: Size;
}

export interface BoxProps extends CommonLayoutProps {
  children?: React.ReactNode;
}

export interface TextProps extends CommonLayoutProps {
  attributes?: number;
  bold?: boolean;
  children?: React.ReactNode;
  dimColor?: boolean;
  italic?: boolean;
  strikethrough?: boolean;
  underline?: boolean;
  wrap?: "wrap" | "truncate";
}

const TextNestingContext = createContext(false);

function preserveEdgeSpacesInString(value: string): string {
  const withLeading = value.replace(/^[ ]+/u, (m) => "\u00A0".repeat(m.length));
  return withLeading.replace(
    /[ ]+$/u,
    (m) => `${"\u00A0".repeat(m.length)}\u2060`,
  );
}

function preserveEdgeSpaces(node: React.ReactNode): React.ReactNode {
  if (typeof node === "string") return preserveEdgeSpacesInString(node);
  if (Array.isArray(node)) return node.map((part) => preserveEdgeSpaces(part));
  return node;
}

function mapBorderStyle(
  style: InkBorderStyle | undefined,
): OpenTUIBorderStyle | undefined {
  if (!style) return undefined;
  if (style === "round") return "rounded";
  return style;
}

function mapLayoutProps(props: CommonLayoutProps): Record<string, unknown> {
  const mapped: Record<string, unknown> = { ...props };

  if (props.borderStyle) {
    mapped.borderStyle = mapBorderStyle(props.borderStyle);
    if (props.border === undefined) {
      mapped.border = true;
    }
  }

  if (props.flex !== undefined && props.flexGrow === undefined) {
    mapped.flexGrow = props.flex;
  }

  if (props.overflow === undefined) {
    mapped.overflow = props.overflowY ?? props.overflowX;
  }

  if (props.paddingX !== undefined) {
    mapped.paddingLeft = props.paddingX;
    mapped.paddingRight = props.paddingX;
  }
  if (props.paddingY !== undefined) {
    mapped.paddingTop = props.paddingY;
    mapped.paddingBottom = props.paddingY;
  }
  if (props.marginX !== undefined) {
    mapped.marginLeft = props.marginX;
    mapped.marginRight = props.marginX;
  }
  if (props.marginY !== undefined) {
    mapped.marginTop = props.marginY;
    mapped.marginBottom = props.marginY;
  }

  delete mapped.borderStyle;
  if (props.borderStyle) {
    mapped.borderStyle = mapBorderStyle(props.borderStyle);
  }
  delete mapped.flex;
  delete mapped.marginX;
  delete mapped.marginY;
  delete mapped.overflowX;
  delete mapped.overflowY;
  delete mapped.paddingX;
  delete mapped.paddingY;

  return mapped;
}

function mapBoxPropsForCompat(
  props: CommonLayoutProps,
): Record<string, unknown> {
  const mapped = mapLayoutProps(props);
  if (mapped.flexDirection === undefined) {
    mapped.flexDirection = "row";
  }
  return mapped;
}

function mapTextPropsForCompat(
  props: CommonLayoutProps & Pick<TextProps, "wrap">,
): Record<string, unknown> {
  const mapped = mapLayoutProps(props);
  if (props.wrap === "truncate") {
    mapped.truncate = true;
    mapped.wrapMode = "none";
    return mapped;
  }

  // Ink defaults to wrapping text.
  mapped.truncate = false;
  mapped.wrapMode = "word";
  return mapped;
}

export const __testing = {
  mapBoxPropsForCompat,
  mapTextPropsForCompat,
  preserveEdgeSpacesInString,
};

export function Box({ children, ...props }: BoxProps) {
  return createElement("box", mapBoxPropsForCompat(props), children);
}

export function Text({
  children,
  bold,
  dimColor,
  italic,
  underline,
  strikethrough,
  wrap,
  color,
  backgroundColor,
  attributes,
  ...props
}: TextProps) {
  const inNestedText = useContext(TextNestingContext);
  const mapped = mapTextPropsForCompat({ ...props, wrap });

  if (color !== undefined) {
    mapped.fg = color;
  }
  if (backgroundColor !== undefined) {
    mapped.bg = backgroundColor;
  }

  let attr = attributes ?? 0;
  if (bold) attr |= TextAttributes.BOLD;
  if (dimColor) attr |= TextAttributes.DIM;
  if (italic) attr |= TextAttributes.ITALIC;
  if (underline) attr |= TextAttributes.UNDERLINE;
  if (strikethrough) attr |= TextAttributes.STRIKETHROUGH;
  if (attr !== 0) {
    mapped.attributes = attr;
  }

  if (inNestedText) {
    delete mapped.wrapMode;
    delete mapped.truncate;
  }

  delete mapped.color;
  delete mapped.backgroundColor;

  const nestedChildren = createElement(
    TextNestingContext.Provider,
    { value: true },
    preserveEdgeSpaces(children),
  );
  if (inNestedText) {
    const spanProps: Record<string, unknown> = {};
    if (mapped.id !== undefined) spanProps.id = mapped.id;
    if (mapped.fg !== undefined) spanProps.fg = mapped.fg;
    if (mapped.bg !== undefined) spanProps.bg = mapped.bg;
    if (mapped.attributes !== undefined)
      spanProps.attributes = mapped.attributes;
    return createElement("span", spanProps, nestedChildren);
  }
  return createElement("text", mapped, nestedChildren);
}

export interface Key {
  backspace: boolean;
  ctrl: boolean;
  delete: boolean;
  downArrow: boolean;
  end: boolean;
  escape: boolean;
  home: boolean;
  leftArrow: boolean;
  meta: boolean;
  pageDown: boolean;
  pageUp: boolean;
  return: boolean;
  rightArrow: boolean;
  shift: boolean;
  tab: boolean;
  upArrow: boolean;
}

function toInputChar(event: KeyEvent): string {
  if (event.name === "space") return " ";
  if (event.name.length === 1) {
    if (event.shift && /[a-z]/.test(event.name)) {
      return event.name.toUpperCase();
    }
    return event.name;
  }
  return "";
}

function toInkKey(event: KeyEvent): Key {
  return {
    upArrow: event.name === "up",
    downArrow: event.name === "down",
    leftArrow: event.name === "left",
    rightArrow: event.name === "right",
    return: event.name === "return" || event.name === "enter",
    escape: event.name === "escape",
    tab: event.name === "tab",
    backspace: event.name === "backspace",
    delete: event.name === "delete",
    pageDown: event.name === "pagedown",
    pageUp: event.name === "pageup",
    home: event.name === "home",
    end: event.name === "end",
    ctrl: event.ctrl,
    meta: event.meta,
    shift: event.shift,
  };
}

export function useInput(
  handler: (input: string, key: Key) => void,
  options?: { isActive?: boolean },
) {
  useKeyboard((event) => {
    if (options?.isActive === false) return;
    handler(toInputChar(event), toInkKey(event));
  });
}

export function useApp() {
  const renderer = useRenderer();
  return useMemo(
    () => ({
      exit: (error?: string | Error) => {
        renderer.destroy();
        if (error) {
          console.error(error);
          process.exit(1);
        }
        process.exit(0);
      },
    }),
    [renderer],
  );
}

export function useFocusManager() {
  return useMemo(
    () => ({
      disableFocus: () => {},
      enableFocus: () => {},
      focusNext: () => {},
      focusPrevious: () => {},
      focus: () => {},
    }),
    [],
  );
}

type ResizeListener = () => void;
type StdoutLike = EventEmitter & { columns: number; rows: number };

export function useStdout(): { stdout: StdoutLike } {
  const renderer = useRenderer();
  const { width, height } = useTerminalDimensions();
  const stdoutRef = useRef<StdoutLike | null>(null);

  if (!stdoutRef.current) {
    const stdout = new EventEmitter() as StdoutLike;
    stdout.columns = renderer.width;
    stdout.rows = renderer.height;
    stdoutRef.current = stdout;
  }

  useEffect(() => {
    const stdout = stdoutRef.current;
    if (!stdout) return;
    const changed = stdout.columns !== width || stdout.rows !== height;
    stdout.columns = width;
    stdout.rows = height;
    if (changed) {
      stdout.emit("resize");
    }
  }, [width, height]);

  return { stdout: stdoutRef.current };
}

export type { ResizeListener };
