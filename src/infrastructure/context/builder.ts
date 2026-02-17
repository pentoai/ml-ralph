/**
 * Context builder - builds markdown context for Claude from PRD, learnings, research
 */

import type {
  Learning,
  PRD,
  ResearchItem,
  Story,
} from "../../domain/types/index.ts";

const MAX_LEARNINGS = 10;
const MAX_RESEARCH = 5;
const MAX_CONTEXT_LENGTH = 8000; // Leave room for conversation

interface ContextInput {
  prd: PRD | null;
  learnings: Learning[];
  research: ResearchItem[];
}

function formatStoryStatus(status: Story["status"]): string {
  const icons: Record<Story["status"], string> = {
    pending: "○",
    in_progress: "◐",
    done: "●",
    superseded: "↪",
  };
  return icons[status] || "?";
}

function formatStories(stories: Story[]): string {
  if (stories.length === 0) return "No stories yet.";

  return stories
    .map((s) => `- [${formatStoryStatus(s.status)}] ${s.id}: ${s.title}`)
    .join("\n");
}

function formatLearnings(learnings: Learning[]): string {
  if (learnings.length === 0) return "No learnings yet.";

  // Take most recent learnings
  const recent = learnings.slice(-MAX_LEARNINGS);
  return recent.map((l) => `- ${l.insight}`).join("\n");
}

function formatResearch(research: ResearchItem[]): string {
  if (research.length === 0) return "No research yet.";

  // Take most recent research
  const recent = research.slice(-MAX_RESEARCH);
  return recent.map((r) => `- **${r.title}**: ${r.summary}`).join("\n");
}

export function buildContext(input: ContextInput): string {
  const { prd, learnings, research } = input;

  if (!prd) {
    return `# Project Context

No PRD has been created yet. Help the user create a Product Requirements Document (PRD) for their ML project.

Ask about:
- Project goal and description
- Success criteria
- Data sources
- Evaluation strategy
- Constraints and scope

Output structured PRD updates as JSON when the user is ready.`;
  }

  const sections: string[] = [
    "# Project Context",
    "",
    `## Project: ${prd.project}`,
    prd.description || "(No description yet)",
    "",
    "## Goal",
    prd.goal || "(No goal defined yet)",
    "",
    "## Stories",
    formatStories(prd.stories),
    "",
    "## Success Criteria",
    prd.successCriteria.length > 0
      ? prd.successCriteria.map((c) => `- ${c.description}`).join("\n")
      : "No success criteria defined yet.",
    "",
    "## Key Learnings",
    formatLearnings(learnings),
    "",
    "## Recent Research",
    formatResearch(research),
    "",
    "## Instructions",
    "You are helping refine this ML project's PRD. When the user asks to update the PRD,",
    "acknowledge their request and make the changes. Focus on being helpful and iterative.",
    "",
    "Key areas to help with:",
    "- Refining the goal and success criteria",
    "- Breaking down work into stories",
    "- Identifying constraints and scope",
    "- Suggesting evaluation strategies",
  ];

  let context = sections.join("\n");

  // Truncate if too long
  if (context.length > MAX_CONTEXT_LENGTH) {
    context = `${context.slice(0, MAX_CONTEXT_LENGTH)}\n\n[Context truncated...]`;
  }

  return context;
}
