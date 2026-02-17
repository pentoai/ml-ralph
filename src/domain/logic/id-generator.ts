/**
 * ID generation utilities
 */

/**
 * Generate a story ID (US-XXX format)
 */
export function generateStoryId(existingIds: string[]): string {
  const maxNum = existingIds.reduce((max, id) => {
    const match = id.match(/^US-(\d+)$/);
    if (match) {
      const num = parseInt(match[1]!, 10);
      return Math.max(max, num);
    }
    return max;
  }, 0);

  const nextNum = maxNum + 1;
  return `US-${nextNum.toString().padStart(3, "0")}`;
}

/**
 * Generate a learning ID (L-XXX format)
 */
export function generateLearningId(existingIds: string[]): string {
  const maxNum = existingIds.reduce((max, id) => {
    const match = id.match(/^L-(\d+)$/);
    if (match) {
      const num = parseInt(match[1]!, 10);
      return Math.max(max, num);
    }
    return max;
  }, 0);

  const nextNum = maxNum + 1;
  return `L-${nextNum.toString().padStart(3, "0")}`;
}

/**
 * Generate a research item ID (R-XXX format)
 */
export function generateResearchId(existingIds: string[]): string {
  const maxNum = existingIds.reduce((max, id) => {
    const match = id.match(/^R-(\d+)$/);
    if (match) {
      const num = parseInt(match[1]!, 10);
      return Math.max(max, num);
    }
    return max;
  }, 0);

  const nextNum = maxNum + 1;
  return `R-${nextNum.toString().padStart(3, "0")}`;
}

/**
 * Generate a progress entry ID (P-XXX format)
 */
export function generateProgressId(existingIds: string[]): string {
  const maxNum = existingIds.reduce((max, id) => {
    const match = id.match(/^P-(\d+)$/);
    if (match) {
      const num = parseInt(match[1]!, 10);
      return Math.max(max, num);
    }
    return max;
  }, 0);

  const nextNum = maxNum + 1;
  return `P-${nextNum.toString().padStart(3, "0")}`;
}

/**
 * Generate a job ID with timestamp
 */
export function generateJobId(): string {
  const now = new Date();
  const timestamp = now
    .toISOString()
    .replace(/[-:T.Z]/g, "")
    .slice(0, 14);
  return `job_${timestamp}`;
}
