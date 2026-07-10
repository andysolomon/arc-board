import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import type { IntakeItem, QueueNextResult, Story } from "arc-contracts";
import { startDaemon, type DaemonHandle } from "../mcp-server/dist/server.js";

// Distinct port from the skeleton (7420) and board-live (7421) E2Es.
const TEST_PORT = 7422;

type ToolResult = { content: Array<{ type: string; text?: string }>; isError?: boolean };

function textOf(result: ToolResult): string {
  return result.content.find((c) => c.type === "text")?.text ?? "";
}

function parseToolResult<T>(result: ToolResult): T {
  const text = textOf(result);
  if (!text) throw new Error("No text content in tool result");
  return JSON.parse(text) as T;
}

/** Call a tool and normalize both throw- and isError-style failures into { blocked, message }. */
async function callGuarded(
  client: Client,
  name: string,
  args: Record<string, unknown>
): Promise<{ blocked: boolean; message: string; result?: ToolResult }> {
  try {
    const result = (await client.callTool({ name, arguments: args }, CallToolResultSchema)) as ToolResult;
    if (result.isError) return { blocked: true, message: textOf(result), result };
    return { blocked: false, message: textOf(result), result };
  } catch (err) {
    return { blocked: true, message: err instanceof Error ? err.message : String(err) };
  }
}

function makeDraftStory(repo: string, id = "story-pipeline-1"): Story {
  return {
    id,
    wid: "W-000777",
    type: "story",
    title: "Pipeline guardrail story",
    repo,
    branch: "feat/pipeline-guardrail",
    worktree: "",
    column: "backlog",
    priority: "high",
    size: "S",
    epic: "pipeline",
    taskClass: "feature",
    tags: [],
    description: "Drafted via intake, must be filed before queueing",
    criteria: ["guardrail blocks unfiled drafts", "filing unblocks queueing"],
    draft: true,
    issue: null,
    orchestration: {
      status: "planned",
      route: "codex-implement",
      backend: "codex",
      mode: "implement",
      rationale: "The queued fixture has already been planned.",
      complexity: "low",
      plannedAt: "2026-07-10T00:00:00.000Z",
      storyDigest: "test",
    },
  };
}

describe("pipeline guardrails E2E (over MCP)", () => {
  let daemon: DaemonHandle;
  let client: Client;
  let transport: StreamableHTTPClientTransport;
  let fixtureDir: string;
  const repoId = "test/pipeline";

  beforeAll(async () => {
    fixtureDir = mkdtempSync(join(tmpdir(), "arc-sq-pipeline-"));
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
      worktreeRoot: join(fixtureDir, "wt"),
      maxParallel: 2,
    });

    transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${TEST_PORT}/mcp`));
    client = new Client({ name: "pipeline-e2e", version: "0.1.0" });
    await client.connect(transport);
  }, 60_000);

  afterAll(async () => {
    await client.close();
    await daemon.close();
    if (fixtureDir && existsSync(fixtureDir)) rmSync(fixtureDir, { recursive: true, force: true });
  }, 60_000);

  it("drives intake → file → enqueue → next, enforcing the draft guardrail over the wire", async () => {
    // Attach a session as a project.
    const reg = await callGuarded(client, "session.register", {
      repo: repoId,
      path: fixtureDir,
      branch: "main",
      model: "claude-test",
      pid: process.pid,
    });
    const session = parseToolResult<{ id: string }>(reg.result!);
    const attach = await callGuarded(client, "project.attach", { sessionId: session.id });
    const project = parseToolResult<{ id: string }>(attach.result!);
    expect(project.id).toBeTruthy();

    // 1. Intake pull queue: enqueue → next (claimed) → drained.
    const enq = await callGuarded(client, "intake.enqueue", {
      kind: "feature",
      title: "Add pipeline guardrail",
      description: "Drafts must be filed before queueing",
    });
    const item = parseToolResult<IntakeItem>(enq.result!);
    expect(item.status).toBe("pending");

    const nextItem = parseToolResult<IntakeItem | null>(
      (await callGuarded(client, "intake.next", {})).result!
    );
    expect(nextItem?.id).toBe(item.id);
    expect(nextItem?.status).toBe("claimed");

    const drained = parseToolResult<IntakeItem | null>(
      (await callGuarded(client, "intake.next", {})).result!
    );
    expect(drained).toBeNull();

    // 2. Fable drafts a Story and completes intake → lands in backlog as a draft.
    const draft = makeDraftStory(repoId);
    const completed = parseToolResult<Story>(
      (await callGuarded(client, "intake.complete", { id: item.id, story: draft })).result!
    );
    expect(completed.column).toBe("backlog");
    expect(completed.draft).toBe(true);

    // stories.list surfaces the draft in backlog for the attached project.
    const listed = parseToolResult<Story[]>(
      (await callGuarded(client, "stories.list", { projectId: project.id })).result!
    );
    const draftInList = listed.find((s) => s.id === draft.id);
    expect(draftInList).toBeTruthy();
    expect(draftInList!.draft).toBe(true);
    expect(draftInList!.column).toBe("backlog");

    // 3. GUARDRAIL: enqueue must be rejected while the story is still a draft.
    const blockedEnqueue = await callGuarded(client, "story.enqueue", { id: draft.id });
    expect(blockedEnqueue.blocked).toBe(true);
    expect(blockedEnqueue.message).toMatch(/draft/i);

    // The rejected story must not have leaked into the queue.
    const stillBacklog = parseToolResult<Story | null>(
      (await callGuarded(client, "story.get", { id: draft.id })).result!
    );
    expect(stillBacklog?.column).toBe("backlog");

    // 4. File it (Fable created the GitHub issue) → clears draft, sets issue.
    const filed = parseToolResult<Story>(
      (await callGuarded(client, "story.file", { id: draft.id, issue: "#215" })).result!
    );
    expect(filed.draft).toBe(false);
    expect(filed.issue).toBe("#215");

    // 5. Now enqueue succeeds → column queued.
    const enqueued = await callGuarded(client, "story.enqueue", { id: draft.id });
    expect(enqueued.blocked).toBe(false);
    const queuedStory = parseToolResult<Story>(enqueued.result!);
    expect(queuedStory.column).toBe("queued");

    // 6. queue.next picks it up → worktree opened, in_progress, write-lock held.
    const inProgress = parseToolResult<QueueNextResult>(
      (await callGuarded(client, "queue.next", { projectId: project.id })).result!
    ).story;
    expect(inProgress?.column).toBe("in_progress");
    expect(existsSync(inProgress!.worktree)).toBe(true);
    expect(daemon.queue.isWriteLocked(inProgress!.worktree)).toBe(true);
    expect(daemon.queue.writeLockHolder(inProgress!.worktree)).toBe(draft.id);
  }, 60_000);
});
