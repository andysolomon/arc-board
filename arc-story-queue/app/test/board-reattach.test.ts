import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  BoardStore,
  LAST_PROJECT_STORAGE_KEY,
  type BoardStorage,
} from "../src/lib/boardStore";
import { startDaemon, type DaemonHandle } from "../../mcp-server/dist/server.js";

let nextPort = 7436;
const repoId = "test/reattach";

class MemoryStorage implements BoardStorage {
  private values = new Map<string, string>();

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }

  removeItem(key: string): void {
    this.values.delete(key);
  }
}

describe("board last-project reattach", () => {
  let daemon: DaemonHandle;
  let fixtureDir: string;
  let port: number;
  let storage: MemoryStorage;
  const stores: BoardStore[] = [];

  beforeEach(async () => {
    storage = new MemoryStorage();
    port = nextPort++;
    fixtureDir = mkdtempSync(join(tmpdir(), "arc-board-reattach-"));
    execFileSync("git", ["init"], { cwd: fixtureDir });
    execFileSync("git", ["config", "user.email", "t@e.com"], { cwd: fixtureDir });
    execFileSync("git", ["config", "user.name", "T"], { cwd: fixtureDir });
    writeFileSync(join(fixtureDir, "README.md"), "# fixture\n");
    execFileSync("git", ["add", "."], { cwd: fixtureDir });
    execFileSync("git", ["commit", "-m", "init"], { cwd: fixtureDir });

    daemon = await startDaemon({
      port,
      host: "127.0.0.1",
      dbPath: join(fixtureDir, "test.db"),
      worktreeRoot: join(fixtureDir, "wt"),
      maxParallel: 2,
    });
  }, 60_000);

  afterEach(async () => {
    await Promise.all(stores.map((store) => store.close().catch(() => undefined)));
    await daemon.close();
    if (fixtureDir && existsSync(fixtureDir)) rmSync(fixtureDir, { recursive: true, force: true });
  }, 60_000);

  function makeStore(): BoardStore {
    const store = new BoardStore(`http://127.0.0.1:${port}/mcp`, storage);
    stores.push(store);
    return store;
  }

  it("persists an attached repo and restores its stories on a fresh client", async () => {
    const first = makeStore();
    await first.connect();
    await first.registerAndAttach({
      repo: repoId,
      path: fixtureDir,
      branch: "main",
      model: "vitest",
      pid: process.pid,
    });
    const draft = await first.createDraftNow({
      kind: "feature",
      title: "Remember me",
      description: "survives reload",
    });

    expect(storage.getItem(LAST_PROJECT_STORAGE_KEY)).toContain(repoId);
    await first.close();

    const reloaded = makeStore();
    await reloaded.connect();

    const state = reloaded.getState();
    expect(state.status).toBe("connected");
    expect(state.project?.repo).toBe(repoId);
    expect(state.project?.path).toBe(fixtureDir);
    expect(state.stories[draft.id]?.title).toBe("Remember me");
  }, 60_000);

  it("leaves the client connected and unattached when the stored path is gone", async () => {
    const missingPath = join(fixtureDir, "missing");
    storage.setItem(
      LAST_PROJECT_STORAGE_KEY,
      JSON.stringify({ repo: repoId, path: missingPath, branch: "main", model: "vitest" })
    );

    const store = makeStore();
    await store.connect();

    const state = store.getState();
    expect(state.status).toBe("connected");
    expect(state.project).toBeNull();
    expect(state.error).toMatch(/Unable to restore last project/);
    expect(state.error).toContain("Attach a project to continue");
    expect(storage.getItem(LAST_PROJECT_STORAGE_KEY)).toBeNull();
  }, 60_000);
});
