import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

export interface StoryUpdateEvent {
  id: string;
  route: string;
  line?: { kind: "cmd" | "out" | "ok" | "lock" | "unlock"; text: string };
  lane?: { route: string; status: "running" | "done" };
}

export type LifecycleKind =
  | "queued"
  | "planning"
  | "planned"
  | "planning-failed"
  | "started"
  | "review"
  | "done"
  | "abandoned"
  | "unqueued"
  | "drafted"
  | "file-requested"
  | "filed"
  | "merged"
  | "escalated"
  | "purged";

export interface StoryLifecycleEvent {
  kind: LifecycleKind;
  id: string;
  wid?: string;
  title?: string;
  column?: string;
  pr?: string;
  /** Present for visible background-planner fallback retries. */
  backend?: "codex" | "claude" | "composer";
  previousBackend?: "codex" | "claude" | "composer";
  attempt?: number;
  /** Preserved terminal/retry backend diagnostic; the drawer reads durable story.orchestration.error. */
  error?: string;
}

/** Fan-out story.update payloads to all MCP SSE subscribers. */
export class SseHub {
  private sessions = new Map<string, McpServer>();
  private lifecycleListeners = new Set<(event: StoryLifecycleEvent) => void>();

  register(sessionId: string, server: McpServer): void {
    this.sessions.set(sessionId, server);
  }

  unregister(sessionId: string): void {
    this.sessions.delete(sessionId);
  }

  /**
   * Receive lifecycle facts only after their SSE fan-out has completed. This
   * makes queue observers follow the same ordering that connected clients see.
   */
  subscribeLifecycle(listener: (event: StoryLifecycleEvent) => void): () => void {
    this.lifecycleListeners.add(listener);
    return () => this.lifecycleListeners.delete(listener);
  }

  async broadcast(event: StoryUpdateEvent): Promise<void> {
    await this.send({ type: "story.update", ...event });
  }

  /** Fan-out a coarse lifecycle event (queued/started/review/done/abandoned/drafted/filed/etc.). */
  async emitEvent(event: StoryLifecycleEvent): Promise<void> {
    await this.send({ type: "story.event", ...event });
    for (const listener of this.lifecycleListeners) {
      // Lifecycle observers are background work and must never fail the MCP
      // mutation whose already-delivered event they observed.
      try { listener(event); } catch { /* observer failures are isolated */ }
    }
  }

  /** Broadcast a heartbeat so subscribers can detect a live SSE stream. */
  async ping(): Promise<void> {
    await this.send({ type: "ping", at: Date.now() });
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
