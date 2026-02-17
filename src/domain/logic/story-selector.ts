/**
 * Story selection logic - pure functions for selecting the next story to work on
 */

import type { Story } from "../types/index.ts";

/**
 * Select the next story to work on
 * Returns the first pending story that is not superseded
 */
export function selectNextStory(stories: Story[]): Story | null {
  return (
    stories.find(
      (story) => story.status === "pending" && !story.supersededBy,
    ) ?? null
  );
}

/**
 * Get the currently in-progress story
 */
export function getCurrentStory(stories: Story[]): Story | null {
  return stories.find((story) => story.status === "in_progress") ?? null;
}

/**
 * Check if all stories are complete
 */
export function areAllStoriesComplete(stories: Story[]): boolean {
  return stories.every(
    (story) => story.status === "done" || story.status === "superseded",
  );
}

/**
 * Count stories by status
 */
export function countStoriesByStatus(stories: Story[]): {
  pending: number;
  in_progress: number;
  done: number;
  superseded: number;
  total: number;
} {
  const counts = {
    pending: 0,
    in_progress: 0,
    done: 0,
    superseded: 0,
    total: stories.length,
  };

  for (const story of stories) {
    counts[story.status]++;
  }

  return counts;
}

/**
 * Get stories that are affected by a learning
 */
export function getAffectedStories(
  stories: Story[],
  learningAppliesTo: string[],
): Story[] {
  return stories.filter((story) => learningAppliesTo.includes(story.id));
}
