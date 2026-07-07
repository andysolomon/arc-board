import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Handoff, RunRecord, Story } from "arc-contracts";
import { BoardStore } from "../src/lib/boardStore";
import { startDaemon, type DaemonHandle } from "../../mcp-server/dist/server.js";

const TEST_PORT = 7424;
const repoId = "test/board-views";

function makeFiled(id: string, wid: string): Story {
  return {
    id,
    wid,
    type: "story",
    title: `Story ${id}`,
    repo: repoId,
    branch: `feat/${id}`,
    worktree: "",
    column: "backlog",
    priority: "med",
    size: "S",
    epic: "views",
    taskClass: "feature",
    tags: [],
    description: "A filed story",
    criteria: ["works"],
    draft: false,
    issue: `#${id}`,
  };
}

const handoff: Handoff = {
  status: "completed",
  summary: "views done",
  changes: ["AppShell.tsx"],
  verification: ["vitest board-views"],
  risks: [],
  next_actions: [],
};

function makeRun(id: string, storyId: string): RunRecord {
  return {
    id,
    storyId,
    label: "composer-implement",
    repo: repoId,
    route: "composer-implement",
    backend: "Cursor Agent",
    model: "composer-2.5",
    access: "write",
    tokens: 1200,
    durMs: 800,
    status: "completed",
    changed: 3,
    outcome: "accepted",
  };
}

describe("board views seam", () => {
  let daemon: DaemonHandle;
  let store: BoardStore;
  let fixtureDir: string;

  beforeAll(async () => {
    fixtureDir = mkdtempSync(join(tmpdir(), "arc-board-views-"));
    execFileSync("git", ["init"], { cwd: fixtureDir });
    execFileSync("git", ["config", "user.email", "t@e.com"], { cwd: fixtureDir });
    execFileSync("git", ["config", "user.name", "T"], { cwd: fixtureDir });
    writeFileSync(join(fixtureDir, "README.md"), "# fixture\n");
    execFileSync("git", ["add", "."], { cwd: fixtureDir });
    execFileSync("git", ["commit", "-m", "init"], { cwd: fixtureDir });

    daemon = await startDaemon({
      port: TEST_PORT,
      host: "127.0.0.1",
      dbPath: join(fixtureDir, "test.db"),
      worktreeRoot: join(fixtureDir, "wt"),
      maxParallel: 2,
    });

    store = new BoardStore(`http://127.0.0.1:${TEST_PORT}/mcp`);
    await store.connect();
    await store.registerAndAttach({
      repo: repoId,
      path: fixtureDir,
      branch: "main",
      model: "vitest",
      pid: process.pid,
    });
  }, 60_000);

  afterAll(async () => {
    await store.close();
    await daemon.close();
    if (fixtureDir && existsSync(fixtureDir)) rmSync(fixtureDir, { recursive: true, force: true });
  }, 60_000);

  it("refreshViews loads the ordered queue; reorder swaps order", async () => {
    const a = makeFiled("a", "W-000001");
    const b = makeFiled("b", "W-000002");
    daemon.store.upsertStory(a);
    daemon.store.upsertStory(b);
    await daemon.queue.enqueueStory("a");
    await daemon.queue.enqueueStory("b");

    await store.refreshViews();
    expect(store.queueStories().map((s) => s.id)).toEqual(["a", "b"]);

    await store.reorderQueue("b", "up");
    expect(store.queueStories().map((s) => s.id)).toEqual(["b", "a"]);
  });

  it("updateConfig persists to the daemon", async () => {
    await store.updateConfig({ maxParallel: 5, autoRun: true });
    expect(store.getConfig()).toEqual({ autoRun: true, maxParallel: 5 });
    expect(daemon.store.getConfig()).toEqual({ autoRun: true, maxParallel: 5 });
  });

  it("openStory hydrates detail with runs + handoff after complete", async () => {
    const c = makeFiled("c", "W-000003");
    daemon.store.upsertStory(c);
    await daemon.queue.complete({
      id: "c",
      handoff,
      pr: "https://example/pr/9",
      runs: [makeRun("run-c", "c")],
      outcome: "accepted",
    });

    await store.refreshViews();
    expect(store.getRuns().some((r) => r.id === "run-c")).toBe(true);

    const detail = await store.openStory("c");
    expect(detail.story.column).toBe("review");
    expect(detail.runs.map((r) => r.id)).toEqual(["run-c"]);
    expect(detail.handoff).toEqual(handoff);
    // store reflects the open drawer
    expect(store.getDetail()?.story.id).toBe("c");
    store.closeStory();
    expect(store.getDetail()).toBeNull();
  });
});
