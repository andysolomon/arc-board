import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { LoggingMessageNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SseHub } from "../mcp-server/sse.js";
import { startDaemon, type DaemonHandle } from "../mcp-server/dist/server.js";

const TEST_PORT = 7444;

function waitFor(assertion: () => void, timeoutMs = 2_000): Promise<void> {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      try {
        assertion();
        resolve();
      } catch (err) {
        if (Date.now() - started > timeoutMs) {
          reject(err);
          return;
        }
        setTimeout(tick, 25);
      }
    };
    tick();
  });
}

describe("SseHub ping", () => {
  it("broadcasts {type: ping, at} via sendLoggingMessage", async () => {
    const hub = new SseHub();
    const sendLoggingMessage = vi.fn().mockResolvedValue(undefined);
    hub.register("session-1", { sendLoggingMessage } as unknown as McpServer);

    await hub.ping();

    expect(sendLoggingMessage).toHaveBeenCalledTimes(1);
    const payload = JSON.parse(sendLoggingMessage.mock.calls[0][0].data as string) as {
      type: string;
      at: number;
    };
    expect(payload.type).toBe("ping");
    expect(typeof payload.at).toBe("number");
  });
});

describe("daemon ping interval", () => {
  let daemon: DaemonHandle;
  let fixtureDir: string;

  beforeAll(async () => {
    fixtureDir = mkdtempSync(join(tmpdir(), "arc-sse-ping-"));
    daemon = await startDaemon({
      port: TEST_PORT,
      host: "127.0.0.1",
      dbPath: join(fixtureDir, "test.db"),
      worktreeRoot: join(fixtureDir, "wt"),
      pingIntervalMs: 50,
    });
  }, 60_000);

  afterAll(async () => {
    await daemon.close();
    if (fixtureDir && existsSync(fixtureDir)) rmSync(fixtureDir, { recursive: true, force: true });
  }, 60_000);

  it("broadcasts ping events to SSE subscribers", async () => {
    const pings: Array<{ type: string; at: number }> = [];
    const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${TEST_PORT}/mcp`));
    const client = new Client({ name: "sse-ping-subscriber", version: "0.1.0" });
    client.setNotificationHandler(LoggingMessageNotificationSchema, (notification) => {
      const raw = notification.params?.data;
      if (typeof raw !== "string") return;
      try {
        const parsed = JSON.parse(raw) as { type?: string; at?: number };
        if (parsed.type === "ping") pings.push(parsed as { type: string; at: number });
      } catch {
        // ignore
      }
    });
    await client.connect(transport);

    try {
      await waitFor(() => {
        expect(pings.length).toBeGreaterThan(0);
        expect(pings[0].type).toBe("ping");
        expect(typeof pings[0].at).toBe("number");
      });
    } finally {
      await client.close();
    }
  }, 60_000);

  it("pingIntervalMs: 0 disables the heartbeat timer", async () => {
    const disabledDir = mkdtempSync(join(tmpdir(), "arc-sse-ping-off-"));
    const disabledDaemon = await startDaemon({
      port: TEST_PORT + 1,
      host: "127.0.0.1",
      dbPath: join(disabledDir, "test.db"),
      worktreeRoot: join(disabledDir, "wt"),
      pingIntervalMs: 0,
    });

    const pings: unknown[] = [];
    const transport = new StreamableHTTPClientTransport(
      new URL(`http://127.0.0.1:${TEST_PORT + 1}/mcp`)
    );
    const client = new Client({ name: "sse-ping-disabled", version: "0.1.0" });
    client.setNotificationHandler(LoggingMessageNotificationSchema, (notification) => {
      const raw = notification.params?.data;
      if (typeof raw === "string") {
        try {
          pings.push(JSON.parse(raw));
        } catch {
          // ignore
        }
      }
    });

    try {
      await client.connect(transport);
      await new Promise((r) => setTimeout(r, 200));
      expect(pings.some((p) => (p as { type?: string }).type === "ping")).toBe(false);
    } finally {
      await client.close();
      await disabledDaemon.close();
      if (existsSync(disabledDir)) rmSync(disabledDir, { recursive: true, force: true });
    }
  }, 60_000);
});
