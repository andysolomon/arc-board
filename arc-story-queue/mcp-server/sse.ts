import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

export interface StoryUpdateEvent {
  id: string;
  route: string;
  line?: { kind: "cmd" | "out" | "ok" | "lock" | "unlock"; text: string };
  lane?: { route: string; status: "running" | "done" };
}

export type LifecycleKind =
  | "queued"
  | "started"
  | "review"
  | "done"
  | "abandoned"
  | "unqueued"
  | "drafted"
  | "file-requested"
  | "filed"
  | "merged"
  | "escalated";

export interface StoryLifecycleEvent {
  kind: LifecycleKind;
  id: string;
  wid?: string;
  title?: string;
  column?: string;
}

/** Fan-out story.update payloads to all MCP SSE subscribers. */
export class SseHub {
  private sessions = new Map<string, McpServer>();

  register(sessionId: string, server: McpServer): void {
    this.sessions.set(sessionId, server);
  }

  unregister(sessionId: string): void {
    this.sessions.delete(sessionId);
  }

  async broadcast(event: StoryUpdateEvent): Promise<void> {
    await this.send({ type: "story.update", ...event });
  }

  /** Fan-out a coarse lifecycle event (queued/started/review/done/abandoned/drafted/filed/etc.). */
  async emitEvent(event: StoryLifecycleEvent): Promise<void> {
    await this.send({ type: "story.event", ...event });
  }

  private async send(payload: Record<string, unknown>): Promise<void> {
    const data = JSON.stringify(payload);
    await Promise.all(
      [...this.sessions.entries()].map(([sessionId, server]) =>
        // A dead/closing session must not fail the originating tool call.
        server.sendLoggingMessage({ level: "info", data }, sessionId).catch(() => undefined)
      )
    );
  }
}
