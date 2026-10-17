/**
 * Holdout guard - spots a tool call in the claude stream that mentions the sealed holdout path
 */

import { readHoldoutPath } from "./holdout.ts";

/** What the runner holds while a run is active; only matching text, never the path, leaves it */
export type HoldoutNeedles = readonly string[];

const withoutTrailingSlashes = (path: string) => path.replace(/\/+$/, "");

/**
 * The strings to look for in a serialized tool input: each path with trailing
 * slashes dropped (so `cat /sealed` is caught for `/sealed/`), in raw and in
 * JSON-escaped form (a Windows-style path is escaped inside serialized JSON).
 */
export function holdoutNeedles(...paths: string[]): HoldoutNeedles {
  const needles = new Set<string>();
  for (const path of paths) {
    const trimmed = withoutTrailingSlashes(path);
    if (!trimmed) continue;
    needles.add(trimmed);
    needles.add(JSON.stringify(trimmed).slice(1, -1));
  }
  return [...needles];
}

/**
 * Read the holdout path for a project from the user-level config and return
 * its needles. Empty when no usable holdout is configured: the config is
 * missing, has no entry for this project, or `readHoldoutPath` refuses it. The
 * path is read again every iteration, so a config change applies to the next one.
 */
export async function loadHoldoutNeedles(
  projectPath: string,
  env?: Record<string, string | undefined>,
): Promise<HoldoutNeedles> {
  const holdout = await readHoldoutPath(projectPath, env);
  if (!holdout.ok) return [];
  return holdoutNeedles(holdout.path, holdout.realPath);
}

/**
 * The first tool_use block of an `assistant` stream event whose serialized
 * input contains a needle, as its tool name. Pure and tolerant: any event or
 * block shape that is not a well-formed tool_use is skipped, never thrown on.
 */
export function findHoldoutToolUse(
  event: unknown,
  needles: HoldoutNeedles,
): { toolName: string } | null {
  if (needles.length === 0) return null;
  if (typeof event !== "object" || event === null) return null;
  const record = event as Record<string, unknown>;
  if (record.type !== "assistant") return null;
  const message = record.message;
  if (typeof message !== "object" || message === null) return null;
  const content = (message as Record<string, unknown>).content;
  if (!Array.isArray(content)) return null;

  for (const block of content) {
    if (typeof block !== "object" || block === null) continue;
    const { type, name, input } = block as Record<string, unknown>;
    if (type !== "tool_use") continue;
    const serialized = JSON.stringify(input) ?? "";
    if (needles.some((needle) => serialized.includes(needle))) {
      return { toolName: typeof name === "string" && name ? name : "unknown" };
    }
  }
  return null;
}
