import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { CallToolResultSchema, LoggingMessageNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import type { Handoff, QueueNextResult, RunRecord, Story } from "arc-contracts";
import { startDaemon, type DaemonHandle } from "../mcp-server/dist/server.js";

const TEST_PORT = 7424;

function parseToolResult<T>(result: { content: Array<{ type: string; text?: string }> }): T {
  const text = result.content.find((c) => c.type === "text")?.text;
  if (!text) throw new Error("No text content in tool result");
  return JSON.parse(text) as T;
}

function makeStory(repo: string, id = "story-e2e-1"): Story {
  return {
    id,
    wid: "W-000001",
    type: "story",
    title: "E2E skeleton story",
    repo,
    branch: "feat/e2e-skeleton",
    worktree: "",
    column: "queued",
    priority: "high",
    size: "S",
    epic: "e2e",
    taskClass: "feature",
    tags: [],
    description: "Walking skeleton acceptance story",
    criteria: ["worktree opens", "SSE streams updates"],
    draft: false,
    issue: "#1",
    orchestration: {
      status: "planned", route: "codex-implement", backend: "codex", mode: "implement",
      rationale: "Test fixture is ready to dispatch.", complexity: "low",
      plannedAt: "2026-07-10T00:00:00.000Z", storyDigest: "test",
    },
  };
}

describe("walking skeleton E2E", () => {
  let daemon: DaemonHandle;
  let client: Client;
  let transport: StreamableHTTPClientTransport;
  let fixtureDir: string;
  let worktreeRoot: string;
  const sseUpdates: Array<{ id: string; line?: { text: string } }> = [];
  const lifecycleEvents: Array<{ kind: string; id: string; column?: string }> = [];

  beforeAll(async () => {
    fixtureDir = mkdtempSync(join(tmpdir(), "arc-sq-fixture-"));
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

    transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${TEST_PORT}/mcp`));
    client = new Client({ name: "e2e-test", version: "0.1.0" });
    client.setNotificationHandler(LoggingMessageNotificationSchema, (notification) => {
      const raw = notification.params?.data;
      if (typeof raw !== "string") return;
      try {
        const parsed = JSON.parse(raw) as { type?: string; kind?: string; id: string; column?: string; line?: { text: string } };
        if (parsed.type === "story.update") sseUpdates.push(parsed);
        if (parsed.type === "story.event" && parsed.kind) lifecycleEvents.push(parsed);
      } catch {
        // ignore non-JSON log lines
      }
    });
    await client.connect(transport);
  }, 60_000);

  afterAll(async () => {
    await client?.close();
    await daemon?.close();
    if (fixtureDir && existsSync(fixtureDir)) {
      rmSync(fixtureDir, { recursive: true, force: true });
    }
  }, 60_000);

  it("runs the full queue lifecycle over MCP HTTP+SSE", async () => {
    const repoId = "test/fixture";

    const reg = await client.callTool(
      {
        name: "session.register",
        arguments: {
          repo: repoId,
          path: fixtureDir,
          branch: "main",
          model: "claude-test",
          pid: process.pid,
        },
      },
      CallToolResultSchema
    );
    const session = parseToolResult<{ id: string }>(reg);
    expect(session.id).toBeTruthy();

    const attach = await client.callTool(
      { name: "project.attach", arguments: { sessionId: session.id } },
      CallToolResultSchema
    );
    const project = parseToolResult<{ id: string }>(attach);
    expect(project.id).toBeTruthy();

    const story = makeStory(repoId);
    daemon.store.upsertStory(story);
    daemon.store.enqueue(story.id);

    const next = await client.callTool(
      { name: "queue.next", arguments: { projectId: project.id } },
      CallToolResultSchema
    );
    const inProgress = parseToolResult<QueueNextResult>(next).story;
    expect(inProgress).not.toBeNull();
    expect(inProgress!.column).toBe("in_progress");
    expect(existsSync(inProgress!.worktree)).toBe(true);
    expect(daemon.queue.isWriteLocked(inProgress!.worktree)).toBe(true);
    expect(daemon.queue.writeLockHolder(inProgress!.worktree)).toBe(story.id);

    await new Promise((r) => setTimeout(r, 100));
    expect(lifecycleEvents).toContainEqual(expect.objectContaining({ kind: "started", id: story.id, column: "in_progress" }));

    const lines = ["line one", "line two", "line three"];
    for (const text of lines) {
      await client.callTool(
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
    const received = sseUpdates.filter((u) => u.id === story.id).map((u) => u.line?.text);
    for (const text of lines) {
      expect(received).toContain(text);
    }

    const handoff: Handoff = {
      status: "completed",
      summary: "E2E skeleton complete",
      changes: ["mcp-server/server.ts"],
      verification: ["vitest e2e.skeleton.test.ts"],
      risks: [],
      next_actions: [],
    };
    const runs: RunRecord[] = [
      {
        id: "run-e2e-1",
        storyId: story.id,
        label: "composer-implement",
        repo: repoId,
        route: "composer-implement",
        backend: "Cursor Agent",
        model: "composer-2.5",
        access: "write",
        tokens: 100,
        durMs: 500,
        status: "completed",
        changed: 1,
        outcome: "unrated",
      },
    ];

    await client.callTool(
      {
        name: "story.complete",
        arguments: {
          id: story.id,
          handoff,
          pr: "https://github.com/example/repo/pull/1",
          runs,
          outcome: "accepted",
        },
      },
      CallToolResultSchema
    );

    await new Promise((r) => setTimeout(r, 100));
    expect(lifecycleEvents).toContainEqual(expect.objectContaining({ kind: "review", id: story.id, column: "review" }));

    const done = await daemon.store.getStory(story.id);
    expect(done?.column).toBe("review");
    expect(done?.pr).toBe("https://github.com/example/repo/pull/1");
    expect(daemon.store.getRunsForStory(story.id)).toHaveLength(1);
    expect(daemon.queue.isWriteLocked(inProgress!.worktree)).toBe(false);
  }, 60_000);
});
