import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import type { AppConfig, RoutingTraceSidecar, RunRecord, RunWithTrace, Story } from "arc-contracts";
import { startDaemon, type DaemonHandle } from "../mcp-server/dist/server.js";

const TEST_PORT = 7423;
const FIXTURE_DIR = join(dirname(fileURLToPath(import.meta.url)), "fixtures/orchestrator-traces");
const V2_FIXTURE = JSON.parse(readFileSync(join(FIXTURE_DIR, "routing-trace-v2.json"), "utf8")) as RoutingTraceSidecar;

type ToolResult = { content: Array<{ type: string; text?: string }>; isError?: boolean };

function parseToolResult<T>(result: ToolResult): T {
  const text = result.content.find((c) => c.type === "text")?.text ?? "";
  if (!text) throw new Error("No text content in tool result");
  return JSON.parse(text) as T;
}

describe("runs.ingestTrace live consumption", () => {
  let daemon: DaemonHandle;
  let client: Client;
  let transport: StreamableHTTPClientTransport;

  beforeAll(async () => {
    daemon = await startDaemon({ port: TEST_PORT, dbPath: ":memory:" });
    transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${TEST_PORT}/mcp`));
    client = new Client({ name: "board-ingest-trace-test", version: "0.0.0" });
    await client.connect(transport);

    const story: Story = {
      id: "story-ingest-125",
      wid: "W-000125",
      type: "story",
      title: "Issue 125 ingest trace",
      repo: "owner/repo",
      branch: "feat/issue-125",
      worktree: "/tmp/wt/issue-125",
      column: "in_progress",
      priority: "med",
      size: "S",
      epic: "",
      taskClass: "feature",
      tags: [],
      description: "ingest trace",
      criteria: [],
      draft: false,
      issue: "#125",
    };
    daemon.store.upsertStory(story);
  });

  afterAll(async () => {
    await client.close();
    await daemon.close();
  });

  it("ingests v2, projects by runTraceView, and preserves the sidecar row", async () => {
    const ingested = parseToolResult<RunRecord>(
      (await client.callTool(
        { name: "runs.ingestTrace", arguments: { id: "story-ingest-125", trace: V2_FIXTURE } },
        CallToolResultSchema
      )) as ToolResult
    );
    expect(ingested.id).toBe("run-v2-1");
    expect(ingested.route).toBe("codex-implement");
    expect(ingested.model).toBe("composer-2.5");

    const storedSidecarBefore = daemon.store.getRoutingTraceSidecar("run-v2-1");
    expect(storedSidecarBefore?.lineage.run_id).toBe("run-v2-1");

    const v2AwareRuns = parseToolResult<RunRecord[]>(
      (await client.callTool({ name: "runs.list", arguments: {} }, CallToolResultSchema)) as ToolResult
    );
    expect(v2AwareRuns.find((run) => run.id === "run-v2-1")).toMatchObject({
      route: "codex-implement",
      model: "composer-2.5",
    });

    const legacyConfig = parseToolResult<AppConfig>(
      (await client.callTool(
        { name: "config.set", arguments: { runTraceView: "legacy" } },
        CallToolResultSchema
      )) as ToolResult
    );
    expect(legacyConfig.runTraceView).toBe("legacy");

    const legacyRuns = parseToolResult<RunRecord[]>(
      (await client.callTool({ name: "runs.list", arguments: {} }, CallToolResultSchema)) as ToolResult
    );
    const legacyView = legacyRuns.find((run) => run.id === "run-v2-1");
    expect(legacyView).toMatchObject({
      route: "codex-implement",
      model: "composer-2.5",
      changed: 4,
    });

    const storedSidecarMid = daemon.store.getRoutingTraceSidecar("run-v2-1");
    expect(storedSidecarMid).toEqual(storedSidecarBefore);
    expect(daemon.store.getStoredRun("run-v2-1")?.route).toBe("codex-implement");

    const restoredConfig = parseToolResult<AppConfig>(
      (await client.callTool(
        { name: "config.set", arguments: { runTraceView: "v2-aware" } },
        CallToolResultSchema
      )) as ToolResult
    );
    expect(restoredConfig.runTraceView).toBe("v2-aware");

    const replayedRuns = parseToolResult<RunRecord[]>(
      (await client.callTool({ name: "runs.list", arguments: {} }, CallToolResultSchema)) as ToolResult
    );
    expect(replayedRuns.find((run) => run.id === "run-v2-1")).toMatchObject({
      route: "codex-implement",
      model: "composer-2.5",
      backend: "Cursor Agent",
    });
    expect(daemon.store.getRoutingTraceSidecar("run-v2-1")).toEqual(storedSidecarBefore);
  });

  it("runs.listWithTrace hides sidecars in legacy mode and replays byte-identical sidecars", async () => {
    const v2AwareJoined = parseToolResult<RunWithTrace[]>(
      (await client.callTool({ name: "runs.listWithTrace", arguments: {} }, CallToolResultSchema)) as ToolResult
    );
    const joined = v2AwareJoined.find((entry) => entry.run.id === "run-v2-1");
    expect(joined?.run).toMatchObject({ route: "codex-implement", model: "composer-2.5" });
    expect(joined?.routingTrace?.lineage.run_id).toBe("run-v2-1");
    const sidecarSnapshot = structuredClone(joined?.routingTrace ?? null);
    expect(sidecarSnapshot).not.toBeNull();

    await client.callTool({ name: "config.set", arguments: { runTraceView: "legacy" } }, CallToolResultSchema);

    const legacyJoined = parseToolResult<RunWithTrace[]>(
      (await client.callTool({ name: "runs.listWithTrace", arguments: {} }, CallToolResultSchema)) as ToolResult
    );
    const legacyEntry = legacyJoined.find((entry) => entry.run.id === "run-v2-1");
    expect(legacyEntry?.routingTrace).toBeNull();
    expect(legacyEntry?.run).toMatchObject({ route: "codex-implement", changed: 4 });

    await client.callTool({ name: "config.set", arguments: { runTraceView: "v2-aware" } }, CallToolResultSchema);

    const replayedJoined = parseToolResult<RunWithTrace[]>(
      (await client.callTool({ name: "runs.listWithTrace", arguments: {} }, CallToolResultSchema)) as ToolResult
    );
    const replayedEntry = replayedJoined.find((entry) => entry.run.id === "run-v2-1");
    expect(replayedEntry?.routingTrace).toEqual(sidecarSnapshot);
    expect(JSON.stringify(replayedEntry?.routingTrace)).toBe(JSON.stringify(sidecarSnapshot));
    expect(daemon.store.getRoutingTraceSidecar("run-v2-1")).toEqual(sidecarSnapshot);
  });
});
