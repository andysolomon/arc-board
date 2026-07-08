import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import type { FsDirListing } from "arc-contracts";
import { startDaemon, type DaemonHandle } from "../mcp-server/dist/server.js";

const TEST_PORT = 7423;

type ToolResult = { content: Array<{ type: string; text?: string }>; isError?: boolean };

function textOf(result: ToolResult): string {
  return result.content.find((c) => c.type === "text")?.text ?? "";
}

function parseToolResult<T>(result: ToolResult): T {
  const text = textOf(result);
  if (!text) throw new Error("No text content in tool result");
  return JSON.parse(text) as T;
}

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

describe("fs.listDir", () => {
  let daemon: DaemonHandle;
  let client: Client;
  let transport: StreamableHTTPClientTransport;
  let fixtureDir: string;

  beforeAll(async () => {
    fixtureDir = realpathSync(mkdtempSync(join(tmpdir(), "arc-sq-fs-")));
    mkdirSync(join(fixtureDir, "plain"));
    mkdirSync(join(fixtureDir, ".hidden"));
    const repoDir = join(fixtureDir, "repo");
    mkdirSync(repoDir);
    execFileSync("git", ["init"], { cwd: repoDir });
    execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: repoDir });
    execFileSync("git", ["config", "user.name", "Test"], { cwd: repoDir });
    writeFileSync(join(repoDir, "README.md"), "# fixture\n");
    execFileSync("git", ["add", "."], { cwd: repoDir });
    execFileSync("git", ["commit", "-m", "init"], { cwd: repoDir });

    daemon = await startDaemon({
      port: TEST_PORT,
      host: "127.0.0.1",
      dbPath: join(fixtureDir, "test.db"),
      worktreeRoot: join(fixtureDir, "wt"),
      fsRoot: fixtureDir,
    });

    transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${TEST_PORT}/mcp`));
    client = new Client({ name: "fs-list-dir-test", version: "0.1.0" });
    await client.connect(transport);
  }, 60_000);

  afterAll(async () => {
    await client.close();
    await daemon.close();
    if (fixtureDir && existsSync(fixtureDir)) rmSync(fixtureDir, { recursive: true, force: true });
  }, 60_000);

  it("lists visible directories under the configured root and marks git repos", async () => {
    const response = await callGuarded(client, "fs.listDir", { path: "" });
    expect(response.blocked).toBe(false);
    const listing = parseToolResult<FsDirListing>(response.result!);

    expect(listing.path).toBe(fixtureDir);
    expect(listing.parent).toBeNull();
    expect(listing.entries.map((entry) => entry.name)).toEqual(expect.arrayContaining(["plain", "repo"]));
    expect(listing.entries.some((entry) => entry.name === ".hidden")).toBe(false);
    expect(listing.entries.find((entry) => entry.name === "repo")?.isGitRepo).toBe(true);
    expect(listing.entries.find((entry) => entry.name === "plain")?.isGitRepo).toBe(false);
  });

  it("refuses paths outside the configured root", async () => {
    const response = await callGuarded(client, "fs.listDir", { path: dirname(fixtureDir) });
    expect(response.blocked).toBe(true);
    expect(response.message).toMatch(/outside the allowed root/i);
  });
});
