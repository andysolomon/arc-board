import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import type { Story } from "arc-contracts";
import { BoardStore } from "../src/lib/boardStore";
import { startDaemon, type DaemonHandle } from "../../mcp-server/dist/server.js";

const TEST_PORT = 7427;
const repoId = "test/board-events";

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
    epic: "events",
    taskClass: "feature",
    tags: [],
    description: "d",
    criteria: [],
    draft: false,
    issue: `#${id}`,
  };
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("daemon lifecycle SSE → board activity", () => {
  let daemon: DaemonHandle;
  let store: BoardStore;
  let other: Client;
  let otherTransport: StreamableHTTPClientTransport;
  let fixtureDir: string;

  beforeAll(async () => {
    fixtureDir = mkdtempSync(join(tmpdir(), "arc-board-events-"));
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

    otherTransport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${TEST_PORT}/mcp`));
    other = new Client({ name: "other-session", version: "0.1.0" });
    await other.connect(otherTransport);

    daemon.store.upsertStory(filed("A", "W-000001"));
    daemon.store.upsertStory(filed("B", "W-000002"));
  }, 60_000);

  afterAll(async () => {
    await store.close();
    await other.close();
    await daemon.close();
    if (fixtureDir && existsSync(fixtureDir)) rmSync(fixtureDir, { recursive: true, force: true });
  }, 60_000);

  it("notifies the board when it enqueues a story (own action, via SSE)", async () => {
    await store.enqueueStory("A");
    await wait(300);
    const msgs = store.getNotifications().map((n) => n.message);
    expect(msgs.some((m) => m.includes("Queued") && m.includes("W-000001"))).toBe(true);
    expect(store.getActivityItems()[0]).toMatchObject({
      icon: "➕",
      subject: "Queue",
      tone: "queued",
    });
    expect(store.getActivityItems()[0].text).toContain("W-000001");
  });

  it("notifies the board when ANOTHER session enqueues a story (cross-client)", async () => {
    await other.callTool({ name: "story.enqueue", arguments: { id: "B" } }, CallToolResultSchema);
    await wait(300);
    const msgs = store.getNotifications().map((n) => n.message);
    expect(msgs.some((m) => m.includes("Queued") && m.includes("W-000002"))).toBe(true);
    expect(store.getActivityItems()[0].text).toContain("W-000002");
    // cross-client refresh: the board's queue now reflects B without a manual refresh
    expect(store.queueStories().some((s) => s.id === "B")).toBe(true);
  });
});
