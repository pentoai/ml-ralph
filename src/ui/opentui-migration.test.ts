import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

function listFilesRecursive(dir: string): string[] {
  const entries = readdirSync(dir);
  const files: string[] = [];

  for (const entry of entries) {
    const fullPath = join(dir, entry);
    const stats = statSync(fullPath);
    if (stats.isDirectory()) {
      files.push(...listFilesRecursive(fullPath));
    } else {
      files.push(fullPath);
    }
  }

  return files;
}

describe("OpenTUI migration guard", () => {
  test("src/index.tsx uses OpenTUI renderer APIs", () => {
    const entry = readFileSync(join(process.cwd(), "src/index.tsx"), "utf8");
    expect(entry.includes("@opentui/core")).toBe(true);
    expect(entry.includes("@opentui/react")).toBe(true);
    expect(entry.includes("createCliRenderer")).toBe(true);
    expect(entry.includes("createRoot")).toBe(true);
    expect(entry.includes('from "ink"')).toBe(false);
    expect(entry.includes("from 'ink'")).toBe(false);
  });

  test("no source files import ink", () => {
    const srcRoot = join(process.cwd(), "src");
    const sourceFiles = listFilesRecursive(srcRoot).filter(
      (file) =>
        (file.endsWith(".ts") || file.endsWith(".tsx")) &&
        !file.endsWith("opentui-migration.test.ts"),
    );

    const offenders: string[] = [];
    for (const file of sourceFiles) {
      const content = readFileSync(file, "utf8");
      if (
        content.includes('from "ink"') ||
        content.includes("from 'ink'") ||
        content.includes('import "ink"') ||
        content.includes("import 'ink'")
      ) {
        offenders.push(file);
      }
    }

    expect(offenders).toEqual([]);
  });

  test("package.json has no ink dependencies", () => {
    const packageJson = JSON.parse(
      readFileSync(join(process.cwd(), "package.json"), "utf8"),
    ) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };

    const deps = {
      ...(packageJson.dependencies ?? {}),
      ...(packageJson.devDependencies ?? {}),
    };

    expect(Object.keys(deps)).not.toContain("ink");
    expect(Object.keys(deps)).not.toContain("ink-spinner");
    expect(Object.keys(deps)).not.toContain("ink-markdown");
    expect(Object.keys(deps)).not.toContain("@jescalan/ink-markdown");
    expect(Object.keys(deps)).toContain("@opentui/core");
    expect(Object.keys(deps)).toContain("@opentui/react");
  });
});
