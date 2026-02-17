/**
 * Research types - information gathered by the agent via web search
 */

import type { ResearchType } from "./enums.ts";

export interface CodeSnippet {
  language: string;
  code: string;
  description: string;
}

export interface ResearchItem {
  id: string; // "R-001"
  timestamp: string; // ISO timestamp

  // What was found
  title: string;
  summary: string; // Agent's summary
  url?: string; // Source URL

  // Categorization
  type: ResearchType;
  tags: string[];

  // Context
  relevance: string; // Why this matters
  storyId?: string; // Which story triggered this

  // Extracted content
  keyTakeaways: string[]; // Bullet points
  codeSnippets?: CodeSnippet[]; // Useful code
}

/**
 * Create a new research item with defaults
 */
export function createResearchItem(
  partial: Omit<ResearchItem, "id" | "timestamp">,
): ResearchItem {
  return {
    ...partial,
    id: `R-${Date.now()}`,
    timestamp: new Date().toISOString(),
  };
}
