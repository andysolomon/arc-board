import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { QueueManager } from "../mcp-server/dist/queue.js";
import { SessionRegistry } from "../mcp-server/dist/registry.js";
import { SseHub } from "../mcp-server/dist/sse.js";
import { StoryStore } from "../mcp-server/dist/store.js";
import type { Handoff, RunRecord, Story } from "arc-contracts";

let widSeq = 1;
function makeStory(overrides: Partial<Story> = {}): Story {
  const n = widSeq++;
  return {
    id: `story-${n}`,
    wid: `W-${String(n).padStart(6, "0")}`,
    type: "story",
    title: `Story ${n}`,
    repo: "test/repo",
    branch: `feat/story-${n}`,
    worktree: "",
    column: "backlog",
    priority: "med",
    size: "S",
    epic: "",
    taskClass: "feature",
    tags: [],
    description: "A story",
    criteria: [],
    draft: false,
    issue: `#${n}`,
    ...overrides,
  };
}

function makeRun(overrides: Partial<RunRecord> = {}): RunRecord {
  return {
    id: `run-${Math.floor(Math.random() * 1e9)}`,
    storyId: "story-x",
    label: "composer-implement",
    repo: "test/repo",
    route: "composer-implement",
    backend: "Cursor Agent",
    model: "composer-2.5",
    access: "write",
    tokens: 100,
    durMs: 500,
    status: "completed",
    changed: 1,
    outcome: "accepted",
    ...overrides,
  };
}

const handoff: Handoff = {
  status: "completed",
  summary: "done",
  changes: ["a.ts"],
  verification: ["vitest"],
  risks: [],
  next_actions: [],
};

const tmpDirs: string[] = [];
function makeManagers(dbPath = ":memory:") {
  const store = new StoryStore(dbPath);
  const registry = new SessionRegistry();
  const sse = new SseHub();
  const queue = new QueueManager({ worktreeRoot: "/tmp/wt", maxParallel: 2 }, { store, registry, sse });
  return { store, registry, sse, queue };
}

function attachProject(registry: SessionRegistry, repo: string): string {
  const session = registry.register({ repo, path: "/tmp/repo", branch: "main", model: "m", pid: 1 });
  const project = registry.attach(session.id, "/tmp/wt");
  return project.id;
}

afterEach(() => {
  while (tmpDirs.length) rmSync(tmpDirs.pop()!, { recursive: true, force: true });
});

describe("view read surface", () => {
  it("queue.list returns filed stories in insertion order", async () => {
    const { store, queue } = makeManagers();
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      const s = makeStory({ draft: false, issue: `#${100 + i}` });
      store.upsertStory(s);
      await queue.enqueueStory(s.id);
      ids.push(s.id);
    }
    expect(queue.listQueue().map((s) => s.id)).toEqual(ids);
  });

  it("queue.reorder swaps neighbors and persists", async () => {
    const { store, queue } = makeManagers();
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      const s = makeStory({ draft: false, issue: `#${200 + i}` });
      store.upsertStory(s);
      await queue.enqueueStory(s.id);
      ids.push(s.id);
    }
    // move the last one up: [a,b,c] -> [a,c,b]
    const after = queue.reorder(ids[2], "up");
    expect(after.map((s) => s.id)).toEqual([ids[0], ids[2], ids[1]]);
    // persisted: re-read
    expect(queue.listQueue().map((s) => s.id)).toEqual([ids[0], ids[2], ids[1]]);
    // move the first one down: [a,c,b] -> [c,a,b]
    queue.reorder(ids[0], "down");
    expect(queue.listQueue().map((s) => s.id)).toEqual([ids[2], ids[0], ids[1]]);
    // no-op at the edge
    expect(queue.reorder(ids[2], "up").map((s) => s.id)).toEqual([ids[2], ids[0], ids[1]]);
  });

  it("reorder throws for a story not in the queue", () => {
    const { queue } = makeManagers();
    expect(() => queue.reorder("nope", "up")).toThrow(/not in queue/i);
  });

  it("setOrder applies an arbitrary order and is robust to a partial list", async () => {
    const { store, queue } = makeManagers();
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      const s = makeStory({ draft: false, issue: `#${300 + i}` });
      store.upsertStory(s);
      await queue.enqueueStory(s.id);
      ids.push(s.id);
    }
    // full reorder: reverse
    expect(queue.setOrder([ids[2], ids[1], ids[0]]).map((s) => s.id)).toEqual([
      ids[2],
      ids[1],
      ids[0],
    ]);
    // partial: move ids[0] to front; the omitted ids keep their relative order after it
    const after = queue.setOrder([ids[0]]).map((s) => s.id);
    expect(after[0]).toBe(ids[0]);
    expect(after.slice(1).sort()).toEqual([ids[1], ids[2]].sort());
    expect(after).toHaveLength(3); // nothing dropped
  });

  it("unqueue removes a story from the queue back to backlog", async () => {
    const { store, queue } = makeManagers();
    const s = makeStory({ id: "uq-1", draft: false, issue: "#900" });
    store.upsertStory(s);
    await queue.enqueueStory("uq-1");
    expect(store.queueIds()).toContain("uq-1");

    const back = queue.unqueue("uq-1");
    expect(back.column).toBe("backlog");
    expect(store.queueIds()).not.toContain("uq-1");
  });

  it("runs.list returns all, and filters by project repo", () => {
    const { store, registry, queue } = makeManagers();
    store.saveRun(makeRun({ id: "r1", storyId: "s1", repo: "acme/api" }));
    store.saveRun(makeRun({ id: "r2", storyId: "s2", repo: "acme/web" }));
    expect(queue.listRuns().map((r) => r.id).sort()).toEqual(["r1", "r2"]);
    const projectId = attachProject(registry, "acme/api");
    expect(queue.listRuns(projectId).map((r) => r.id)).toEqual(["r1"]);
  });

  it("complete persists the handoff; detail hydrates story + runs + handoff", async () => {
    const { store, queue } = makeManagers();
    const s = makeStory({ id: "done-1" });
    store.upsertStory(s);
    await queue.complete({
      id: "done-1",
      handoff,
      pr: "https://example/pr/1",
      runs: [makeRun({ id: "r-done", storyId: "done-1" })],
      outcome: "accepted",
    });
    const detail = queue.detail("done-1");
    expect(detail.story.id).toBe("done-1");
    expect(detail.story.column).toBe("review");
    expect(detail.runs.map((r) => r.id)).toEqual(["r-done"]);
    expect(detail.handoff).toEqual(handoff);
  });

  it("detail returns handoff null for a never-completed story", () => {
    const { store, queue } = makeManagers();
    const s = makeStory({ id: "open-1" });
    store.upsertStory(s);
    const detail = queue.detail("open-1");
    expect(detail.handoff).toBeNull();
    expect(detail.runs).toEqual([]);
  });

  it("config defaults, merges, and persists across store instances", () => {
    const dir = mkdtempSync(join(tmpdir(), "arc-cfg-"));
    tmpDirs.push(dir);
    const dbPath = join(dir, "cfg.db");

    const a = makeManagers(dbPath);
    expect(a.queue.getConfig()).toEqual({ autoRun: false, maxParallel: 2, requireOrchestrationPlan: true });
    const merged = a.queue.setConfig({ maxParallel: 4, autoRun: true });
    expect(merged).toEqual({ autoRun: true, maxParallel: 4, requireOrchestrationPlan: true });
    a.store.close();

    // fresh store on the same db path reads back persisted config
    const b = makeManagers(dbPath);
    expect(b.queue.getConfig()).toEqual({ autoRun: true, maxParallel: 4, requireOrchestrationPlan: true });
    b.store.close();
  });
});

describe("GitHub filing flow", () => {
  it("requestFile flags a draft; filePending lists it; file clears it", async () => {
    const { store, queue } = makeManagers();
    const draft = makeStory({ id: "d1", draft: true, issue: null, column: "backlog" });
    store.upsertStory(draft);

    const req = await queue.requestFile("d1");
    expect(req.fileRequested).toBe(true);
    expect(queue.filePending().map((s) => s.id)).toContain("d1");

    const filed = await queue.file("d1", "#215");
    expect(filed.draft).toBe(false);
    expect(filed.fileRequested).toBe(false);
    expect(filed.issue).toBe("#215");
    expect(queue.filePending().map((s) => s.id)).not.toContain("d1");
  });

  it("requestFile rejects a non-draft story", async () => {
    const { store, queue } = makeManagers();
    store.upsertStory(makeStory({ id: "nd", draft: false, issue: "#9" }));
    await expect(queue.requestFile("nd")).rejects.toThrow(/Only drafts/);
  });
});
