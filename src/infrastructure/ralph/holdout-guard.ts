/**
 * Holdout guard - spots a tool call in the claude stream that mentions the sealed holdout path
 */

import { realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname } from "node:path";
import { holdoutConfigFile, readHoldoutPath } from "./holdout.ts";

/**
 * What the runner holds while a run is active; only matching text, never the
 * path, leaves it. A needle ending in `/` is a directory that is flagged when
 * named as a whole or as a glob/listing target (`ls /dir`, `cat /dir/*`), not
 * for every path below it; any other needle also covers the paths below it.
 */
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

/** Directory needles (a trailing `/` marks them) for the parent directories of the given paths; the root is skipped */
function directoryNeedles(...paths: string[]): string[] {
  const out = new Set<string>();
  for (const path of paths) {
    const dir = withoutTrailingSlashes(dirname(path));
    if (!dir) continue;
    out.add(`${dir}/`);
    out.add(`${JSON.stringify(dir).slice(1, -1)}/`);
  }
  return [...out];
}

/**
 * Read the holdout path for a project from the user-level config and return
 * its needles: the holdout path and the config file's own path, since reading
 * the config reveals the holdout path (each also by its real path), plus the
 * holdout's parent directory and the config directory as directory needles
 * (listing them or globbing in them reaches the holdout). Empty when no usable holdout is configured: the config is
 * missing, has no entry for this project, or `readHoldoutPath` refuses it. The
 * path is read again every iteration, so a config change applies to the next one.
 */
export async function loadHoldoutNeedles(
  projectPath: string,
  env?: Record<string, string | undefined>,
): Promise<HoldoutNeedles> {
  const holdout = await readHoldoutPath(projectPath, env);
  if (!holdout.ok) return [];
  const config = holdoutConfigFile(env);
  const configReal = await realpath(config).catch(() => config);
  return [
    ...holdoutNeedles(holdout.path, holdout.realPath, config, configReal),
    ...directoryNeedles(holdout.path, holdout.realPath, config, configReal),
  ];
}

const regexEscape = (text: string) =>
  text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Characters that continue a file name; a needle followed by one names a different path */
const NAME_CHAR = "[\\w.~-]";

/** A needle as a regex: it must end the name, so a sibling with a shared prefix does not match */
function needleRegex(needle: string): RegExp {
  if (needle.endsWith("/")) {
    const dir = regexEscape(needle.slice(0, -1));
    return new RegExp(`${dir}(?:$|[^\\w.~/-]|/+(?:$|[^\\w.~/-]))`);
  }
  return new RegExp(`${regexEscape(needle)}(?!${NAME_CHAR})`);
}

/**
 * Replace the spellings of the home directory a shell expands (`~/`,
 * `$HOME`, `${HOME}`) with the real one, so a needle can match them.
 */
function expandHome(text: string, home: string): string {
  const escapedHome = home.replace(/\$/g, "$$$$");
  return text
    .replace(/\$\{HOME\}|\$HOME(?![\w])/g, escapedHome)
    .replace(/(?<![\w/.~-])~(?=\/)/g, escapedHome);
}

/** The string values nested in a tool input */
function stringValues(value: unknown, out: string[] = []): string[] {
  if (typeof value === "string") out.push(value);
  else if (Array.isArray(value)) for (const v of value) stringValues(v, out);
  else if (typeof value === "object" && value !== null)
    for (const v of Object.values(value)) stringValues(v, out);
  return out;
}

/** A shell glob as an anchored regex: `*` and `?` stay inside one path segment, `{a,b}` alternates */
function globRegex(glob: string): RegExp | null {
  let out = "";
  let braces = 0;
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i] as string;
    if (c === "*") {
      if (glob[i + 1] === "*") i++;
      out += "[^/]*";
    } else if (c === "?") out += "[^/]";
    else if (c === "[") {
      const end = glob.indexOf("]", i + 2);
      if (end < 0) out += "\\[";
      else {
        out += `[${glob
          .slice(i + 1, end)
          .replace(/^!/, "^")
          .replace(/\\/g, "\\\\")}]`;
        i = end;
      }
    } else if (c === "{") {
      braces++;
      out += "(?:";
    } else if (c === "}" && braces > 0) {
      braces--;
      out += ")";
    } else if (c === "," && braces > 0) out += "|";
    else out += regexEscape(c);
  }
  if (braces > 0) return null;
  try {
    return new RegExp(`^${out}$`);
  } catch {
    return null;
  }
}

const GLOB_CHARS = /[*?[{]/;

/** Whether an absolute glob in the text would match a protected path, or something inside it */
function globReachesNeedle(text: string, needles: HoldoutNeedles): boolean {
  const protectedPaths = needles
    .filter((n) => n.startsWith("/") && !n.includes("\\"))
    .map((n) => withoutTrailingSlashes(n));
  for (const token of text.split(/[\s'"`;|&<>()=]+/)) {
    if (!token.startsWith("/") || !GLOB_CHARS.test(token)) continue;
    const regex = globRegex(token);
    if (!regex) continue;
    if (protectedPaths.some((p) => regex.test(p) || regex.test(`${p}/x`)))
      return true;
  }
  return false;
}

/**
 * The first tool_use block of an `assistant` stream event whose serialized
 * input contains a needle, as its tool name. Pure and tolerant: any event or
 * block shape that is not a well-formed tool_use is skipped, never thrown on.
 * Besides the literal path it catches `~/`, `$HOME` and `${HOME}` spellings
 * (expanded to `home`), a directory needle named or globbed (`ls <dir>`,
 * `cat <dir>/*`) and absolute glob patterns that match a protected path. A
 * path sharing only a prefix with a needle (`<holdout>-train`) is not a match.
 */
export function findHoldoutToolUse(
  event: unknown,
  needles: HoldoutNeedles,
  home: string = homedir(),
): { toolName: string } | null {
  if (needles.length === 0) return null;
  const regexes = needles.map(needleRegex);
  const matches = (text: string) => regexes.some((r) => r.test(text));
  // Serialized input catches every spelling in one pass; each string value
  // alone is what a glob token is cut from (no JSON escapes in the way)
  const hit = (text: string, glob: boolean) => {
    const expanded = expandHome(text, home);
    return (
      matches(text) ||
      matches(expanded) ||
      (glob &&
        (globReachesNeedle(text, needles) ||
          globReachesNeedle(expanded, needles)))
    );
  };
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
    if (
      hit(serialized, false) ||
      stringValues(input).some((value) => hit(value, true))
    ) {
      return { toolName: typeof name === "string" && name ? name : "unknown" };
    }
  }
  return null;
}
