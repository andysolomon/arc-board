import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { CallToolResultSchema, LoggingMessageNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import type { QueueNextResult, Story } from "arc-contracts";
import { startDaemon, type DaemonHandle } from "../mcp-server/dist/server.js";
import { runWorker } from "../mcp-server/dist/worker.js";

const TEST_PORT = 7426;

type ToolResult = { content: Array<{ type: string; text?: string }> };

function parseToolResult<T>(result: ToolResult): T {
  const text = result.content.find((c) => c.type === "text")?.text;
  if (!text) throw new Error("No text content in tool result");
  return JSON.parse(text) as T;
}

function makeStory(repo: string): Story {
  return {
    id: "story-worker-1",
    wid: "W-000006",
    type: "story",
    title: "Deterministic worker acceptance story",
    repo,
    branch: "feat/deterministic-worker",
    worktree: "",
    column: "queued",
    priority: "high",
    size: "L",
    epic: "Pipeline Execution",
    taskClass: "feature",
    tags: ["worker"],
    description: "A reserved story should be processed by the no-LLM worker.",
    criteria: ["stream updates", "persist a run record", "release the write lock"],
    draft: false,
    issue: "#6",
    orchestration: {
      status: "planned", route: "codex-implement", backend: "codex", mode: "implement",
      rationale: "Test fixture is ready to dispatch.", complexity: "low",
      plannedAt: "2026-07-10T00:00:00.000Z", storyDigest: "test",
    },
  };
}

describe("deterministic worker", () => {
  let daemon: DaemonHandle;
  let client: Client;
  let transport: StreamableHTTPClientTransport;
  let fixtureDir: string;
  let worktreeRoot: string;
  const repoId = "test/worker";
  const updates: Array<{
    id: string;
    route: string;
    line?: { kind: string; text: string };
    lane?: { route: string; status: string };
  }> = [];

  beforeAll(async () => {
    fixtureDir = mkdtempSync(join(tmpdir(), "arc-sq-worker-"));
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
    client = new Client({ name: "worker-observer", version: "0.1.0" });
    client.setNotificationHandler(LoggingMessageNotificationSchema, (notification) => {
      const raw = notification.params?.data;
      if (typeof raw !== "string") return;
      try {
        const parsed = JSON.parse(raw) as {
          type?: string;
          id: string;
          route: string;
          line?: { kind: string; text: string };
          lane?: { route: string; status: string };
        };
        if (parsed.type === "story.update") updates.push(parsed);
      } catch {
        // ignore unrelated log data
      }
    });
    await client.connect(transport);
  }, 60_000);

  afterAll(async () => {
    await client.close();
    await daemon.close();
    if (fixtureDir && existsSync(fixtureDir)) rmSync(fixtureDir, { recursive: true, force: true });
  }, 60_000);

  it("picks up a reserved in-progress story, streams deterministic work, records a run, and releases the lock", async () => {
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
    const session = parseToolResult<{ id: string }>(reg as ToolResult);
    const attach = await client.callTool(
      { name: "project.attach", arguments: { sessionId: session.id } },
      CallToolResultSchema
    );
    const project = parseToolResult<{ id: string }>(attach as ToolResult);

    const story = makeStory(repoId);
    daemon.store.upsertStory(story);
    daemon.store.enqueue(story.id);

    const next = await client.callTool(
      { name: "queue.next", arguments: { projectId: project.id } },
      CallToolResultSchema
    );
    const reserved = parseToolResult<QueueNextResult>(next as ToolResult).story;
    expect(reserved?.column).toBe("in_progress");
    expect(existsSync(reserved!.worktree)).toBe(true);
    expect(daemon.queue.isWriteLocked(reserved!.worktree)).toBe(true);

    const result = await runWorker({
      url: `http://127.0.0.1:${TEST_PORT}/mcp`,
      projectId: project.id,
      log: () => undefined,
    });
    expect(result.processed).toBe(1);
    expect(result.stories[0]).toMatchObject({ id: story.id, wid: "W-000006" });

    await new Promise((r) => setTimeout(r, 300));
    const storyUpdates = updates.filter((u) => u.id === story.id);
    const storyLines = storyUpdates.map((u) => u.line?.text ?? "");
    expect(storyUpdates.map((u) => u.route)).toEqual(
      expect.arrayContaining(["codex-explore", "composer-implement", "codex-check"])
    );
    expect(storyLines.some((line) => line.includes("git -C"))).toBe(true);
    expect(storyLines.some((line) => line.includes("wrote .arc-story-queue/runs/W-000006.md"))).toBe(true);
    expect(storyLines.some((line) => line.includes("committed 1 file(s)"))).toBe(true);
    expect(
      storyUpdates.some((u) => u.route === "composer-implement" && u.line?.text.includes("write-lock"))
    ).toBe(true);
    expect(storyUpdates.some((u) => u.route === "codex-explore" && u.lane?.status === "done")).toBe(true);
    expect(storyUpdates.some((u) => u.route === "codex-check" && u.lane?.status === "done")).toBe(true);

    const reviewed = daemon.store.getStory(story.id);
    expect(reviewed?.column).toBe("review");
    expect(reviewed?.pr).toBe("local://arc-story-queue/W-000006");
    expect(daemon.queue.isWriteLocked(reserved.worktree)).toBe(false);

    const runs = daemon.store.getRunsForStory(story.id);
    expect(runs).toHaveLength(3);
    expect(runs.map((run) => run.route)).toEqual(
      expect.arrayContaining(["codex-explore", "composer-implement", "codex-check"])
    );
    expect(runs.find((run) => run.route === "composer-implement")).toMatchObject({
      backend: "Deterministic Worker",
      model: "no-model",
      tokens: 0,
      route: "composer-implement",
      access: "write",
      status: "completed",
      changed: 1,
    });
    expect(runs.filter((run) => run.access === "read-only")).toHaveLength(2);

    const lastCommit = execFileSync("git", ["log", "-1", "--pretty=%s"], {
      cwd: reserved.worktree,
      encoding: "utf8",
    }).trim();
    expect(lastCommit).toBe("W-000006: deterministic worker run");
  }, 60_000);

  it("logs the awaiting-plan reason instead of generic queue unavailability", async () => {
    const story = makeStory(repoId);
    story.id = "story-worker-waiting";
    story.wid = "W-000007";
    story.branch = "feat/worker-waiting";
    story.orchestration = { status: "planning" };
    daemon.store.upsertStory(story);
    daemon.store.enqueue(story.id);
    const logs: string[] = [];

    const result = await runWorker({
      url: `http://127.0.0.1:${TEST_PORT}/mcp`,
      path: fixtureDir,
      repo: repoId,
      log: (message) => logs.push(message),
    });

    expect(result.processed).toBe(0);
    expect(logs).toContain("Queued stories are awaiting orchestration plans.");
  }, 60_000);
});
