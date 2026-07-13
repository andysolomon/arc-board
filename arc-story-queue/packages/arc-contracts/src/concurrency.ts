import type { Story } from "./index.js";

const EPIC_PREFIX = "epic:";
const PARALLEL_GROUP_PREFIX = "parallel-group:";

/** Mutex keys from GitHub label tags. parallel-group overrides epic when present. */
export function mutexKeysFromTags(tags: string[]): string[] {
  const parallelGroups = tags.filter((tag) => tag.startsWith(PARALLEL_GROUP_PREFIX));
  if (parallelGroups.length > 0) return parallelGroups;
  return tags.filter((tag) => tag.startsWith(EPIC_PREFIX));
}

export function storyMutexKeys(story: Pick<Story, "tags">): string[] {
  return mutexKeysFromTags(story.tags ?? []);
}

/** First conflicting mutex key, or null when the candidate may run. */
export function mutexConflict(
  candidate: Pick<Story, "tags">,
  inProgress: Array<Pick<Story, "tags">>
): string | null {
  const candidateKeys = storyMutexKeys(candidate);
  if (candidateKeys.length === 0) return null;
  for (const running of inProgress) {
    const runningKeys = storyMutexKeys(running);
    for (const key of candidateKeys) {
      if (runningKeys.includes(key)) return key;
    }
  }
  return null;
}

export function isDispatchEligible(
  candidate: Pick<Story, "tags">,
  inProgress: Array<Pick<Story, "tags">>,
  maxParallel: number
): boolean {
  if (inProgress.length >= maxParallel) return false;
  return mutexConflict(candidate, inProgress) === null;
}

/** True when GitHub Project Status says the issue is already in flight elsewhere. */
export function isGithubBoardRemoteBusy(
  story: Pick<Story, "githubBoardColumn">
): boolean {
  const column = story.githubBoardColumn;
  return column === "in_progress" || column === "review" || column === "done";
}

/** Concise board copy for a queued story blocked by label concurrency or remote Status. */
export function dispatchBlockReason(
  candidate: Pick<Story, "tags" | "githubBoardColumn">,
  inProgress: Array<Pick<Story, "tags">>
): string | null {
  if (isGithubBoardRemoteBusy(candidate)) {
    return `waiting · github ${candidate.githubBoardColumn}`;
  }
  const conflict = mutexConflict(candidate, inProgress);
  if (!conflict) return null;
  return `waiting · ${conflict} in progress`;
}
