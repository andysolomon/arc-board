import type { Story } from "arc-contracts";

/** Types accepted by amannn/action-semantic-pull-request and semantic-release. */
const CONVENTIONAL_PREFIX =
  /^(feat|fix|build|chore|ci|docs|style|refactor|perf|test)(\([^)]+\))?:\s+/i;

/** Conventional-commit type for a story's PR title and git commits. */
export function conventionalTypeForStory(story: Story): string {
  if (story.type === "bug" || story.taskClass === "bugfix") return "fix";
  if (story.taskClass === "refactor") return "refactor";
  if (story.taskClass === "perf") return "perf";
  if (story.taskClass === "docs") return "docs";
  if (story.taskClass === "migration") return "chore";
  if (story.tags.some((tag) => /^(monitor|smoke)$/i.test(tag))) return "chore";
  return "feat";
}

/** PR / commit title with a conventional prefix when the story title lacks one. */
export function conventionalTitle(story: Story): string {
  const title = story.title.trim();
  if (CONVENTIONAL_PREFIX.test(title)) return title;
  return `${conventionalTypeForStory(story)}: ${title}`;
}
