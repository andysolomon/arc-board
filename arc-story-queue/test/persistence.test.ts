import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { OrchestrationPlan, Story } from "arc-contracts";
import { startDaemon, type DaemonHandle } from "../mcp-server/dist/server.js";
import { StoryStore } from "../mcp-server/dist/store.js";

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
    daemon.queue.setConfig({ maxParallel: 5, autoRun: true, requireOrchestrationPlan: false });
    daemon.queue.linkGithubBoard({
      repo: "acme/api",
      githubProjectId: "PVT_persist",
      autoCreate: true,
    });
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
    expect(daemon.queue.getConfig()).toEqual({
      autoRun: true,
      maxParallel: 5,
      requireOrchestrationPlan: false,
      runTraceView: "v2-aware",
    });
    expect(daemon.queue.getGithubBoardBinding({ repo: "acme/api" })).toMatchObject({
      githubProjectId: "PVT_persist",
      autoCreate: true,
    });
    await daemon.close();
  }, 60_000);

  it("defaults orchestration when reading and rewriting a legacy SQLite story", () => {
    const legacyDbPath = join(dir, "legacy.db");
    const initializedStore = new StoryStore(legacyDbPath);
    initializedStore.close();

    const database = new DatabaseSync(legacyDbPath);
    const legacyStory = makeStory("legacy");
    database.prepare("INSERT INTO stories (id, data) VALUES (?, ?)").run(
      legacyStory.id,
      JSON.stringify(legacyStory)
    );
    database.close();

    const store = new StoryStore(legacyDbPath);
    const normalized = store.getStory(legacyStory.id);
    expect(normalized).toEqual({ ...legacyStory, orchestration: { status: "unplanned" } });
    store.upsertStory(normalized!);
    expect(store.getStory(legacyStory.id)).toEqual(normalized);
    store.close();
  });

  it("round-trips a fully populated orchestration plan through SQLite exactly", () => {
    const orchestration: OrchestrationPlan = {
      status: "planned",
      route: "opus-check",
      backend: "claude",
      mode: "review",
      rationale: "Use deep verification for this contract change.",
      complexity: "medium",
      plannedAt: "2026-07-10T12:00:00.000Z",
      storyDigest: "sha256:fully-populated",
      error: "Previously failed planning attempt was recovered.",
    };
    const story: Story = { ...makeStory("fully-populated"), orchestration };
    const store = new StoryStore(join(dir, "fully-populated.db"));

    store.upsertStory(story);
    expect(store.getStory(story.id)).toEqual(story);
    store.close();
  });
});
