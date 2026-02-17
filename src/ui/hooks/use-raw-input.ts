/**
 * useRawInput hook - forward raw keyboard input when active
 */

import { useInput } from "../ink.tsx";

interface UseRawInputOptions {
  active: boolean;
  onInput: (data: string) => void;
}

/**
 * Forwards raw keyboard input to a callback when active.
 * Handles special keys by converting them to escape sequences.
 */
export function useRawInput({ active, onInput }: UseRawInputOptions): void {
  useInput(
    (input, key) => {
      if (!active) return;

      // Don't forward Ctrl+C (let App handle exit)
      if (key.ctrl && input === "c") return;

      // Don't forward Escape (let App handle mode switch)
      if (key.escape) return;

      // Convert special keys to terminal escape sequences
      if (key.return) {
        onInput("\r");
        return;
      }

      if (key.backspace || key.delete) {
        onInput("\x7f"); // DEL character
        return;
      }

      if (key.tab) {
        onInput("\t");
        return;
      }

      // Arrow keys
      if (key.upArrow) {
        onInput("\x1b[A");
        return;
      }
      if (key.downArrow) {
        onInput("\x1b[B");
        return;
      }
      if (key.rightArrow) {
        onInput("\x1b[C");
        return;
      }
      if (key.leftArrow) {
        onInput("\x1b[D");
        return;
      }

      // Ctrl combinations
      if (key.ctrl && input) {
        const charCode = input.charCodeAt(0);
        // Ctrl+A through Ctrl+Z are 1-26
        if (charCode >= 97 && charCode <= 122) {
          onInput(String.fromCharCode(charCode - 96));
          return;
        }
      }

      // Regular character input
      if (input && !key.ctrl && !key.meta) {
        onInput(input);
      }
    },
    { isActive: active },
  );
}
