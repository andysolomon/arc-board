import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { FetchLike } from "@modelcontextprotocol/sdk/shared/transport.js";
import { CallToolResultSchema, LoggingMessageNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import type { StoryLifecycleEvent, StoryUpdateEvent } from "./boardState";

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
  }

  async close(): Promise<void> {
    if (this.client) await this.client.close();
    this.client = null;
    this.transport = null;
    this.connected = false;
  }

  private ensureClient(): Client {
    if (!this.client || !this.connected) {
      throw new Error("Board store is not connected");
    }
    return this.client;
  }

  /** Call an MCP tool and parse its JSON text result. */
  async call<T>(name: string, args: Record<string, unknown> = {}): Promise<T> {
    const client = this.ensureClient();
    const result = await client.callTool({ name, arguments: args }, CallToolResultSchema);
    return parseToolResult<T>(result);
  }

  /** Call an MCP tool and return the raw result (for `isError`-specific handling). */
  async callRaw(name: string, args: Record<string, unknown> = {}): Promise<unknown> {
    const client = this.ensureClient();
    return client.callTool({ name, arguments: args }, CallToolResultSchema);
  }
}
