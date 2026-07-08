import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { CallToolResultSchema, LoggingMessageNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import type { Handoff, Project, RouteId, Story } from "arc-contracts";

type ToolResult = { content?: Array<{ type: string; text?: string }>; isError?: boolean };

type StoryLifecycleEvent = {
  type?: "story.event";
  kind?: string;
  id?: string;
  wid?: string;
  title?: string;
};

export type ArcWorkerExecutorKind = "claude" | "cursor" | "command" | "dry-run";

export interface ArcWorkerOptions {
  url: string;
  projectId?: string;
  repo?: string;
  path?: string;
  branch?: string;
  model?: string;
  pid?: number;
  once?: boolean;
  maxParallel?: number;
  heartbeatMs?: number;
  executor?: ArcWorkerExecutorKind;
  command?: string;
  mcpConfig?: string;
  allowedTools?: string;
  log?: (message: string) => void;
  now?: () => number;
}

export interface ArcWorkerResult {
  processed: number;
  stories: Array<{ id: string; wid: string; pr?: string | null }>;
}

interface ExecutionContext {
  client: Client;
  story: Story;
  log: (message: string) => void;
}

interface StoryExecutor {
  name: string;
  model: string;
  execute(ctx: ExecutionContext): Promise<void>;
}

function parseToolResult<T>(result: unknown): T {
  const r = result as ToolResult;
  const text = r.content?.find((c) => c.type === "text")?.text;
  if (r.isError) throw new Error(text ?? "MCP tool returned an error");
  if (!text) throw new Error("No text content in tool result");
  return JSON.parse(text) as T;
}

async function callTool<T>(client: Client, name: string, args: Record<string, unknown> = {}): Promise<T> {
  const result = await client.callTool({ name, arguments: args }, CallToolResultSchema);
  return parseToolResult<T>(result);
}

function runGit(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function localRepoId(cwd: string): string {
  try {
    const remote = runGit(cwd, ["remote", "get-url", "origin"]);
    const match = remote.match(/[:/]([^/:]+\/[^/]+?)(?:\.git)?$/);
    if (match) return match[1];
  } catch {
    // Fall back to an ownerless local repo id below.
  }
  return `local/${basename(resolve(cwd))}`;
}

function localBranch(cwd: string): string {
  try {
    return runGit(cwd, ["branch", "--show-current"]) || "main";
  } catch {
    return "main";
  }
}

function promptForStory(story: Story): string {
  const criteria = story.criteria.length ? story.criteria.map((c) => `- ${c}`).join("\n") : "- No acceptance criteria recorded.";
  const tasks = story.plan?.tasks?.length ? story.plan.tasks.map((task, i) => `${i + 1}. ${task}`).join("\n") : "No persisted plan. Inspect the repo and make the smallest correct change.";
  const files = story.plan?.files?.length
    ? story.plan.files.map((f) => `- ${f.path}: ${f.change}`).join("\n")
    : "- Determine from the story and codebase.";

  return [
    "# arc-worker assignment",
    "",
    `Story: ${story.wid} — ${story.title}`,
    `Repo: ${story.repo}`,
    `Issue: ${story.issue ?? "unknown"}`,
    `Worktree: ${story.worktree}`,
    `Branch: ${story.branch}`,
    "",
    "## Description",
    story.description || "No description recorded.",
    "",
    "## Acceptance criteria",
    criteria,
    "",
    "## Plan",
    tasks,
    "",
    "## Expected files",
    files,
    "",
    "## Instructions",
    "Work only inside the worktree. Make the smallest correct code change, update tests if needed, and run relevant verification. Do not wait for a human prompt.",
  ].join("\n");
}

async function streamLine(
  client: Client,
  story: Story,
  route: RouteId,
  kind: "cmd" | "out" | "ok" | "lock" | "unlock",
  text: string,
  status?: "running" | "done"
): Promise<void> {
  await callTool(client, "story.update", {
    id: story.id,
    route,
    line: { kind, text },
    lane: status ? { route, status } : undefined,
  });
}

export function claudeWorkerEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const next = { ...env };
  // In non-interactive `claude -p`, ANTHROPIC_API_KEY wins over subscription OAuth.
  // The worker deliberately unsets it so Claude Code CLI uses the user's Pro/Max auth
  // (or CLAUDE_CODE_OAUTH_TOKEN when the operator configured one with `claude setup-token`).
  delete next.ANTHROPIC_API_KEY;
  return next;
}

export function writeClaudeMcpConfig(worktree: string, url: string): string {
  const dir = join(worktree, ".arc-story-queue");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "claude-mcp.json");
  writeFileSync(path, JSON.stringify({ mcpServers: { "story-queue": { type: "http", url } } }, null, 2));
  return path;
}

export function claudeArgs(prompt: string, mcpConfig: string, allowedTools: string): string[] {
  return [
    "-p",
    prompt,
    "--mcp-config",
    mcpConfig,
    "--output-format",
    "stream-json",
    "--verbose",
    "--permission-mode",
    "acceptEdits",
    "--allowedTools",
    allowedTools,
  ];
}

function compact(value: unknown, max = 1200): string {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  if (!text) return "";
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

export function claudeEventLine(event: unknown): { kind: "cmd" | "out"; text: string } | null {
  const e = event as Record<string, unknown>;
  const type = String(e.type ?? "");
  if (type === "tool_use") return { kind: "cmd", text: compact(e.name ? `${e.name}: ${compact(e.input)}` : e) };
  if (type === "tool_result") return { kind: "out", text: compact(e.content ?? e.result ?? e) };
  if (type === "system" && e.subtype === "api_retry") return { kind: "out", text: `Claude Code retrying: ${compact(e.error ?? e)}` };
  if (type === "assistant" || type === "stream_event") {
    const text = compact(e.text ?? e.delta ?? e.content ?? "");
    return text ? { kind: "out", text } : null;
  }
  if (type === "result") return { kind: "out", text: compact(e.result ?? e) };
  return null;
}

class ClaudeCodeExecutor implements StoryExecutor {
  readonly name = "Claude Code CLI";
  readonly model = "claude-code-subscription";

  constructor(
    private readonly url: string,
    private readonly command = "claude",
    private readonly mcpConfig?: string,
    private readonly allowedTools = "Read,Write,Edit,Bash(git *),Bash(npm *)"
  ) {}

  async execute({ client, story, log }: ExecutionContext): Promise<void> {
    if (!story.worktree) throw new Error(`Story ${story.id} has no worktree`);
    const prompt = promptForStory(story);
    const mcpConfig = this.mcpConfig ?? writeClaudeMcpConfig(story.worktree, this.url);
    const args = claudeArgs(prompt, mcpConfig, this.allowedTools);
    await streamLine(client, story, "composer-implement", "cmd", `${this.command} -p <story prompt> --mcp-config ${mcpConfig} --output-format stream-json --verbose --permission-mode acceptEdits`);
    log(`executing Claude Code CLI for ${story.wid}`);

    await new Promise<void>((resolvePromise, rejectPromise) => {
      const child = spawn(this.command, args, {
        cwd: story.worktree,
        env: {
          ...claudeWorkerEnv(),
          ARC_STORY_ID: story.id,
          ARC_STORY_WID: story.wid,
          ARC_STORY_WORKTREE: story.worktree,
        },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      let pending = Promise.resolve();

      const enqueue = (fn: () => Promise<void>) => {
        pending = pending.then(fn, fn);
      };
      const handleLine = (line: string) => {
        if (!line.trim()) return;
        try {
          const mapped = claudeEventLine(JSON.parse(line));
          if (mapped) enqueue(() => streamLine(client, story, "composer-implement", mapped.kind, mapped.text));
        } catch {
          enqueue(() => streamLine(client, story, "composer-implement", "out", line.slice(0, 1200)));
        }
      };

      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        stdout += chunk;
        const lines = stdout.split(/\r?\n/);
        stdout = lines.pop() ?? "";
        lines.forEach(handleLine);
      });
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk: string) => {
        stderr += chunk;
        const lines = stderr.split(/\r?\n/);
        stderr = lines.pop() ?? "";
        lines.filter(Boolean).forEach((line) => enqueue(() => streamLine(client, story, "composer-implement", "out", line.slice(0, 1200))));
      });
      child.on("error", rejectPromise);
      child.on("close", (code) => {
        if (stdout.trim()) handleLine(stdout);
        if (stderr.trim()) enqueue(() => streamLine(client, story, "composer-implement", "out", stderr.slice(-1200)));
        pending
          .then(() => {
            if (code === 0) resolvePromise();
            else rejectPromise(new Error(`Claude Code CLI exited with code ${code}`));
          })
          .catch(rejectPromise);
      });
    });
  }
}

class CommandExecutor implements StoryExecutor {
  readonly name: string;
  readonly model: string;

  constructor(
    private readonly command: string,
    model = "command",
    name = "Command Executor"
  ) {
    this.model = model;
    this.name = name;
  }

  async execute({ client, story, log }: ExecutionContext): Promise<void> {
    if (!story.worktree) throw new Error(`Story ${story.id} has no worktree`);
    await streamLine(client, story, "composer-implement", "cmd", this.command);
    log(`executing ${this.command} for ${story.wid}`);
    const output = execFileSync("sh", ["-lc", this.command], {
      cwd: story.worktree,
      input: promptForStory(story),
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        ARC_STORY_ID: story.id,
        ARC_STORY_WID: story.wid,
        ARC_STORY_WORKTREE: story.worktree,
      },
    }).trim();
    if (output) await streamLine(client, story, "composer-implement", "out", output.slice(-4000));
  }
}

class DryRunExecutor implements StoryExecutor {
  readonly name = "Dry-run Executor";
  readonly model = "dry-run";

  async execute({ client, story }: ExecutionContext): Promise<void> {
    if (!story.worktree) throw new Error(`Story ${story.id} has no worktree`);
    await streamLine(client, story, "composer-implement", "out", "dry-run executor writing proof artifact");
    const noteDir = join(story.worktree, ".arc-story-queue", "arc-worker");
    mkdirSync(noteDir, { recursive: true });
    const notePath = join(noteDir, `${story.wid}.md`);
    writeFileSync(
      notePath,
      [`# ${story.wid} arc-worker run`, "", `Story: ${story.title}`, "", "Dry-run executor completed without human prompting.", ""].join("\n")
    );
  }
}

function createExecutor(opts: ArcWorkerOptions): StoryExecutor {
  const kind = opts.executor ?? (process.env.ARC_WORKER_EXECUTOR as ArcWorkerExecutorKind | undefined) ?? "claude";
  if (kind === "dry-run") return new DryRunExecutor();
  if (kind === "claude") {
    return new ClaudeCodeExecutor(
      opts.url,
      opts.command ?? process.env.ARC_WORKER_CLAUDE_COMMAND ?? "claude",
      opts.mcpConfig ?? process.env.ARC_WORKER_MCP_CONFIG,
      opts.allowedTools ?? process.env.ARC_WORKER_ALLOWED_TOOLS ?? "Read,Write,Edit,Bash(git *),Bash(npm *)"
    );
  }
  if (kind === "command") {
    const command = opts.command ?? process.env.ARC_WORKER_COMMAND;
    if (!command) throw new Error("ARC_WORKER_COMMAND or --command is required for the command executor");
    return new CommandExecutor(command, opts.model ?? "command");
  }

  const command = opts.command ?? process.env.ARC_WORKER_CURSOR_COMMAND ?? "cursor-agent";
  return new CommandExecutor(command, opts.model ?? "cursor-agent", "Cursor Agent");
}

async function ensureProject(client: Client, opts: ArcWorkerOptions): Promise<string> {
  if (opts.projectId) return opts.projectId;

  const cwd = resolve(opts.path ?? process.cwd());
  const session = await callTool<{ id: string }>(client, "session.register", {
    repo: opts.repo ?? localRepoId(cwd),
    path: cwd,
    branch: opts.branch ?? localBranch(cwd),
    model: opts.model ?? "arc-worker",
    pid: opts.pid ?? process.pid,
  });
  const project = await callTool<Project>(client, "project.attach", { sessionId: session.id });
  return project.id;
}

function commitSubject(story: Story): string {
  const type = story.taskClass === "bugfix" || story.type === "bug" ? "fix" : "feat";
  return `${type}: implement ${story.wid}`;
}

function changedFiles(worktree: string): string[] {
  const output = runGit(worktree, ["status", "--porcelain"]);
  return output
    .split("\n")
    .map((line) => line.slice(3).trim())
    .filter(Boolean);
}

function verification(worktree: string): string {
  return runGit(worktree, ["status", "--short"]) || "working tree clean";
}

async function finalizeStory(client: Client, story: Story, executor: StoryExecutor): Promise<Story> {
  if (!story.worktree) throw new Error(`Story ${story.id} has no worktree`);

  await streamLine(client, story, "codex-check", "cmd", "git status --short");
  const beforeCommit = changedFiles(story.worktree);
  await streamLine(client, story, "codex-check", "out", beforeCommit.join("\n") || "no changed files");

  if (beforeCommit.length > 0) {
    await streamLine(client, story, "composer-implement", "cmd", "git add -A");
    runGit(story.worktree, ["add", "-A"]);
    const subject = commitSubject(story);
    await streamLine(client, story, "composer-implement", "cmd", `git commit -m ${JSON.stringify(subject)}`);
    runGit(story.worktree, ["commit", "-m", subject]);
    await streamLine(client, story, "composer-implement", "ok", `committed ${beforeCommit.length} file(s)`, "done");
  } else {
    await streamLine(client, story, "composer-implement", "ok", "executor completed with no file changes", "done");
  }

  const after = verification(story.worktree);
  await streamLine(client, story, "codex-check", "out", after);
  await streamLine(client, story, "codex-check", "ok", `${executor.name} verification complete`, "done");
  await streamLine(client, story, "fable", "cmd", "story.review");
  const reviewed = await callTool<Story>(client, "story.review", { id: story.id });
  await streamLine(client, reviewed, "fable", "ok", `review ready: ${reviewed.pr ?? "local review"}`, "done");
  return reviewed;
}

async function blockStory(client: Client, story: Story, error: unknown): Promise<void> {
  const message = error instanceof Error ? error.message : String(error);
  await streamLine(client, story, "fable", "out", `blocked: ${message}`);
  const handoff: Handoff = {
    status: "blocked",
    summary: `arc-worker blocked on ${story.wid}: ${message}`,
    changes: [],
    verification: [],
    risks: [message],
    next_actions: ["Inspect the worker logs and resume or abandon the story from the board."],
  };
  await callTool(client, "story.block", { id: story.id, handoff, outcome: "blocked" });
}

/**
 * Run the headless auto-worker. It subscribes to daemon story.event broadcasts and
 * reacts to `started` events produced when the board reserves a queued story.
 */
export async function runArcWorker(opts: ArcWorkerOptions): Promise<ArcWorkerResult> {
  const log = opts.log ?? (() => undefined);
  const executor = createExecutor(opts);
  const transport = new StreamableHTTPClientTransport(new URL(opts.url));
  const client = new Client({ name: "arc-worker", version: "0.1.0" });
  const active = new Set<string>();
  const completed: ArcWorkerResult["stories"] = [];
  let projectId = "";
  let resolveOnce: ((value: ArcWorkerResult) => void) | null = null;
  let rejectOnce: ((reason?: unknown) => void) | null = null;
  let closed = false;

  const finishIfOnce = async () => {
    if (!opts.once || completed.length === 0 || active.size > 0 || !resolveOnce) return;
    closed = true;
    await client.close();
    resolveOnce({ processed: completed.length, stories: completed });
  };

  const processStory = async (id: string) => {
    if (active.has(id) || (opts.once && completed.length > 0)) return;
    active.add(id);
    try {
      const latest = await callTool<Story | null>(client, "story.get", { id });
      if (!latest || latest.column !== "in_progress" || !latest.worktree) return;
      await streamLine(client, latest, "fable", "out", `arc-worker picked up ${latest.wid} with ${executor.name}`);
      await executor.execute({ client, story: latest, log });
      const reviewed = await finalizeStory(client, latest, executor);
      completed.push({ id: reviewed.id, wid: reviewed.wid, pr: reviewed.pr });
    } catch (err) {
      try {
        const latest = await callTool<Story | null>(client, "story.get", { id });
        if (latest) await blockStory(client, latest, err);
      } catch (blockErr) {
        log(`failed to block ${id}: ${blockErr instanceof Error ? blockErr.message : String(blockErr)}`);
      }
      if (opts.once && rejectOnce) rejectOnce(err);
    } finally {
      active.delete(id);
      await finishIfOnce();
    }
  };

  client.setNotificationHandler(LoggingMessageNotificationSchema, (notification) => {
    const raw = notification.params?.data;
    if (typeof raw !== "string") return;
    try {
      const event = JSON.parse(raw) as StoryLifecycleEvent;
      if (event.type === "story.event" && event.kind === "started" && event.id) {
        void processStory(event.id);
      }
    } catch {
      // Ignore unrelated logging payloads.
    }
  });

  await client.connect(transport);
  projectId = await ensureProject(client, opts);
  log(`arc-worker attached to ${projectId} using ${executor.name}`);

  const oncePromise = opts.once
    ? new Promise<ArcWorkerResult>((resolve, reject) => {
        resolveOnce = resolve;
        rejectOnce = reject;
      })
    : null;

  const existing = await callTool<Story[]>(client, "stories.list", { projectId });
  const candidates = existing.filter((s) => s.column === "in_progress" && s.worktree);
  const limit = opts.maxParallel ?? (await callTool<{ maxParallel: number }>(client, "config.get")).maxParallel;
  for (const story of candidates.slice(0, limit)) void processStory(story.id);

  if (oncePromise) return oncePromise;

  while (!closed) {
    await new Promise((resolve) => setTimeout(resolve, opts.heartbeatMs ?? 10_000));
    await callTool(client, "config.get");
  }
  return { processed: completed.length, stories: completed };
}

function getArg(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
}

const invokedAsCli = process.argv[1]?.endsWith("arc-worker.js");
if (invokedAsCli) {
  const args = process.argv.slice(2);
  const opts: ArcWorkerOptions = {
    url: getArg(args, "--url") ?? "http://127.0.0.1:7420/mcp",
    projectId: getArg(args, "--project"),
    repo: getArg(args, "--repo"),
    path: getArg(args, "--path"),
    branch: getArg(args, "--branch"),
    model: getArg(args, "--model"),
    executor: (getArg(args, "--executor") as ArcWorkerExecutorKind | undefined) ?? undefined,
    command: getArg(args, "--command"),
    mcpConfig: getArg(args, "--mcp-config"),
    allowedTools: getArg(args, "--allowedTools") ?? getArg(args, "--allowed-tools"),
    once: args.includes("--once"),
    log: (m) => console.error(m),
  };

  const run = async () => {
    if (opts.once) return runArcWorker(opts);

    let processed = 0;
    const stories: ArcWorkerResult["stories"] = [];
    for (;;) {
      try {
        const result = await runArcWorker(opts);
        processed += result.processed;
        stories.push(...result.stories);
      } catch (err) {
        console.error("arc-worker connection lost; reconnecting:", err instanceof Error ? err.message : err);
        await new Promise((resolve) => setTimeout(resolve, 2_000));
      }
    }
  };

  run()
    .then((result) => {
      console.log(JSON.stringify(result, null, 2));
      process.exit(0);
    })
    .catch((err) => {
      console.error("arc-worker failed:", err instanceof Error ? err.message : err);
      process.exit(1);
    });
}
