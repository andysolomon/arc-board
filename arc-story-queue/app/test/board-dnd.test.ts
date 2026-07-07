import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Story } from "arc-contracts";
import { BoardStore } from "../src/lib/boardStore";
import { startDaemon, type DaemonHandle } from "../../mcp-server/dist/server.js";

const TEST_PORT = 7426;
const repoId = "test/board-dnd";

function filed(id: string, wid: string): Story {
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
    epic: "dnd",
    taskClass: "feature",
    tags: [],
    description: "d",
    criteria: [],
    draft: false,
    issue: `#${id}`,
  };
}

describe("board drag-and-drop seam", () => {
  let daemon: DaemonHandle;
  let store: BoardStore;
  let fixtureDir: string;

  beforeAll(async () => {
    fixtureDir = mkdtempSync(join(tmpdir(), "arc-board-dnd-"));
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

    for (const [id, wid] of [
      ["x", "W-000001"],
      ["y", "W-000002"],
      ["z", "W-000003"],
    ] as const) {
      daemon.store.upsertStory(filed(id, wid));
      await daemon.queue.enqueueStory(id);
    }
    await store.refreshViews();
  }, 60_000);

  afterAll(async () => {
    await store.close();
    await daemon.close();
    if (fixtureDir && existsSync(fixtureDir)) rmSync(fixtureDir, { recursive: true, force: true });
  }, 60_000);

  it("reorderQueueTo applies an arbitrary drag order", async () => {
    expect(store.queueStories().map((s) => s.id)).toEqual(["x", "y", "z"]);
    await store.reorderQueueTo(["z", "x", "y"]);
    expect(store.queueStories().map((s) => s.id)).toEqual(["z", "x", "y"]);
  });

  it("unqueueStory pulls a story back to backlog and out of the queue", async () => {
    await store.unqueueStory("x");
    expect(store.queueStories().map((s) => s.id)).not.toContain("x");
    expect(store.storiesByColumn("backlog").some((s) => s.id === "x")).toBe(true);
  });
});
