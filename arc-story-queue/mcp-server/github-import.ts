import { execFileSync } from "node:child_process";
import type { Story, TaskClass, WorkType } from "arc-contracts";
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

/**
 * Import GitHub issues into the store as backlog (non-draft) stories.
 * Dedupes by issue url so re-importing never creates duplicates.
 */
export function importIssuesToStore(args: {
  store: StoryStore;
  repo: string;
  issues: GithubIssue[];
}): Story[] {
  const { store, repo, issues } = args;
  const existing = new Set(store.listStories().map((s) => s.issue).filter(Boolean));
  const created: Story[] = [];
  for (const issue of issues) {
    if (existing.has(issue.url)) continue;
    const story = issueToStory(issue, repo, store.nextWid());
    store.upsertStory(story);
    created.push(story);
    existing.add(issue.url);
  }
  return created;
}
