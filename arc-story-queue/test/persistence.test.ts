import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Story } from "arc-contracts";
import { startDaemon, type DaemonHandle } from "../mcp-server/dist/server.js";

function makeStory(id: string): Story {
  return {
    id,
    wid: "W-000001",
    type: "story",
    title: "Persisted story",
    repo: "acme/api",
    branch: "feat/persist",
    worktree: "",
    column: "backlog",
    priority: "med",
    size: "S",
    epic: "",
    taskClass: "feature",
    tags: [],
    description: "survives restart",
    criteria: [],
    draft: false,
    issue: "#1",
  };
}

describe("daemon persistence (file-backed SQLite)", () => {
  let dir: string;
  let dbPath: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "arc-persist-"));
    dbPath = join(dir, "store.db");
  });

  afterAll(() => {
    if (dir && existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  });

  it("keeps stories + queue + config across daemon restarts on the same db file", async () => {
    let daemon: DaemonHandle = await startDaemon({
      port: 7431,
      host: "127.0.0.1",
      dbPath,
      worktreeRoot: join(dir, "wt"),
      maxParallel: 2,
    });
    daemon.store.upsertStory(makeStory("p1"));
    daemon.store.enqueue("p1");
    daemon.queue.setConfig({ maxParallel: 5, autoRun: true });
    await daemon.close();

    // fresh daemon, same db file
    daemon = await startDaemon({
      port: 7431,
      host: "127.0.0.1",
      dbPath,
      worktreeRoot: join(dir, "wt"),
      maxParallel: 2,
    });
    expect(daemon.store.getStory("p1")?.title).toBe("Persisted story");
    expect(daemon.store.queueIds()).toContain("p1");
    expect(daemon.queue.getConfig()).toEqual({ autoRun: true, maxParallel: 5 });
    await daemon.close();
  }, 60_000);
});
