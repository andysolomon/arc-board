import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { LoggingMessageNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import type { Handoff, RunRecord, Story } from "arc-contracts";
import { startDaemon, type DaemonHandle } from "../mcp-server/dist/server.js";
import {
  completeFableStory,
  runFablePullLoop,
  streamFableUpdate,
} from "../mcp-server/dist/fable-pull-loop.js";

const TEST_PORT = 7430;
const repoId = "test/fable-loop";

function makeStory(): Story {
  return {
    id: "story-fable-1",
    wid: "W-000008",
    type: "story",
    title: "Fable pull-loop acceptance story",
    repo: repoId,
    branch: "feat/fable-pull-loop",
    worktree: "",
    column: "queued",
    priority: "high",
    size: "M",
    epic: "Pipeline Execution",
    taskClass: "feature",
    tags: ["fable"],
    description: "A live Fable session should reserve the next queued story.",
    criteria: ["register session", "attach project", "pull next story", "stream and complete"],
    draft: false,
    issue: "#8",
    orchestration: {
      status: "planned", route: "codex-implement", backend: "codex", mode: "implement",
      rationale: "Test fixture is ready to dispatch.", complexity: "low",
      plannedAt: "2026-07-10T00:00:00.000Z", storyDigest: "test",
    },
  };
}

describe("Fable pull-loop glue", () => {
  let daemon: DaemonHandle;
  let observer: Client;
  let observerTransport: StreamableHTTPClientTransport;
  let fixtureDir: string;
  const updates: Array<{ id: string; route: string; line?: { kind: string; text: string } }> = [];

  beforeAll(async () => {
    fixtureDir = mkdtempSync(join(tmpdir(), "arc-sq-fable-"));
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

    observerTransport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${TEST_PORT}/mcp`));
    observer = new Client({ name: "fable-observer", version: "0.1.0" });
    observer.setNotificationHandler(LoggingMessageNotificationSchema, (notification) => {
      const raw = notification.params?.data;
      if (typeof raw !== "string") return;
      try {
        const parsed = JSON.parse(raw) as { type?: string; id: string; route: string; line?: { kind: string; text: string } };
        if (parsed.type === "story.update") updates.push(parsed);
      } catch {
        // ignore unrelated log data
      }
    });
    await observer.connect(observerTransport);
  }, 60_000);

  afterAll(async () => {
    await observer.close();
    await daemon.close();
    if (fixtureDir && existsSync(fixtureDir)) rmSync(fixtureDir, { recursive: true, force: true });
  }, 60_000);

  it("registers a live session, attaches cwd, pulls next, streams, and completes via daemon tools", async () => {
    const story = makeStory();
    daemon.store.upsertStory(story);
    daemon.store.enqueue(story.id);

    const assignment = await runFablePullLoop({
      url: `http://127.0.0.1:${TEST_PORT}/mcp`,
      path: fixtureDir,
      repo: repoId,
      branch: "main",
      model: "claude-fable-test",
      log: () => undefined,
    });

    expect("repo" in assignment.project ? assignment.project.repo : undefined).toBe(repoId);
    expect(assignment.story?.id).toBe(story.id);
    expect(assignment.story?.column).toBe("in_progress");
    expect(existsSync(assignment.story!.worktree)).toBe(true);
    expect(daemon.queue.isWriteLocked(assignment.story!.worktree)).toBe(true);
    expect(assignment.prompt).toContain("All model work happens in this live Fable/Claude Code session");
    expect(assignment.prompt).toContain("story.complete");

    await streamFableUpdate({
      url: `http://127.0.0.1:${TEST_PORT}/mcp`,
      id: story.id,
      route: "fable",
      kind: "out",
      text: "Fable is implementing in the returned worktree",
    });

    await new Promise((r) => setTimeout(r, 300));
    const storyLines = updates.filter((u) => u.id === story.id).map((u) => u.line?.text ?? "");
    expect(storyLines.some((line) => line.includes("Fable pulled W-000008"))).toBe(true);
    expect(storyLines.some((line) => line.includes("Fable is implementing"))).toBe(true);

    const handoff: Handoff = {
      status: "completed",
      summary: "Fable pull loop verified",
      changes: ["skills/fable-pull-loop/SKILL.md"],
      verification: ["vitest fable-pull-loop.test.ts"],
      risks: [],
      next_actions: [],
    };
    const run: RunRecord = {
      id: "run-fable-1",
      storyId: story.id,
      label: "fable orchestration",
      repo: repoId,
      route: "fable",
      backend: "Claude Code",
      model: "claude-fable-test",
      access: "parent",
      tokens: 1234,
      durMs: 2500,
      status: "completed",
      changed: 2,
      outcome: "accepted",
    };

    await completeFableStory({
      url: `http://127.0.0.1:${TEST_PORT}/mcp`,
      id: story.id,
      handoff,
      pr: "https://github.com/example/repo/pull/8",
      runs: [run],
      outcome: "accepted",
    });

    const reviewed = daemon.store.getStory(story.id);
    expect(reviewed?.column).toBe("review");
    expect(reviewed?.pr).toBe("https://github.com/example/repo/pull/8");
    expect(daemon.store.getRunsForStory(story.id)).toHaveLength(1);
    expect(daemon.queue.isWriteLocked(assignment.story!.worktree)).toBe(false);
  }, 60_000);

  it("surfaces the awaiting-plan reason when no queued story is dispatchable", async () => {
    const story = makeStory();
    story.id = "story-fable-waiting";
    story.wid = "W-000009";
    story.branch = "feat/fable-waiting";
    story.orchestration = { status: "planning" };
    daemon.store.upsertStory(story);
    daemon.store.enqueue(story.id);
    const logs: string[] = [];

    const assignment = await runFablePullLoop({
      url: `http://127.0.0.1:${TEST_PORT}/mcp`,
      path: fixtureDir,
      repo: repoId,
      branch: "main",
      model: "claude-fable-test",
      log: (message) => logs.push(message),
    });

    expect(assignment).toMatchObject({ story: null, reason: "awaiting-orchestration-plan" });
    expect(assignment.prompt).toContain("awaiting orchestration plans");
    expect(logs).toContain("queued stories are awaiting orchestration plans");
  }, 60_000);
});
