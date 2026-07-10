import { execFileSync } from "node:child_process";
import { parseWidFromTitle, widSequence, type Story, type TaskClass, type WorkType } from "arc-contracts";
import type { StoryStore } from "./store.js";

export interface GithubIssue {
  number: number;
  title: string;
  body: string;
  url: string;
  labels: Array<{ name: string }>;
}

export type IssueLister = (repo: string) => GithubIssue[];

/** Default lister: shells out to the authenticated `gh` CLI (deterministic, not a model). */
export const ghListIssues: IssueLister = (repo) => {
  const out = execFileSync(
    "gh",
    [
      "issue",
      "list",
      "--repo",
      repo,
      "--state",
      "open",
      "--json",
      "number,title,body,url,labels",
      "--limit",
      "100",
    ],
    { encoding: "utf8" }
  );
  return JSON.parse(out) as GithubIssue[];
};

function slugify(s: string): string {
  return (
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "issue"
  );
}

/** Prefer a title-embedded W- id; otherwise allocate the next local counter value. */
export function resolveImportWid(store: StoryStore, issue: GithubIssue, exceptStoryId?: string): string {
  const fromTitle = parseWidFromTitle(issue.title);
  if (fromTitle && !store.isWidTaken(fromTitle, exceptStoryId)) {
    store.ensureWidCounterAtLeast(widSequence(fromTitle));
    return fromTitle;
  }
  return store.nextWid();
}

/** Map a GitHub issue to a filed (non-draft) backlog Story ready to be queued. */
export function issueToStory(issue: GithubIssue, repo: string, wid: string): Story {
  const isBug = issue.labels.some((l) => /bug/i.test(l.name));
  const type: WorkType = isBug ? "bug" : "story";
  const taskClass: TaskClass = isBug ? "bugfix" : "feature";
  return {
    id: `gh-${repo.replace(/[^a-zA-Z0-9]+/g, "-")}-${issue.number}`,
    wid,
    type,
    title: issue.title,
    repo,
    branch: `issue/${issue.number}-${slugify(issue.title)}`,
    worktree: "",
    column: "backlog",
    priority: "med",
    size: "M",
    epic: "",
    taskClass,
    tags: issue.labels.map((l) => l.name),
    description: issue.body ?? "",
    criteria: [],
    draft: false, // already a real filed issue
    issue: issue.url,
  };
}

function findStoryByIssue(store: StoryStore, issueUrl: string): Story | null {
  return store.listStories().find((story) => story.issue === issueUrl) ?? null;
}

/**
 * Import GitHub issues into the store as backlog (non-draft) stories.
 * Dedupes by issue url so re-importing never creates duplicates.
 * Re-import also repairs wid when the title carries a canonical W- id.
 */
export function importIssuesToStore(args: {
  store: StoryStore;
  repo: string;
  issues: GithubIssue[];
}): Story[] {
  const { store, repo, issues } = args;
  const created: Story[] = [];
  for (const issue of issues) {
    const existing = findStoryByIssue(store, issue.url);
    if (existing) continue;

    const story = issueToStory(issue, repo, resolveImportWid(store, issue));
    store.upsertStory(story);
    created.push(story);
  }
  return created;
}
