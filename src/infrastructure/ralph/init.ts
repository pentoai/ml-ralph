/**
 * ML-Ralph initialization - creates .ml-ralph/ directory and templates
 */

import { mkdir } from "node:fs/promises";
import { createDefaultConfig } from "../../domain/types/index.ts";
import { JsonFileStore } from "../file-store/index.ts";
import {
  AGENTS_MD,
  CLAUDE_MD,
  DEFAULT_KANBAN,
  DEFAULT_PRD,
  RALPH_MD,
  SKILL_MD,
} from "./templates.ts";

const ML_RALPH_DIR = ".ml-ralph";

function skillDirs(projectPath: string): string[] {
  return [
    `${projectPath}/.claude/skills/ml-ralph`,
    `${projectPath}/.codex/skills/ml-ralph`,
  ];
}

export interface InitOptions {
  projectPath: string;
  /** Project name for config.json and the PRD (default: directory name) */
  name?: string;
  force?: boolean;
  enableTeams?: boolean;
}

export interface InitResult {
  success: boolean;
  error?: string;
  filesCreated: string[];
}

/**
 * Check if ml-ralph is already initialized in the project
 */
export async function isInitialized(projectPath: string): Promise<boolean> {
  const ralphMdPath = `${projectPath}/${ML_RALPH_DIR}/RALPH.md`;
  const file = Bun.file(ralphMdPath);
  return file.exists();
}

/**
 * Initialize ml-ralph in the project directory.
 *
 * Single init path shared by `ml-ralph init` and the TUI. Existing files are
 * left untouched unless `force` is set, so user edits survive a re-run.
 */
export async function initRalph(options: InitOptions): Promise<InitResult> {
  const { projectPath, force = false } = options;
  const name = options.name ?? (projectPath.split("/").pop() || "ml-project");
  const filesCreated: string[] = [];
  const mlRalphDir = `${projectPath}/${ML_RALPH_DIR}`;

  // Templates are overwritten with force; runtime data is only ever created
  const writeFile = async (
    path: string,
    content: string,
    overwrite = force,
  ) => {
    if (!overwrite && (await Bun.file(path).exists())) {
      return;
    }
    await Bun.write(path, content);
    filesCreated.push(path);
  };

  try {
    await mkdir(mlRalphDir, { recursive: true });

    await writeFile(`${mlRalphDir}/RALPH.md`, RALPH_MD);
    await writeFile(`${projectPath}/CLAUDE.md`, CLAUDE_MD);
    await writeFile(`${projectPath}/AGENTS.md`, AGENTS_MD);

    for (const skillDir of skillDirs(projectPath)) {
      await writeFile(`${skillDir}/SKILL.md`, SKILL_MD);
    }

    await writeFile(`${mlRalphDir}/log.jsonl`, "", false);
    await writeFile(`${mlRalphDir}/conclusions.md`, "", false);
    await writeFile(
      `${mlRalphDir}/prd.json`,
      JSON.stringify({ ...DEFAULT_PRD, project: name }, null, 2),
      false,
    );
    await writeFile(
      `${mlRalphDir}/kanban.json`,
      JSON.stringify(DEFAULT_KANBAN, null, 2),
      false,
    );

    filesCreated.push(
      ...(await ensureStoreData(projectPath, name, options.enableTeams)),
    );

    if (options.enableTeams) {
      const settingsFile = await enableAgentTeamsSettings(projectPath);
      if (settingsFile) {
        filesCreated.push(settingsFile);
      }
    }

    return {
      success: true,
      filesCreated,
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
      filesCreated,
    };
  }
}

/**
 * Create config.json, runs/active.json and chat/ for the application store,
 * leaving anything that already exists untouched. Returns the files created.
 */
async function ensureStoreData(
  projectPath: string,
  name: string,
  enableTeams?: boolean,
): Promise<string[]> {
  const created: string[] = [];
  const store = new JsonFileStore(projectPath);
  const mlRalphDir = `${projectPath}/${ML_RALPH_DIR}`;

  await mkdir(`${mlRalphDir}/chat`, { recursive: true });

  if (!(await store.exists())) {
    const config = createDefaultConfig(name);
    if (enableTeams) {
      config.agent.enableTeams = true;
    }
    await store.writeConfig(config);
    created.push(`${mlRalphDir}/config.json`);
  }

  const activePath = `${mlRalphDir}/runs/active.json`;
  if (!(await Bun.file(activePath).exists())) {
    await store.writeActiveJobs([]);
    created.push(activePath);
  }

  return created;
}

/**
 * Write or merge .claude/settings.json to enable agent teams
 */
export async function enableAgentTeamsSettings(
  projectPath: string,
): Promise<string | null> {
  const settingsPath = `${projectPath}/.claude/settings.json`;
  const settingsFile = Bun.file(settingsPath);

  let settings: Record<string, unknown> = {};
  if (await settingsFile.exists()) {
    try {
      settings = JSON.parse(await settingsFile.text());
    } catch {
      // If settings.json is invalid, start fresh
      settings = {};
    }
  }

  // Merge the env block
  const env = (settings.env ?? {}) as Record<string, string>;
  if (env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS === "1") {
    return null; // Already enabled
  }

  env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS = "1";
  settings.env = env;

  await Bun.$`mkdir -p ${projectPath}/.claude`.quiet();
  await Bun.write(settingsPath, JSON.stringify(settings, null, 2));
  return settingsPath;
}

/**
 * Ensure skills are installed in .claude and .codex directories
 */
async function ensureSkills(projectPath: string): Promise<void> {
  for (const skillDir of skillDirs(projectPath)) {
    const skillPath = `${skillDir}/SKILL.md`;
    if (!(await Bun.file(skillPath).exists())) {
      await Bun.write(skillPath, SKILL_MD);
    }
  }
}

/**
 * Ensure ml-ralph is initialized, initializing if needed
 */
export async function ensureInitialized(projectPath: string): Promise<boolean> {
  const initialized = await isInitialized(projectPath);

  // Always ensure skills and agent teams are configured
  await ensureSkills(projectPath);
  await enableAgentTeamsSettings(projectPath);

  if (initialized) {
    const name = projectPath.split("/").pop() || "ml-project";
    await ensureStoreData(projectPath, name);
    return true;
  }

  const result = await initRalph({ projectPath });
  return result.success && (await isInitialized(projectPath));
}
