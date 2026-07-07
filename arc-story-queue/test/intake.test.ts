import { describe, expect, it } from "vitest";
import { IntakeManager } from "../mcp-server/dist/intake.js";
import { QueueManager } from "../mcp-server/dist/queue.js";
import { SessionRegistry } from "../mcp-server/dist/registry.js";
import { SseHub } from "../mcp-server/dist/sse.js";
import { StoryStore } from "../mcp-server/dist/store.js";
import type { Story } from "arc-contracts";

function makeStory(overrides: Partial<Story> = {}): Story {
  return {
    id: "story-1",
    wid: "W-000123",
    type: "story",
    title: "Test",
    repo: "test/repo",
    branch: "feat/test",
    worktree: "",
    column: "backlog",
    priority: "med",
    size: "S",
    epic: "",
    taskClass: "feature",
    tags: [],
    description: "A test story",
    criteria: ["works"],
    draft: true,
    issue: null,
    ...overrides,
  };
}

function makeManagers() {
  const store = new StoryStore(":memory:");
  const registry = new SessionRegistry();
  const sse = new SseHub();
  const queue = new QueueManager(
    { worktreeRoot: "/tmp/wt", maxParallel: 2 },
    { store, registry, sse }
  );
  const intake = new IntakeManager({ store });
  return { store, queue, intake };
}

describe("pipeline guardrails", () => {
  it("rejects enqueueStory for draft stories until filed", async () => {
    const { store, queue } = makeManagers();
    const story = makeStory({ id: "draft-1", draft: true, issue: null, column: "backlog" });
    store.upsertStory(story);

    await expect(queue.enqueueStory("draft-1")).rejects.toThrow(
      "Cannot queue a draft — file it as a GitHub issue first (story.file)"
    );

    const filed = await queue.file("draft-1", "#42");
    expect(filed.draft).toBe(false);
    expect(filed.issue).toBe("#42");

    const queued = await queue.enqueueStory("draft-1");
    expect(queued.column).toBe("queued");
    expect(store.queueIds()).toContain("draft-1");
  });

  it("rejects enqueueStory for unfiled non-draft stories", async () => {
    const { store, queue } = makeManagers();
    const story = makeStory({ id: "unfiled-1", draft: false, issue: null, column: "backlog" });
    store.upsertStory(story);

    await expect(queue.enqueueStory("unfiled-1")).rejects.toThrow(
      "Cannot queue an unfiled story — no issue attached"
    );
  });

  it("runs intake enqueue → next → complete round-trip", () => {
    const { store, intake } = makeManagers();

    const item = intake.enqueue({
      kind: "feature",
      title: "Add login",
      description: "Users need to sign in",
    });
    expect(item.status).toBe("pending");

    const claimed = intake.next();
    expect(claimed).not.toBeNull();
    expect(claimed!.id).toBe(item.id);
    expect(claimed!.status).toBe("claimed");

    expect(intake.next()).toBeNull();

    const draftStory = makeStory({
      id: "story-from-intake",
      draft: true,
      issue: null,
      column: "backlog",
    });
    const persisted = intake.complete(item.id, draftStory);
    expect(persisted.column).toBe("backlog");

    const doneItem = store.getIntake(item.id);
    expect(doneItem?.status).toBe("done");
    expect(doneItem?.storyId).toBe("story-from-intake");

    const saved = store.getStory("story-from-intake");
    expect(saved?.column).toBe("backlog");
    expect(saved?.draft).toBe(true);
  });

  it("rejects intake.complete for non-draft stories", () => {
    const { intake } = makeManagers();

    const item = intake.enqueue({
      kind: "bug",
      title: "Fix crash",
      description: "App crashes on load",
    });
    intake.next();

    const nonDraft = makeStory({ draft: false, issue: "#99" });
    expect(() => intake.complete(item.id, nonDraft)).toThrow(
      "intake.complete requires a draft story"
    );
  });
});

describe("intake deterministic draft (fallback)", () => {
  it("lists enqueued intake items", () => {
    const { intake } = makeManagers();
    intake.enqueue({ kind: "feature", title: "One", description: "d1" });
    intake.enqueue({ kind: "bug", title: "Two", description: "d2" });
    const items = intake.list();
    expect(items.map((i) => i.title)).toEqual(["One", "Two"]);
  });

  it("templates a pending item into a backlog draft with a generated wid", () => {
    const { store, intake } = makeManagers();
    const item = intake.enqueue({ kind: "feature", title: "Add Login Flow", description: "spec" });

    const story = intake.draft(item.id, "acme/api");
    expect(story.draft).toBe(true);
    expect(story.column).toBe("backlog");
    expect(story.repo).toBe("acme/api");
    expect(story.issue).toBeNull();
    expect(story.branch).toBe("draft/add-login-flow");
    expect(story.wid).toMatch(/^W-\d{6}$/);

    // intake item is now done and linked
    const done = store.getIntake(item.id);
    expect(done?.status).toBe("done");
    expect(done?.storyId).toBe(story.id);
    // persisted in backlog
    expect(store.getStory(story.id)?.column).toBe("backlog");
  });

  it("maps kind → type/taskClass and increments wid across drafts", () => {
    const { intake } = makeManagers();
    const a = intake.enqueue({ kind: "bug", title: "Crash on load", description: "b" });
    const b = intake.enqueue({ kind: "prd", title: "Billing epic", description: "p" });

    const bug = intake.draft(a.id, "acme/api");
    const slice = intake.draft(b.id, "acme/api");

    expect(bug.type).toBe("bug");
    expect(bug.taskClass).toBe("bugfix");
    expect(slice.type).toBe("slice");
    // monotonic, sequential wids
    expect(bug.wid).toBe("W-000001");
    expect(slice.wid).toBe("W-000002");
  });

  it("rejects drafting an unknown or already-drafted item", () => {
    const { intake } = makeManagers();
    expect(() => intake.draft("nope", "acme/api")).toThrow(/Unknown intake item/);
    const item = intake.enqueue({ kind: "feature", title: "X", description: "d" });
    intake.draft(item.id, "acme/api");
    expect(() => intake.draft(item.id, "acme/api")).toThrow(/already drafted/);
  });
});
