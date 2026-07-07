import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Story } from "arc-contracts";
import { BoardStore } from "../src/lib/boardStore";
import { startDaemon, type DaemonHandle } from "../../mcp-server/dist/server.js";

const TEST_PORT = 7423;

function makeDraftStory(repo: string, id = "story-guardrail-draft"): Story {
  return {
    id,
    wid: "W-000101",
    type: "story",
    title: "Draft guardrail story",
    repo,
    branch: "feat/guardrail-draft",
    worktree: "",
    column: "backlog",
    priority: "med",
    size: "S",
    epic: "guardrail",
    taskClass: "feature",
    tags: ["draft"],
    description: "Draft awaiting filing",
    criteria: [],
    draft: true,
    issue: null,
  };
}

function makeFiledStory(repo: string, id = "story-guardrail-filed"): Story {
  return {
    id,
    wid: "W-000102",
    type: "story",
    title: "Filed guardrail story",
    repo,
    branch: "feat/guardrail-filed",
    worktree: "",
    column: "backlog",
    priority: "high",
    size: "M",
    epic: "guardrail",
    taskClass: "feature",
    tags: ["filed"],
    description: "Ready to enqueue",
    criteria: ["has issue"],
    draft: false,
    issue: "#7",
  };
}

describe("board guardrail seam", () => {
  let daemon: DaemonHandle;
  let store: BoardStore;
  let fixtureDir: string;
  let worktreeRoot: string;
  let repoId: string;

  beforeAll(async () => {
    fixtureDir = mkdtempSync(join(tmpdir(), "arc-board-guardrail-"));
    worktreeRoot = join(fixtureDir, "wt");
    execFileSync("git", ["init"], { cwd: fixtureDir });
    execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: fixtureDir });
    execFileSync("git", ["config", "user.name", "Test"], { cwd: fixtureDir });
    writeFileSync(join(fixtureDir, "README.md"), "# fixture\n");
    execFileSync("git", ["add", "."], { cwd: fixtureDir });
    execFileSync("git", ["commit", "-m", "init"], { cwd: fixtureDir });

    daemon = await startDaemon({
      port: TEST_PORT,
      host: "127.0.0.1",
      dbPath: join(fixtureDir, "test.db"),
      worktreeRoot,
      maxParallel: 2,
    });

    store = new BoardStore(`http://127.0.0.1:${TEST_PORT}/mcp`);
    await store.connect();

    repoId = "test/board-guardrail";
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
    if (fixtureDir && existsSync(fixtureDir)) {
      rmSync(fixtureDir, { recursive: true, force: true });
    }
  }, 60_000);

  it("hydrate surfaces drafts in backlog and enqueue rejects drafts", async () => {
    const draft = makeDraftStory(repoId);
    daemon.store.upsertStory(draft);

    await store.hydrate();

    const backlog = store.storiesByColumn("backlog");
    expect(backlog.some((s) => s.id === draft.id)).toBe(true);
    expect(backlog.find((s) => s.id === draft.id)?.draft).toBe(true);

    await expect(store.enqueueStory(draft.id)).rejects.toThrow(/draft/i);
  }, 60_000);

  it("enqueue moves a filed backlog story to queued", async () => {
    const filed = makeFiledStory(repoId);
    daemon.store.upsertStory(filed);

    await store.hydrate();

    const enqueued = await store.enqueueStory(filed.id);
    expect(enqueued.column).toBe("queued");

    const queued = store.storiesByColumn("queued");
    expect(queued.some((s) => s.id === filed.id)).toBe(true);
  }, 60_000);
});
