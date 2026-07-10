import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { FetchLike } from "@modelcontextprotocol/sdk/shared/transport.js";
import { CallToolResultSchema, LoggingMessageNotificationSchema, McpError } from "@modelcontextprotocol/sdk/types.js";
import type { StoryLifecycleEvent, StoryUpdateEvent } from "./boardState";

/**
 * The daemon registers its tool set once at process startup, so a daemon
 * launched from a stale `dist/` build silently lacks tools a newer UI calls
 * and rejects them with a raw `MCP error -32602: Tool <name> not found`
 * (W-000034). Translate that skew into guidance the user can act on.
 */
export function missingDaemonToolError(name: string): Error {
  return new Error(
    `The story-queue daemon is running an older build without "${name}". ` +
      "Rebuild and restart it (npm run build, then npm run start in mcp-server), then reload the board."
  );
}

function isToolNotFoundError(err: unknown, name: string): boolean {
  return err instanceof McpError && err.message.includes(`Tool ${name} not found`);
}

/** The daemon reports an unknown tool as a resolved result with `isError`. */
function isToolNotFoundResult(result: unknown, name: string): boolean {
  const r = result as { content?: Array<{ type: string; text?: string }>; isError?: boolean };
  if (!r?.isError) return false;
  const text = r.content?.find((c) => c.type === "text")?.text;
  return !!text?.includes(`Tool ${name} not found`);
}

/** Extract and JSON-parse the text payload of an MCP tool result. */
export function parseToolResult<T>(result: unknown): T {
  const r = result as { content?: Array<{ type: string; text?: string }>; isError?: boolean };
  const text = r.content?.find((c) => c.type === "text")?.text;
  if (r.isError) throw new Error(text ?? "MCP tool returned an error");
  if (!text) throw new Error("No text content in tool result");
  try {
    return JSON.parse(text) as T;
  } catch {
    // Non-JSON payload (e.g. a raw daemon error) — surface the text itself
    // instead of a misleading "JSON Parse error".
    throw new Error(text);
  }
}

function isTauriRuntime(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

export async function resolveTauriHttpFetch(): Promise<FetchLike | null> {
  if (!isTauriRuntime()) return null;
  const mod = (await import("@tauri-apps/plugin-http")) as unknown as { fetch?: FetchLike };
  if (typeof mod.fetch !== "function") throw new Error("tauri-plugin-http fetch is unavailable");
  return mod.fetch;
}

/**
 * SSE lifecycle callbacks. `BoardSync` parses raw MCP log notifications and
 * dispatches structured board events; the store wires these to its reducers.
 */
export interface BoardSyncHandlers {
  onStoryUpdate(event: StoryUpdateEvent): void;
  onLifecycle(event: StoryLifecycleEvent): void;
}

/**
 * Small interface over the MCP transport: connection lifecycle, tool calls,
 * and `story.update` / `story.event` streaming. It owns no board state, so the
 * pure board reducers stay testable without a network transport.
 */
export class BoardSync {
  private client: Client | null = null;
  private transport: StreamableHTTPClientTransport | null = null;
  private connected = false;
  /** Tool names the connected daemon actually serves; null when unknown. */
  private toolNames: Set<string> | null = null;

  constructor(
    private readonly mcpUrl: string,
    private readonly mcpFetch: FetchLike | null,
    private readonly handlers: BoardSyncHandlers
  ) {}

  isConnected(): boolean {
    return this.connected && this.client !== null;
  }

  async connect(): Promise<void> {
    const mcpFetch = this.mcpFetch ?? (await resolveTauriHttpFetch());
    this.transport = new StreamableHTTPClientTransport(
      new URL(this.mcpUrl),
      mcpFetch ? { fetch: mcpFetch } : undefined
    );
    this.client = new Client({ name: "arc-story-queue-board", version: "0.1.0" });
    this.client.setNotificationHandler(LoggingMessageNotificationSchema, (notification) => {
      const raw = notification.params?.data;
      if (typeof raw !== "string") return;
      try {
        const parsed = JSON.parse(raw) as { type?: string };
        if (parsed.type === "story.update") {
          this.handlers.onStoryUpdate(parsed as StoryUpdateEvent);
        } else if (parsed.type === "story.event") {
          this.handlers.onLifecycle(parsed as StoryLifecycleEvent);
        }
      } catch {
        // ignore non-JSON log lines
      }
    });
    await this.client.connect(this.transport);
    this.connected = true;
    try {
      const { tools } = await this.client.listTools();
      this.toolNames = new Set(tools.map((tool) => tool.name));
    } catch {
      // Daemon without tools/list support — fall back to call-time translation.
      this.toolNames = null;
    }
  }

  async close(): Promise<void> {
    if (this.client) await this.client.close();
    this.client = null;
    this.transport = null;
    this.connected = false;
    this.toolNames = null;
  }

  private ensureClient(): Client {
    if (!this.client || !this.connected) {
      throw new Error("Board store is not connected");
    }
    return this.client;
  }

  private async callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
    const client = this.ensureClient();
    if (this.toolNames && !this.toolNames.has(name)) throw missingDaemonToolError(name);
    try {
      const result = await client.callTool({ name, arguments: args }, CallToolResultSchema);
      if (isToolNotFoundResult(result, name)) throw missingDaemonToolError(name);
      return result;
    } catch (err) {
      if (isToolNotFoundError(err, name)) throw missingDaemonToolError(name);
      throw err;
    }
  }

  /** Call an MCP tool and parse its JSON text result. */
  async call<T>(name: string, args: Record<string, unknown> = {}): Promise<T> {
    return parseToolResult<T>(await this.callTool(name, args));
  }

  /** Call an MCP tool and return the raw result (for `isError`-specific handling). */
  async callRaw(name: string, args: Record<string, unknown> = {}): Promise<unknown> {
    return this.callTool(name, args);
  }
}
