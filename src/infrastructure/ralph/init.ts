/**
 * ML-Ralph initialization - creates .ml-ralph/ directory and templates
 */

import {
  AGENTS_MD,
  CLAUDE_MD,
  DEFAULT_KANBAN,
  DEFAULT_PRD,
  RALPH_MD,
  SKILL_MD,
} from "./templates.ts";

const ML_RALPH_DIR = ".ml-ralph";

export interface InitOptions {
  projectPath: string;
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
 * Initialize ml-ralph in the project directory
 */
export async function initRalph(options: InitOptions): Promise<InitResult> {
  const { projectPath, force = false } = options;
  const filesCreated: string[] = [];

  // Check for existing files
  const claudeMdPath = `${projectPath}/CLAUDE.md`;
  const agentsMdPath = `${projectPath}/AGENTS.md`;

  if (!force) {
    const claudeExists = await Bun.file(claudeMdPath).exists();
    const agentsExists = await Bun.file(agentsMdPath).exists();

    if (claudeExists || agentsExists) {
      return {
        success: false,
        error:
          "CLAUDE.md or AGENTS.md already exists. Use force option to overwrite.",
        filesCreated: [],
      };
    }
  }

  try {
    // Create .ml-ralph directory
    const mlRalphDir = `${projectPath}/${ML_RALPH_DIR}`;
    await Bun.$`mkdir -p ${mlRalphDir}`.quiet();

    // Write RALPH.md
    const ralphMdPath = `${mlRalphDir}/RALPH.md`;
    await Bun.write(ralphMdPath, RALPH_MD);
    filesCreated.push(ralphMdPath);

    // Write CLAUDE.md to project root
    await Bun.write(claudeMdPath, CLAUDE_MD);
    filesCreated.push(claudeMdPath);

    // Write AGENTS.md to project root
    await Bun.write(agentsMdPath, AGENTS_MD);
    filesCreated.push(agentsMdPath);

    // Create skills directories and install skill
    const skillDirs = [
      `${projectPath}/.claude/skills/ml-ralph`,
      `${projectPath}/.codex/skills/ml-ralph`,
    ];

    for (const skillDir of skillDirs) {
      await Bun.$`mkdir -p ${skillDir}`.quiet();
      const skillPath = `${skillDir}/SKILL.md`;
      await Bun.write(skillPath, SKILL_MD);
      filesCreated.push(skillPath);
    }

    // Create empty log.jsonl
    const logPath = `${mlRalphDir}/log.jsonl`;
    const logExists = await Bun.file(logPath).exists();
    if (!logExists) {
      await Bun.write(logPath, "");
      filesCreated.push(logPath);
    }

    // Create default prd.json if it doesn't exist
    const prdPath = `${mlRalphDir}/prd.json`;
    const prdExists = await Bun.file(prdPath).exists();
    if (!prdExists) {
      const projectName = projectPath.split("/").pop() || "ml-project";
      const prd = { ...DEFAULT_PRD, project: projectName };
      await Bun.write(prdPath, JSON.stringify(prd, null, 2));
      filesCreated.push(prdPath);
    }

    // Create default kanban.json if it doesn't exist
    const kanbanPath = `${mlRalphDir}/kanban.json`;
    const kanbanExists = await Bun.file(kanbanPath).exists();
    if (!kanbanExists) {
      await Bun.write(kanbanPath, JSON.stringify(DEFAULT_KANBAN, null, 2));
      filesCreated.push(kanbanPath);
    }

    // Enable agent teams in .claude/settings.json if requested
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
  const skillDirs = [
    `${projectPath}/.claude/skills/ml-ralph`,
    `${projectPath}/.codex/skills/ml-ralph`,
  ];

  for (const skillDir of skillDirs) {
    const skillPath = `${skillDir}/SKILL.md`;
    const skillFile = Bun.file(skillPath);
    if (!(await skillFile.exists())) {
      await Bun.$`mkdir -p ${skillDir}`.quiet();
      await Bun.write(skillPath, SKILL_MD);
    }
  }
}

/**
 * Ensure ml-ralph is initialized, initializing if needed
 *
 * This is more permissive than initRalph - it will create the .ml-ralph/
 * directory structure without requiring CLAUDE.md/AGENTS.md to be absent.
 */
export async function ensureInitialized(projectPath: string): Promise<boolean> {
  const initialized = await isInitialized(projectPath);

  // Always ensure skills and agent teams are configured
  await ensureSkills(projectPath);
  await enableAgentTeamsSettings(projectPath);

  if (initialized) {
    return true;
  }

  // Try normal init first
  const result = await initRalph({ projectPath, force: false });
  if (result.success) {
    return true;
  }

  // If it failed due to existing CLAUDE.md/AGENTS.md, create just the .ml-ralph/ structure
  const mlRalphDir = `${projectPath}/${ML_RALPH_DIR}`;

  // Ensure directory exists
  const dir = Bun.file(mlRalphDir);
  const dirExists = await dir.exists();
  if (!dirExists) {
    await Bun.$`mkdir -p ${mlRalphDir}`.quiet();
  }

  // Write RALPH.md (the marker file for initialization)
  const ralphMdPath = `${mlRalphDir}/RALPH.md`;
  await Bun.write(ralphMdPath, RALPH_MD);

  // Create empty log.jsonl if it doesn't exist
  const logPath = `${mlRalphDir}/log.jsonl`;
  const logFile = Bun.file(logPath);
  if (!(await logFile.exists())) {
    await Bun.write(logPath, "");
  }

  // Create default prd.json if it doesn't exist
  const prdPath = `${mlRalphDir}/prd.json`;
  const prdFile = Bun.file(prdPath);
  if (!(await prdFile.exists())) {
    const projectName = projectPath.split("/").pop() || "ml-project";
    const prd = { ...DEFAULT_PRD, project: projectName };
    await Bun.write(prdPath, JSON.stringify(prd, null, 2));
  }

  // Create default kanban.json if it doesn't exist
  const kanbanPath = `${mlRalphDir}/kanban.json`;
  const kanbanFile = Bun.file(kanbanPath);
  if (!(await kanbanFile.exists())) {
    await Bun.write(kanbanPath, JSON.stringify(DEFAULT_KANBAN, null, 2));
  }

  // Verify initialization succeeded
  return isInitialized(projectPath);
}
