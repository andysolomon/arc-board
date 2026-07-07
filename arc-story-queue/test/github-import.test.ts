import { describe, expect, it } from "vitest";
import { QueueManager } from "../mcp-server/dist/queue.js";
import { SessionRegistry } from "../mcp-server/dist/registry.js";
import { SseHub } from "../mcp-server/dist/sse.js";
import { StoryStore } from "../mcp-server/dist/store.js";
import {
  importIssuesToStore,
  issueToStory,
  type GithubIssue,
} from "../mcp-server/dist/github-import.js";

const repo = "andysolomon/arc-orchestrator";

function issue(n: number, title: string, labels: string[] = []): GithubIssue {
  return {
    number: n,
    title,
    body: `body ${n}`,
    url: `https://github.com/${repo}/issues/${n}`,
    labels: labels.map((name) => ({ name })),
  };
}

describe("github import", () => {
  it("maps an issue to a filed backlog story; bug labels set type/taskClass", () => {
    const bug = issueToStory(issue(5, "Crash on save", ["bug", "p1"]), repo, "W-000005");
    expect(bug.draft).toBe(false);
    expect(bug.column).toBe("backlog");
    expect(bug.issue).toBe(`https://github.com/${repo}/issues/5`);
    expect(bug.type).toBe("bug");
    expect(bug.taskClass).toBe("bugfix");
    expect(bug.tags).toEqual(["bug", "p1"]);

    const feat = issueToStory(issue(6, "Add search"), repo, "W-000006");
    expect(feat.type).toBe("story");
    expect(feat.taskClass).toBe("feature");
  });

  it("imports into the store and dedupes by issue url", () => {
    const store = new StoryStore(":memory:");
    const issues = [issue(1, "One"), issue(2, "Two")];

    const first = importIssuesToStore({ store, repo, issues });
    expect(first).toHaveLength(2);
    expect(new Set(first.map((s) => s.wid)).size).toBe(2); // distinct wids

    // re-import the same set + one new → only the new one is created
    const second = importIssuesToStore({ store, repo, issues: [...issues, issue(3, "Three")] });
    expect(second.map((s) => s.title)).toEqual(["Three"]);
    expect(store.listStories()).toHaveLength(3);
  });

  it("queue.importGithub uses an injected lister", () => {
    const store = new StoryStore(":memory:");
    const registry = new SessionRegistry();
    const queue = new QueueManager(
      { worktreeRoot: "/tmp/wt", maxParallel: 2 },
      { store, registry, sse: new SseHub() }
    );
    const created = queue.importGithub(repo, () => [issue(10, "Injected")]);
    expect(created.map((s) => s.title)).toEqual(["Injected"]);
    expect(store.getStory(`gh-andysolomon-arc-orchestrator-10`)?.issue).toBe(
      `https://github.com/${repo}/issues/10`
    );
  });
});
