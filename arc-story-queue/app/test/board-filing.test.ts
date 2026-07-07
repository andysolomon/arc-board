import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BoardStore } from "../src/lib/boardStore";
import { startDaemon, type DaemonHandle } from "../../mcp-server/dist/server.js";

const TEST_PORT = 7428;
const repoId = "test/board-filing";

describe("board GitHub filing flow", () => {
  let daemon: DaemonHandle;
  let store: BoardStore;
  let fixtureDir: string;

  beforeAll(async () => {
    fixtureDir = mkdtempSync(join(tmpdir(), "arc-board-filing-"));
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

  it("request → (manual) file → enqueue; guardrail lifts once filed", async () => {
    const draft = await store.createDraftNow({
      kind: "feature",
      title: "Filing flow story",
      description: "needs an issue",
    });
    expect(draft.draft).toBe(true);

    // request Fable to file → flag set, appears in the daemon's pull queue
    const requested = await store.requestFile(draft.id);
    expect(requested.fileRequested).toBe(true);
    expect(daemon.queue.filePending().map((s) => s.id)).toContain(draft.id);

    // still a draft → enqueue must be blocked by the guardrail
    await expect(store.enqueueStory(draft.id)).rejects.toThrow(/draft/i);

    // manual/deterministic file (the no-Fable fallback) clears draft + flag
    const filed = await store.fileStory(draft.id, "#77");
    expect(filed.draft).toBe(false);
    expect(filed.issue).toBe("#77");
    expect(filed.fileRequested).toBe(false);
    expect(daemon.queue.filePending().map((s) => s.id)).not.toContain(draft.id);

    // now the guardrail is lifted → enqueue succeeds
    const queued = await store.enqueueStory(draft.id);
    expect(queued.column).toBe("queued");
  });
});
