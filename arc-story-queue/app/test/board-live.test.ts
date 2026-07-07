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

const TEST_PORT = 7421;

function makeStory(repo: string, id = "story-live-1"): Story {
  return {
    id,
    wid: "W-000042",
    type: "story",
    title: "Board live seam story",
    repo,
    branch: "feat/board-live",
    worktree: "",
    column: "queued",
    priority: "high",
    size: "S",
    epic: "board",
    taskClass: "feature",
    tags: ["live"],
    description: "Proves SSE updates reach board store",
    criteria: ["lines arrive in order"],
    draft: false,
    issue: "#42",
  };
}

describe("board live seam", () => {
  let daemon: DaemonHandle;
  let store: BoardStore;
  let toolClient: Client;
  let toolTransport: StreamableHTTPClientTransport;
  let fixtureDir: string;
  let worktreeRoot: string;

  beforeAll(async () => {
    fixtureDir = mkdtempSync(join(tmpdir(), "arc-board-live-"));
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

    toolTransport = new StreamableHTTPClientTransport(
      new URL(`http://127.0.0.1:${TEST_PORT}/mcp`)
    );
    toolClient = new Client({ name: "board-live-tools", version: "0.1.0" });
    await toolClient.connect(toolTransport);
  }, 60_000);

  afterAll(async () => {
    await store.close();
    await toolClient.close();
    await daemon.close();
    if (fixtureDir && existsSync(fixtureDir)) {
      rmSync(fixtureDir, { recursive: true, force: true });
    }
  }, 60_000);

  it("reflects in_progress column and ordered story.update lines", async () => {
    const repoId = "test/board-live";

    await store.registerAndAttach({
      repo: repoId,
      path: fixtureDir,
      branch: "main",
      model: "vitest",
      pid: process.pid,
    });

    const story = makeStory(repoId);
    daemon.store.upsertStory(story);
    daemon.store.enqueue(story.id);
    store.trackStory(story.id);
    await store.refreshStory(story.id);

    const next = await store.queueNext();
    expect(next).not.toBeNull();
    expect(next!.column).toBe("in_progress");

    let state = store.getState();
    const inColumn = store.storiesByColumn("in_progress");
    expect(inColumn.some((s) => s.id === story.id)).toBe(true);

    const lines = ["alpha line", "beta line", "gamma line"];
    for (const text of lines) {
      await toolClient.callTool(
        {
          name: "story.update",
          arguments: {
            id: story.id,
            route: "composer-implement",
            line: { kind: "out", text },
          },
        },
        CallToolResultSchema
      );
    }

    await new Promise((r) => setTimeout(r, 300));

    state = store.getState();
    const boardStory = state.stories[story.id];
    expect(boardStory).toBeDefined();
    expect(boardStory.column).toBe("in_progress");
    expect(boardStory.lines.map((l) => l.text)).toEqual(lines);
  }, 60_000);
});
