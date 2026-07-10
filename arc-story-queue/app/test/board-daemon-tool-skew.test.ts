import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BoardSync, missingDaemonToolError } from "../src/lib/boardSync";
import { startDaemon, type DaemonHandle } from "../../mcp-server/dist/server.js";

const TEST_PORT = 7439;

// W-000034: a daemon started from a stale dist build lacks tools a newer UI
// calls; the board must surface actionable restart guidance instead of the raw
// "MCP error -32602: Tool <name> not found" JSON-RPC error.
describe("daemon/UI tool-set skew (W-000034)", () => {
  let daemon: DaemonHandle;
  let sync: BoardSync;
  let fixtureDir: string;

  beforeAll(async () => {
    fixtureDir = mkdtempSync(join(tmpdir(), "arc-board-tool-skew-"));
    daemon = await startDaemon({
      port: TEST_PORT,
      host: "127.0.0.1",
      dbPath: join(fixtureDir, "test.db"),
      worktreeRoot: join(fixtureDir, "wt"),
      maxParallel: 2,
    });
    sync = new BoardSync(`http://127.0.0.1:${TEST_PORT}/mcp`, null, {
      onStoryUpdate: () => undefined,
      onLifecycle: () => undefined,
    });
    await sync.connect();
  }, 60_000);

  afterAll(async () => {
    await sync.close();
    await daemon.close();
    if (fixtureDir && existsSync(fixtureDir)) {
      rmSync(fixtureDir, { recursive: true, force: true });
    }
  }, 60_000);

  it("translates a tool the daemon does not serve into restart guidance", async () => {
    const err = await sync.call("story.notShippedYet", {}).then(
      () => null,
      (e: unknown) => e as Error
    );
    expect(err).toBeInstanceOf(Error);
    expect(err?.message).toBe(missingDaemonToolError("story.notShippedYet").message);
    expect(err?.message).toMatch(/older build/);
    expect(err?.message).not.toContain("-32602");
  }, 60_000);

  it("translates the raw -32602 daemon rejection when tools/list was unavailable", async () => {
    // Force the fallback path: without a cached tool list the call reaches the
    // daemon, which rejects with McpError -32602 "Tool <name> not found".
    (sync as unknown as { toolNames: Set<string> | null }).toolNames = null;
    try {
      const err = await sync.callRaw("story.notShippedYet", {}).then(
        () => null,
        (e: unknown) => e as Error
      );
      expect(err).toBeInstanceOf(Error);
      expect(err?.message).toMatch(/older build/);
      expect(err?.message).not.toContain("-32602");
    } finally {
      await sync.close();
      await sync.connect();
    }
  }, 60_000);

  it("still serves tools the daemon does have", async () => {
    const stories = await sync.call<unknown[]>("stories.list", {});
    expect(Array.isArray(stories)).toBe(true);
  }, 60_000);
});
