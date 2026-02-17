/**
 * Domain logic - re-export all logic from a single entry point
 */

export {
  generateJobId,
  generateLearningId,
  generateProgressId,
  generateResearchId,
  generateStoryId,
} from "./id-generator.ts";
export {
  areAllStoriesComplete,
  countStoriesByStatus,
  getAffectedStories,
  getCurrentStory,
  selectNextStory,
} from "./story-selector.ts";
