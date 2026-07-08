import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { RunRecord, Story } from "arc-contracts";
import { BoardStore } from "../src/lib/boardStore";
import { startDaemon, type DaemonHandle } from "../../mcp-server/dist/server.js";

const TEST_PORT = 7438;
const repoA = "test/multi-a";
const repoB = "test/multi-b";

function initRepo(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  execFileSync("git", ["init"], { cwd: dir });
  execFileSync("git", ["config", "user.email", "t@e.com"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "T"], { cwd: dir });
  writeFileSync(join(dir, "README.md"), "# fixture\n");
  execFileSync("git", ["add", "."], { cwd: dir });
  execFileSync("git", ["commit", "-m", "init"], { cwd: dir });
  return dir;
}

function story(id: string, repo: string, column: Story["column"] = "backlog"): Story {
  return {
    id,
    wid: id === "a" ? "W-000101" : "W-000102",
    type: "story",
    title: `Story ${id}`,
    repo,
    branch: `feat/${id}`,
    worktree: "",
    column,
    priority: "med",
    size: "S",
    epic: "multi",
    taskClass: "feature",
    tags: [],
    description: "A filed story",
    criteria: ["works"],
    draft: false,
    issue: `#${id}`,
  };
}

function run(id: string, storyId: string, repo: string): RunRecord {
  return {
    id,
    storyId,
    label: "composer-implement",
    repo,
    route: "composer-implement",
    backend: "Cursor Agent",
    model: "composer-2.5",
    access: "write",
    tokens: 100,
    durMs: 50,
    status: "completed",
    changed: 1,
    outcome: "accepted",
  };
}

describe("board multi-project scope", () => {
  let daemon: DaemonHandle;
  let store: BoardStore;
  let fixtureA: string;
  let fixtureB: string;

  beforeAll(async () => {
    fixtureA = initRepo("arc-board-multi-a-");
    fixtureB = initRepo("arc-board-multi-b-");
    daemon = await startDaemon({
      port: TEST_PORT,
      host: "127.0.0.1",
      dbPath: join(fixtureA, "test.db"),
      worktreeRoot: join(fixtureA, "wt"),
      maxParallel: 2,
    });

    store = new BoardStore(`http://127.0.0.1:${TEST_PORT}/mcp`);
    await store.connect();
    await store.registerAndAttach({ repo: repoA, path: fixtureA, branch: "main", model: "vitest", pid: process.pid });
    await store.registerAndAttach({ repo: repoB, path: fixtureB, branch: "main", model: "vitest", pid: process.pid });

    daemon.store.upsertStory(story("a", repoA, "queued"));
    daemon.store.upsertStory(story("b", repoB, "queued"));
    daemon.store.enqueue("a");
    daemon.store.enqueue("b");
    daemon.store.saveRun(run("run-a", "a", repoA));
    daemon.store.saveRun(run("run-b", "b", repoB));
  }, 60_000);

  afterAll(async () => {
    await store.close();
    await daemon.close();
    for (const dir of [fixtureA, fixtureB]) {
      if (dir && existsSync(dir)) rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);

  it("aggregates board, queue, and runs in all scope then scopes back to one project", async () => {
    expect(store.getState().projects.map((p) => p.repo).sort()).toEqual([repoA, repoB]);

    await store.selectProject("all");
    expect(store.getState().activeProjectId).toBe("all");
    expect(store.storiesByColumn("queued").map((s) => s.id).sort()).toEqual(["a", "b"]);
    expect(store.queueStories().map((s) => s.id)).toEqual(["a", "b"]);
    expect(store.getRuns().map((r) => r.id).sort()).toEqual(["run-a", "run-b"]);

    const projectA = store.getState().projects.find((p) => p.repo === repoA)!;
    await store.selectProject(projectA.id);
    expect(store.storiesByColumn("queued").map((s) => s.id)).toEqual(["a"]);
    expect(store.queueStories().map((s) => s.id)).toEqual(["a"]);
    expect(store.getRuns().map((r) => r.id)).toEqual(["run-a"]);
  }, 60_000);

  it("detaches a project without deleting daemon-side stories", async () => {
    const projectA = store.getState().projects.find((p) => p.repo === repoA)!;
    await store.detachProject(projectA.id);

    expect(store.getState().projects.map((p) => p.repo)).not.toContain(repoA);
    expect(daemon.store.getStory("a")?.repo).toBe(repoA);
    expect((await store.discover()).map((p) => p.repo)).toContain(repoA);
  }, 60_000);
});
