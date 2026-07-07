import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BoardStore } from "../src/lib/boardStore";
import { startDaemon, type DaemonHandle } from "../../mcp-server/dist/server.js";

const TEST_PORT = 7425;
const repoId = "test/board-intake";

describe("board intake seam", () => {
  let daemon: DaemonHandle;
  let store: BoardStore;
  let fixtureDir: string;

  beforeAll(async () => {
    fixtureDir = mkdtempSync(join(tmpdir(), "arc-board-intake-"));
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
  }, 60_000);

  afterAll(async () => {
    await store.close();
    await daemon.close();
    if (fixtureDir && existsSync(fixtureDir)) rmSync(fixtureDir, { recursive: true, force: true });
  }, 60_000);

  it("enqueue → draft lands a backlog draft and marks intake done", async () => {
    const item = await store.enqueueIntake({
      kind: "feature",
      title: "Add search",
      description: "Users need search",
    });
    expect(store.getIntake().some((i) => i.id === item.id && i.status === "pending")).toBe(true);

    const story = await store.draftIntake(item.id);
    expect(story.draft).toBe(true);
    expect(story.column).toBe("backlog");
    expect(story.repo).toBe(repoId);
    expect(story.wid).toMatch(/^W-\d{6}$/);

    // draft is on the board's backlog, and the intake item is done
    expect(store.storiesByColumn("backlog").some((s) => s.id === story.id)).toBe(true);
    expect(store.getIntake().find((i) => i.id === item.id)?.status).toBe("done");
  });

  it("createDraftNow enqueues and drafts in one step (no-Fable fallback)", async () => {
    const before = store.storiesByColumn("backlog").length;
    const story = await store.createDraftNow({
      kind: "bug",
      title: "Fix crash on save",
      description: "Null deref",
    });
    expect(story.type).toBe("bug");
    expect(story.column).toBe("backlog");
    expect(store.storiesByColumn("backlog").length).toBe(before + 1);
    // no lingering pending intake for this flow
    expect(store.getIntake().every((i) => i.status === "done")).toBe(true);
  });
});
