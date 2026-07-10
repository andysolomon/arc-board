import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { CallToolResultSchema, LoggingMessageNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import type { QueueNextResult, Story } from "arc-contracts";
import { claudeArgs, claudeEventLine, claudeWorkerEnv, runArcWorker } from "../mcp-server/dist/arc-worker.js";
import { startDaemon, type DaemonHandle } from "../mcp-server/dist/server.js";

const TEST_PORT = 7432;
const repoId = "local/arc-worker";

type ToolResult = { content: Array<{ type: string; text?: string }> };

function parseToolResult<T>(result: ToolResult): T {
  const text = result.content.find((c) => c.type === "text")?.text;
  if (!text) throw new Error("No text content in tool result");
  return JSON.parse(text) as T;
}

function makeStory(): Story {
  return {
    id: "story-arc-worker-1",
    wid: "W-000037",
    type: "story",
    title: "Headless auto-worker acceptance story",
    repo: repoId,
    branch: "feat/headless-auto-worker-fixture",
    worktree: "",
    column: "queued",
    priority: "high",
    size: "M",
    epic: "Pipeline Execution",
    taskClass: "feature",
    tags: ["worker"],
    description: "A started event should make the headless worker implement without a human prompt.",
    criteria: ["react to started events", "stream progress", "move to review"],
    draft: false,
    issue: "#37",
    orchestration: {
      status: "planned", route: "codex-implement", backend: "codex", mode: "implement",
      rationale: "Test fixture is ready to dispatch.", complexity: "low",
      plannedAt: "2026-07-10T00:00:00.000Z", storyDigest: "test",
    },
  };
}

async function waitFor(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("Timed out waiting for condition");
}

describe("Claude Code CLI executor helpers", () => {
  it("uses subscription-safe auth and headless streaming flags", () => {
    const env = claudeWorkerEnv({ ANTHROPIC_API_KEY: "api-key", CLAUDE_CODE_OAUTH_TOKEN: "oauth" });
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe("oauth");

    const args = claudeArgs("prompt", "/tmp/story-queue.mcp.json", "Read,Write");
    expect(args).toEqual(expect.arrayContaining(["-p", "prompt", "--mcp-config", "/tmp/story-queue.mcp.json", "--output-format", "stream-json", "--verbose", "--permission-mode", "acceptEdits"]));
    expect(args).not.toContain("--bare");
  });

  it("maps Claude stream-json events into board lane lines", () => {
    expect(claudeEventLine({ type: "tool_use", name: "Bash", input: { command: "npm test" } })).toMatchObject({ kind: "cmd" });
    expect(claudeEventLine({ type: "tool_result", content: "ok" })).toEqual({ kind: "out", text: "ok" });
    expect(claudeEventLine({ type: "system", subtype: "api_retry", error: "rate_limit" })?.text).toContain("retrying");
  });
});

describe("arc-worker headless event loop", () => {
  let daemon: DaemonHandle;
  let client: Client;
  let transport: StreamableHTTPClientTransport;
  let fixtureDir: string;
  const updates: Array<{ type?: string; id: string; route: string; line?: { kind: string; text: string } }> = [];

  beforeAll(async () => {
    fixtureDir = mkdtempSync(join(tmpdir(), "arc-sq-arc-worker-"));
    execFileSync("git", ["init"], { cwd: fixtureDir });
    execFileSync("git", ["branch", "-M", "main"], { cwd: fixtureDir });
    execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: fixtureDir });
    execFileSync("git", ["config", "user.name", "Test"], { cwd: fixtureDir });
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

    transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${TEST_PORT}/mcp`));
    client = new Client({ name: "arc-worker-test", version: "0.1.0" });
    client.setNotificationHandler(LoggingMessageNotificationSchema, (notification) => {
      const raw = notification.params?.data;
      if (typeof raw !== "string") return;
      try {
        const parsed = JSON.parse(raw) as { type?: string; id: string; route: string; line?: { kind: string; text: string } };
        if (parsed.type === "story.update") updates.push(parsed);
      } catch {
        // ignore unrelated log payloads
      }
    });
    await client.connect(transport);
  }, 60_000);

  afterAll(async () => {
    await client.close();
    await daemon.close();
    if (fixtureDir && existsSync(fixtureDir)) rmSync(fixtureDir, { recursive: true, force: true });
  }, 60_000);

  it("reacts to the board's started event, implements in the worktree, and moves the card to Review", async () => {
    const reg = await client.callTool(
      {
        name: "session.register",
        arguments: { repo: repoId, path: fixtureDir, branch: "main", model: "test", pid: process.pid },
      },
      CallToolResultSchema
    );
    const session = parseToolResult<{ id: string }>(reg as ToolResult);
    const attach = await client.callTool(
      { name: "project.attach", arguments: { sessionId: session.id } },
      CallToolResultSchema
    );
    const project = parseToolResult<{ id: string }>(attach as ToolResult);

    const story = makeStory();
    daemon.store.upsertStory(story);
    daemon.store.enqueue(story.id);

    const logs: string[] = [];
    const worker = runArcWorker({
      url: `http://127.0.0.1:${TEST_PORT}/mcp`,
      projectId: project.id,
      executor: "dry-run",
      once: true,
      log: (message) => logs.push(message),
    });
    await waitFor(() => logs.some((line) => line.includes("attached")));

    const next = await client.callTool(
      { name: "queue.next", arguments: { projectId: project.id } },
      CallToolResultSchema
    );
    const reserved = parseToolResult<QueueNextResult>(next as ToolResult).story;
    expect(reserved?.column).toBe("in_progress");

    const result = await worker;
    expect(result.processed).toBe(1);
    expect(result.stories[0]).toMatchObject({ id: story.id, wid: "W-000037" });

    await new Promise((resolve) => setTimeout(resolve, 300));
    const storyLines = updates.filter((u) => u.id === story.id).map((u) => u.line?.text ?? "");
    expect(storyLines.some((line) => line.includes("arc-worker picked up W-000037"))).toBe(true);
    expect(storyLines.some((line) => line.includes("dry-run executor writing proof artifact"))).toBe(true);
    expect(storyLines.some((line) => line.includes("review ready"))).toBe(true);

    const reviewed = daemon.store.getStory(story.id);
    expect(reviewed?.column).toBe("review");
    expect(reviewed?.pr).toBe("local://arc-story-queue/W-000037");
    expect(daemon.queue.isWriteLocked(reserved.worktree)).toBe(false);

    const lastCommit = execFileSync("git", ["log", "-1", "--pretty=%s"], {
      cwd: reserved.worktree,
      encoding: "utf8",
    }).trim();
    expect(lastCommit).toBe("feat: implement W-000037");
  }, 60_000);
});
