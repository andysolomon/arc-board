import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { NextFunction, Request, Response } from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { AnnotateOutcome, Handoff, IntakeDraftProposal, Plan, RunRecord, Story } from "arc-contracts";
import { IntakeManager } from "./intake.js";
import { QueueManager } from "./queue.js";
import { SessionRegistry } from "./registry.js";
import { SseHub } from "./sse.js";
import { StoryStore } from "./store.js";
import { deriveRepoId } from "./git-repo.js";

export interface DaemonOptions {
  port?: number;
  host?: string;
  dbPath?: string;
  worktreeRoot?: string;
  maxParallel?: number;
}

export interface DaemonHandle {
  server: Server;
  port: number;
  store: StoryStore;
  queue: QueueManager;
  intake: IntakeManager;
  registry: SessionRegistry;
  sse: SseHub;
  close(): Promise<void>;
}

function jsonResult(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data) }] };
}

function assertGitRepoPath(path: string): void {
  try {
    const inside = execFileSync("git", ["-C", path, "rev-parse", "--is-inside-work-tree"], {
      encoding: "utf8",
      stdio: "pipe",
    }).trim();
    if (inside === "true") return;
  } catch {
    // Normalize all git/path errors into an actionable MCP error.
  }
  throw new Error(`Repository path is unavailable or is not a git repo: ${path}`);
}

function createSharedContext(opts: DaemonOptions) {
  const store = new StoryStore(opts.dbPath ?? ":memory:", opts.maxParallel ?? 2);
  const registry = new SessionRegistry();
  const sse = new SseHub();
  const queue = new QueueManager(
    {
      worktreeRoot: opts.worktreeRoot ?? "../wt",
      maxParallel: opts.maxParallel ?? 2,
    },
    { store, registry, sse }
  );
  const intake = new IntakeManager({ store });
  return { store, registry, sse, queue, intake };
}

function registerTools(server: McpServer, ctx: ReturnType<typeof createSharedContext>): void {
  const { queue, intake, registry, store, sse } = ctx;

  server.registerTool(
    "session.register",
    {
      title: "Register session",
      description: "Self-register a Claude Code session (repo/path/branch/model/pid).",
      inputSchema: {
        repo: z.string(),
        path: z.string(),
        branch: z.string(),
        model: z.string(),
        pid: z.number(),
      },
    },
    async (args) => {
      assertGitRepoPath(args.path);
      return jsonResult(registry.register(args));
    }
  );

  server.registerTool(
    "queue.next",
    {
      title: "Queue next",
      description: "Pull the top queued story for this project, open its worktree, mark in_progress.",
      inputSchema: { projectId: z.string() },
    },
    async ({ projectId }) => {
      const s = await queue.next(projectId);
      if (s) void sse.emitEvent({ kind: "started", id: s.id, wid: s.wid, title: s.title, column: s.column });
      return jsonResult(s);
    }
  );

  server.registerTool(
    "story.get",
    {
      title: "Get story",
      description: "Fetch a story's full spec by id.",
      inputSchema: { id: z.string() },
    },
    async ({ id }) => jsonResult(await queue.get(id))
  );

  server.registerTool(
    "story.update",
    {
      title: "Story update",
      description: "Stream progress: terminal line, lane status, or phase change.",
      inputSchema: {
        id: z.string(),
        route: z.string(),
        line: z
          .object({
            kind: z.enum(["cmd", "out", "ok", "lock", "unlock"]),
            text: z.string(),
          })
          .optional(),
        lane: z
          .object({
            route: z.string(),
            status: z.enum(["running", "done"]),
          })
          .optional(),
      },
    },
    async (args) => jsonResult(await queue.update(args))
  );

  server.registerTool(
    "story.plan",
    {
      title: "Story plan",
      description: "Draft the execution plan for a story.",
      inputSchema: {
        id: z.string(),
        plan: z.custom<Plan>(),
      },
    },
    async ({ id, plan }) => jsonResult(await queue.setPlan(id, plan))
  );

  server.registerTool(
    "story.save",
    {
      title: "Story save",
      description: "Persist a refined story spec without changing its lifecycle column.",
      inputSchema: {
        story: z.custom<Story>(),
      },
    },
    async ({ story }) => jsonResult(await queue.save(story))
  );

  server.registerTool(
    "story.complete",
    {
      title: "Story complete",
      description: "Finish a story: attach handoff + PR, move to review, persist run records.",
      inputSchema: {
        id: z.string(),
        handoff: z.custom<Handoff>(),
        pr: z.string(),
        runs: z.array(z.custom<RunRecord>()),
        outcome: z.enum(["accepted", "rejected", "blocked", "verification-failed", "escalated"]) as z.ZodType<AnnotateOutcome>,
      },
    },
    async (args) => {
      const r = await queue.complete(args);
      const s = store.getStory(args.id);
      if (s) void sse.emitEvent({ kind: "review", id: s.id, wid: s.wid, title: s.title, column: s.column });
      return jsonResult(r);
    }
  );

  server.registerTool(
    "story.merge",
    {
      title: "Merge story PR",
      description: "Merge a reviewed story's PR, remove its worktree, release its lock, and move it to Done.",
      inputSchema: { id: z.string() },
    },
    async ({ id }) => {
      const s = await queue.merge(id);
      void sse.emitEvent({ kind: "done", id: s.id, wid: s.wid, title: s.title, column: s.column });
      return jsonResult(s);
    }
  );

  server.registerTool(
    "story.abandon",
    {
      title: "Abandon story worktree",
      description: "Abandon an in-progress story, remove its worktree, release its lock, and move it back to Backlog.",
      inputSchema: { id: z.string() },
    },
    async ({ id }) => {
      const s = await queue.abandon(id);
      void sse.emitEvent({ kind: "abandoned", id: s.id, wid: s.wid, title: s.title, column: s.column });
      return jsonResult(s);
    }
  );

  server.registerTool(
    "project.discover",
    {
      title: "Discover projects",
      description: "List connected-but-unattached sessions.",
    },
    async () => jsonResult(await queue.discover())
  );

  server.registerTool(
    "project.attach",
    {
      title: "Attach project",
      description: "Attach a discovered session as a project.",
      inputSchema: { sessionId: z.string() },
    },
    async ({ sessionId }) => jsonResult(await queue.attach(sessionId))
  );

  server.registerTool(
    "project.detach",
    {
      title: "Detach project",
      description: "Detach an attached project without deleting its stories.",
      inputSchema: { projectId: z.string() },
    },
    async ({ projectId }) => jsonResult(await queue.detach(projectId))
  );

  server.registerTool(
    "intake.enqueue",
    {
      title: "Intake enqueue",
      description: "Enqueue an intake item for Fable to draft into a story.",
      inputSchema: {
        kind: z.enum(["feature", "prd", "bug"]),
        title: z.string(),
        description: z.string(),
      },
    },
    async (args) => jsonResult(intake.enqueue(args))
  );

  server.registerTool(
    "intake.next",
    {
      title: "Intake next",
      description: "Pull the next pending intake item and mark it claimed.",
    },
    async () => jsonResult(intake.next())
  );

  server.registerTool(
    "intake.complete",
    {
      title: "Intake complete",
      description: "Complete an intake item with a drafted story from Fable.",
      inputSchema: {
        id: z.string(),
        story: z.custom<Story>(),
      },
    },
    async ({ id, story }) => jsonResult(intake.complete(id, story))
  );

  server.registerTool(
    "intake.list",
    {
      title: "Intake list",
      description: "List intake items (pending/claimed/done).",
    },
    async () => jsonResult(intake.list())
  );

  server.registerTool(
    "intake.draft",
    {
      title: "Intake draft (fallback)",
      description:
        "Deterministically template a pending intake item into a backlog draft story (no model).",
      inputSchema: { id: z.string(), projectId: z.string() },
    },
    async ({ id, projectId }) => {
      const s = intake.draft(id, queue.repoOf(projectId));
      void sse.emitEvent({ kind: "drafted", id: s.id, wid: s.wid, title: s.title, column: s.column });
      return jsonResult(s);
    }
  );

  server.registerTool(
    "intake.createDrafts",
    {
      title: "Create intake drafts",
      description:
        "Persist selected intake proposals as backlog drafts. Proposals may come from Fable/the harness or the deterministic UI fallback; the daemon never invokes a model.",
      inputSchema: { projectId: z.string(), drafts: z.array(z.custom<IntakeDraftProposal>()) },
    },
    async ({ projectId, drafts }) => {
      const stories = intake.createDrafts(drafts, queue.repoOf(projectId));
      for (const s of stories) {
        void sse.emitEvent({ kind: "drafted", id: s.id, wid: s.wid, title: s.title, column: s.column });
      }
      return jsonResult(stories);
    }
  );

  server.registerTool(
    "story.file",
    {
      title: "Story file",
      description: "File a draft story to GitHub via Fable, clearing draft status.",
      inputSchema: {
        id: z.string(),
        issue: z.string(),
      },
    },
    async ({ id, issue }) => {
      const s = await queue.file(id, issue);
      void sse.emitEvent({ kind: "filed", id: s.id, wid: s.wid, title: s.title, column: s.column });
      return jsonResult(s);
    }
  );

  server.registerTool(
    "story.requestFile",
    {
      title: "Request filing",
      description: "Flag a draft so a Fable session files it to GitHub via gh.",
      inputSchema: { id: z.string() },
    },
    async ({ id }) => {
      const s = await queue.requestFile(id);
      void sse.emitEvent({ kind: "file-requested", id: s.id, wid: s.wid, title: s.title, column: s.column });
      return jsonResult(s);
    }
  );

  server.registerTool(
    "git.repoId",
    {
      title: "Derive repo id",
      description: "Read a local repo's origin remote and parse the owner/name GitHub slug.",
      inputSchema: { path: z.string() },
    },
    async ({ path }) => jsonResult(deriveRepoId(path))
  );

  server.registerTool(
    "github.import",
    {
      title: "Import GitHub issues",
      description: "Import a repo's open GitHub issues as backlog stories (via gh, deduped by url).",
      inputSchema: { repo: z.string() },
    },
    async ({ repo }) => jsonResult(queue.importGithub(repo))
  );

  server.registerTool(
    "file.pending",
    {
      title: "Pending file requests",
      description: "Drafts the user asked to be filed (the pull queue Fable drains via gh).",
      inputSchema: { projectId: z.string().optional() },
    },
    async ({ projectId }) => jsonResult(queue.filePending(projectId))
  );

  server.registerTool(
    "story.enqueue",
    {
      title: "Story enqueue",
      description: "Move a filed story into the execution queue.",
      inputSchema: { id: z.string() },
    },
    async ({ id }) => {
      const s = await queue.enqueueStory(id);
      void sse.emitEvent({ kind: "queued", id: s.id, wid: s.wid, title: s.title, column: s.column });
      return jsonResult(s);
    }
  );

  server.registerTool(
    "stories.list",
    {
      title: "Stories list",
      description: "List all stories, optionally filtered by project.",
      inputSchema: { projectId: z.string().optional() },
    },
    async ({ projectId }) => {
      const stories = store.listStories();
      if (!projectId) return jsonResult(stories);
      const repo = queue.repoOf(projectId);
      return jsonResult(stories.filter((s) => s.repo === repo));
    }
  );

  server.registerTool(
    "queue.list",
    {
      title: "Queue list",
      description: "Ordered execution queue, optionally scoped to a project's repo.",
      inputSchema: { projectId: z.string().optional() },
    },
    async ({ projectId }) => jsonResult(queue.listQueue(projectId))
  );

  server.registerTool(
    "queue.reorder",
    {
      title: "Queue reorder",
      description: "Move a queued story up or down; returns the new ordered queue.",
      inputSchema: { id: z.string(), direction: z.enum(["up", "down"]) },
    },
    async ({ id, direction }) => jsonResult(queue.reorder(id, direction))
  );

  server.registerTool(
    "queue.setOrder",
    {
      title: "Queue set order",
      description: "Set an arbitrary queue order (drag reorder); returns the new ordered queue.",
      inputSchema: { ids: z.array(z.string()) },
    },
    async ({ ids }) => jsonResult(queue.setOrder(ids))
  );

  server.registerTool(
    "story.unqueue",
    {
      title: "Story unqueue",
      description: "Pull a story out of the queue back to backlog.",
      inputSchema: { id: z.string() },
    },
    async ({ id }) => {
      const s = queue.unqueue(id);
      void sse.emitEvent({ kind: "unqueued", id: s.id, wid: s.wid, title: s.title, column: s.column });
      return jsonResult(s);
    }
  );

  server.registerTool(
    "runs.list",
    {
      title: "Runs list",
      description: "All run records (observability), optionally scoped to a project's repo.",
      inputSchema: { projectId: z.string().optional() },
    },
    async ({ projectId }) => jsonResult(queue.listRuns(projectId))
  );

  server.registerTool(
    "story.detail",
    {
      title: "Story detail",
      description: "Full drawer hydration: story + persisted runs + handoff.",
      inputSchema: { id: z.string() },
    },
    async ({ id }) => jsonResult(queue.detail(id))
  );

  server.registerTool(
    "config.get",
    {
      title: "Config get",
      description: "Read the persisted daemon config (autoRun, maxParallel).",
    },
    async () => jsonResult(queue.getConfig())
  );

  server.registerTool(
    "config.set",
    {
      title: "Config set",
      description: "Update the persisted daemon config; returns the merged config.",
      inputSchema: {
        autoRun: z.boolean().optional(),
        maxParallel: z.number().int().positive().optional(),
      },
    },
    async (args) => jsonResult(queue.setConfig(args))
  );
}

function createMcpServerForSession(ctx: ReturnType<typeof createSharedContext>): McpServer {
  const server = new McpServer(
    { name: "arc-story-queue", version: "0.1.0" },
    { capabilities: { logging: {} } }
  );
  registerTools(server, ctx);
  return server;
}

// Allow any loopback dev origin (Vite picks 5173/5174/5175… when ports are taken) plus
// the Tauri webview origins. Safe: the daemon binds loopback only, so these are all local.
export function isAllowedOrigin(origin: string): boolean {
  return (
    /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i.test(origin) ||
    origin === "tauri://localhost" ||
    origin === "http://tauri.localhost" ||
    origin === "https://tauri.localhost"
  );
}

export async function startDaemon(opts: DaemonOptions = {}): Promise<DaemonHandle> {
  const port = opts.port ?? 7420;
  const host = opts.host ?? "127.0.0.1";
  const ctx = createSharedContext(opts);
  const transports = new Map<string, StreamableHTTPServerTransport>();
  const sessionServers = new Map<string, McpServer>();

  const app = createMcpExpressApp({ host });

  app.use("/mcp", (req: Request, res: Response, next: NextFunction) => {
    const origin = req.headers.origin;
    if (origin && isAllowedOrigin(origin)) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
      // Echo the headers the browser asks for (MCP adds mcp-protocol-version, mcp-session-id,
      // etc.); fall back to the known set for non-preflight requests.
      const requested = req.headers["access-control-request-headers"];
      res.setHeader(
        "Access-Control-Allow-Headers",
        typeof requested === "string" && requested
          ? requested
          : "content-type, mcp-session-id, mcp-protocol-version, accept, last-event-id, authorization"
      );
      res.setHeader("Access-Control-Expose-Headers", "mcp-session-id");
    }
    if (req.method === "OPTIONS") {
      res.status(204).end();
      return;
    }
    next();
  });

  app.post("/mcp", async (req: Request, res: Response) => {
    const sessionId = req.headers["mcp-session-id"] as string | undefined;
    let transport = sessionId ? transports.get(sessionId) : undefined;

    if (!transport && isInitializeRequest(req.body)) {
      const mcpServer = createMcpServerForSession(ctx);
      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (id) => {
          transports.set(id, transport!);
          sessionServers.set(id, mcpServer);
          ctx.sse.register(id, mcpServer);
        },
      });
      await mcpServer.connect(transport);
      await transport.handleRequest(req, res, req.body);
      return;
    }

    if (!transport) {
      res.status(400).json({
        jsonrpc: "2.0",
        error: { code: -32000, message: "Bad Request: No valid session ID provided" },
        id: null,
      });
      return;
    }

    await transport.handleRequest(req, res, req.body);
  });

  app.get("/mcp", async (req: Request, res: Response) => {
    const sessionId = req.headers["mcp-session-id"] as string | undefined;
    const transport = sessionId ? transports.get(sessionId) : undefined;
    if (!transport) {
      res.status(400).send("Invalid or missing session ID");
      return;
    }
    await transport.handleRequest(req, res);
  });

  app.delete("/mcp", async (req: Request, res: Response) => {
    const sessionId = req.headers["mcp-session-id"] as string | undefined;
    const transport = sessionId ? transports.get(sessionId) : undefined;
    if (!transport) {
      res.status(400).send("Invalid or missing session ID");
      return;
    }
    await transport.handleRequest(req, res);
    if (sessionId) {
      ctx.sse.unregister(sessionId);
      sessionServers.delete(sessionId);
      transports.delete(sessionId);
      ctx.registry.unregister(sessionId);
    }
  });

  const listenOn = (h: string): Promise<Server> =>
    new Promise<Server>((resolve, reject) => {
      const server = createServer(app);
      server.on("error", reject);
      server.listen(port, h, () => resolve(server));
    });

  // Bind BOTH loopback stacks: `localhost` resolves to ::1 (IPv6) or 127.0.0.1 (IPv4)
  // depending on the client, so a single-family bind causes intermittent "Load failed".
  const httpServer = await listenOn(host);
  const servers: Server[] = [httpServer];
  if (host === "127.0.0.1") {
    try {
      servers.push(await listenOn("::1"));
    } catch {
      // IPv6 loopback unavailable on this host — the IPv4 bind is sufficient.
    }
  }

  return {
    server: httpServer,
    port,
    store: ctx.store,
    queue: ctx.queue,
    intake: ctx.intake,
    registry: ctx.registry,
    sse: ctx.sse,
    close: async () => {
      for (const t of transports.values()) await t.close();
      transports.clear();
      sessionServers.clear();
      ctx.store.close();
      await Promise.all(
        servers.map(
          (s) => new Promise<void>((resolve, reject) => s.close((err) => (err ? reject(err) : resolve())))
        )
      );
    },
  };
}
