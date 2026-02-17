/**
 * JSON FileStore implementation using Bun's file APIs
 */

import { mkdir } from "node:fs/promises";
import type {
  ChatSession,
  Learning,
  PRD,
  ProgressEntry,
  ProjectConfig,
  ResearchItem,
  TrainingJob,
} from "../../domain/types/index.ts";
import type { FileStore } from "./types.ts";

export class JsonFileStore implements FileStore {
  private readonly basePath: string;

  constructor(projectPath: string) {
    this.basePath = `${projectPath}/.ml-ralph`;
  }

  // === PRD ===

  async readPRD(): Promise<PRD | null> {
    return this.readJsonFile<PRD>(`${this.basePath}/prd.json`);
  }

  async writePRD(prd: PRD): Promise<void> {
    await this.writeJsonFile(`${this.basePath}/prd.json`, prd);
  }

  // === Progress ===

  async appendProgress(entry: ProgressEntry): Promise<void> {
    await this.appendJsonl(`${this.basePath}/progress.jsonl`, entry);
  }

  async readProgress(): Promise<ProgressEntry[]> {
    return this.readJsonlFile<ProgressEntry>(`${this.basePath}/progress.jsonl`);
  }

  // === Learnings ===

  async appendLearning(learning: Learning): Promise<void> {
    await this.appendJsonl(`${this.basePath}/learnings.jsonl`, learning);
  }

  async readLearnings(): Promise<Learning[]> {
    return this.readJsonlFile<Learning>(`${this.basePath}/learnings.jsonl`);
  }

  // === Research ===

  async appendResearch(item: ResearchItem): Promise<void> {
    await this.appendJsonl(`${this.basePath}/research.jsonl`, item);
  }

  async readResearch(): Promise<ResearchItem[]> {
    return this.readJsonlFile<ResearchItem>(`${this.basePath}/research.jsonl`);
  }

  // === Jobs ===

  async readActiveJobs(): Promise<TrainingJob[]> {
    const data = await this.readJsonFile<{ jobs: TrainingJob[] }>(
      `${this.basePath}/runs/active.json`,
    );
    return data?.jobs ?? [];
  }

  async writeActiveJobs(jobs: TrainingJob[]): Promise<void> {
    await this.ensureDir(`${this.basePath}/runs`);
    await this.writeJsonFile(`${this.basePath}/runs/active.json`, { jobs });
  }

  async appendJobHistory(job: TrainingJob): Promise<void> {
    await this.ensureDir(`${this.basePath}/runs`);
    await this.appendJsonl(`${this.basePath}/runs/history.jsonl`, job);
  }

  async readJobHistory(): Promise<TrainingJob[]> {
    return this.readJsonlFile<TrainingJob>(
      `${this.basePath}/runs/history.jsonl`,
    );
  }

  // === Config ===

  async readConfig(): Promise<ProjectConfig | null> {
    return this.readJsonFile<ProjectConfig>(`${this.basePath}/config.json`);
  }

  async writeConfig(config: ProjectConfig): Promise<void> {
    await this.writeJsonFile(`${this.basePath}/config.json`, config);
  }

  // === Chat ===

  async readChatSession(id: string): Promise<ChatSession | null> {
    return this.readJsonFile<ChatSession>(`${this.basePath}/chat/${id}.json`);
  }

  async writeChatSession(session: ChatSession): Promise<void> {
    await this.ensureDir(`${this.basePath}/chat`);
    await this.writeJsonFile(
      `${this.basePath}/chat/${session.id}.json`,
      session,
    );
  }

  // === Utility ===

  async exists(): Promise<boolean> {
    const file = Bun.file(`${this.basePath}/config.json`);
    return file.exists();
  }

  async initialize(config: ProjectConfig): Promise<void> {
    // Create directory structure
    await this.ensureDir(this.basePath);
    await this.ensureDir(`${this.basePath}/chat`);
    await this.ensureDir(`${this.basePath}/runs`);

    // Write config
    await this.writeConfig(config);

    // Initialize empty active jobs
    await this.writeActiveJobs([]);
  }

  // === Private helpers ===

  private async ensureDir(path: string): Promise<void> {
    try {
      await mkdir(path, { recursive: true });
    } catch (error) {
      // Ignore if already exists
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        throw error;
      }
    }
  }

  private async readJsonFile<T>(path: string): Promise<T | null> {
    const file = Bun.file(path);
    if (!(await file.exists())) {
      return null;
    }
    try {
      const text = await file.text();
      return JSON.parse(text) as T;
    } catch {
      return null;
    }
  }

  private async writeJsonFile<T>(path: string, data: T): Promise<void> {
    await this.ensureDir(path.substring(0, path.lastIndexOf("/")));
    await Bun.write(path, JSON.stringify(data, null, 2));
  }

  private async readJsonlFile<T>(path: string): Promise<T[]> {
    const file = Bun.file(path);
    if (!(await file.exists())) {
      return [];
    }
    try {
      const text = await file.text();
      const lines = text.trim().split("\n").filter(Boolean);
      return lines.map((line) => JSON.parse(line) as T);
    } catch {
      return [];
    }
  }

  private async appendJsonl<T>(path: string, data: T): Promise<void> {
    await this.ensureDir(path.substring(0, path.lastIndexOf("/")));
    const file = Bun.file(path);
    const exists = await file.exists();
    const line = `${JSON.stringify(data)}\n`;

    if (exists) {
      // Append to existing file
      const existing = await file.text();
      await Bun.write(path, existing + line);
    } else {
      await Bun.write(path, line);
    }
  }
}
