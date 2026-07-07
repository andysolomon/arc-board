import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import type { Handoff, Project, RunRecord, Story } from "arc-contracts";

/**
 * Deterministic story worker.
 *
 * This is intentionally not a model process. It proves the daemon/app pipeline by
 * pulling one queued/reserved story, touching only git/filesystem through the
 * story worktree, streaming terminal-like lines, and completing with a compact
 * handoff + RunRecord. Real model-driven work is handled by a Fable session
 * (W-000008); this worker is the local no-LLM execution bridge for W-000006.
 */

export interface WorkerOptions {
  url: string;
  projectId?: string;
  repo?: string;
  path?: string;
  once?: boolean;
  log?: (message: string) => void;
  now?: () => number;
}

export interface WorkerResult {
  processed: number;
  stories: Array<{ id: string; wid: string; pr: string }>;
}

type ToolResult = { content?: Array<{ type: string; text?: string }> };

function parseToolResult<T>(result: unknown): T {
  const r = result as ToolResult;
  const text = r.content?.find((c) => c.type === "text")?.text;
  if (!text) throw new Error("No text content in tool result");
  return JSON.parse(text) as T;
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
    // Fall back to ownerless local repo id below.
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

async function callTool<T>(client: Client, name: string, args: Record<string, unknown> = {}): Promise<T> {
  const result = await client.callTool({ name, arguments: args }, CallToolResultSchema);
  return parseToolResult<T>(result);
}

async function streamLine(
  client: Client,
  story: Story,
  kind: "cmd" | "out" | "ok" | "lock" | "unlock",
  text: string
): Promise<void> {
  await callTool(client, "story.update", {
    id: story.id,
    route: "composer-implement",
    line: { kind, text },
  });
}

async function ensureProject(client: Client, opts: WorkerOptions): Promise<string> {
  if (opts.projectId) return opts.projectId;

  const cwd = resolve(opts.path ?? process.cwd());
  const repo = opts.repo ?? localRepoId(cwd);
  const session = await callTool<{ id: string }>(client, "session.register", {
    repo,
    path: cwd,
    branch: localBranch(cwd),
    model: "deterministic-worker/no-model",
    pid: process.pid,
  });
  const project = await callTool<Project>(client, "project.attach", { sessionId: session.id });
  return project.id;
}

async function pullRunnableStory(client: Client, projectId: string): Promise<Story | null> {
  const stories = await callTool<Story[]>(client, "stories.list", { projectId });
  const reserved = stories.find((s) => s.column === "in_progress" && s.worktree);
  if (reserved) return reserved;
  return callTool<Story | null>(client, "queue.next", { projectId });
}

function verificationStatus(worktree: string): string {
  const status = runGit(worktree, ["status", "--short"]);
  return status || "working tree clean";
}

async function processStory(client: Client, story: Story, now: () => number): Promise<{ id: string; wid: string; pr: string }> {
  const startedAt = now();
  const worktree = story.worktree;
  if (!worktree) throw new Error(`Story ${story.id} has no worktree; queue.next must reserve it first`);

  await streamLine(client, story, "cmd", `git -C ${worktree} status --short`);
  const before = verificationStatus(worktree);
  await streamLine(client, story, "out", before);

  const notesDir = join(worktree, ".arc-story-queue", "runs");
  mkdirSync(notesDir, { recursive: true });
  const notePath = join(notesDir, `${story.wid}.md`);
  const relativeNotePath = `.arc-story-queue/runs/${story.wid}.md`;
  const note = [
    `# ${story.wid} deterministic worker run`,
    "",
    `Story: ${story.title}`,
    `Repo: ${story.repo}`,
    `Route: composer-implement`,
    `Model: no-model`,
    "",
    "This file was written by arc-story-queue's deterministic no-LLM worker to prove the execution pipeline.",
    "",
  ].join("\n");
  writeFileSync(notePath, note);
  await streamLine(client, story, "out", `wrote ${relativeNotePath}`);

  await streamLine(client, story, "cmd", `git add ${relativeNotePath}`);
  runGit(worktree, ["add", relativeNotePath]);

  const diffNames = runGit(worktree, ["diff", "--cached", "--name-only"]);
  const changedFiles = diffNames.split("\n").filter(Boolean);

  if (changedFiles.length > 0) {
    const message = `${story.wid}: deterministic worker run`;
    await streamLine(client, story, "cmd", `git commit -m ${JSON.stringify(message)}`);
    runGit(worktree, ["commit", "-m", message]);
    await streamLine(client, story, "ok", `committed ${changedFiles.length} file(s)`);
  } else {
    await streamLine(client, story, "ok", "no changes to commit");
  }

  const after = verificationStatus(worktree);
  await streamLine(client, story, "out", after);

  const durMs = Math.max(1, now() - startedAt);
  const run: RunRecord = {
    id: `run-${story.id}-${startedAt}`,
    storyId: story.id,
    label: "deterministic worker",
    repo: story.repo,
    route: "composer-implement",
    backend: "Deterministic Worker",
    model: "no-model",
    access: "write",
    tokens: 0,
    durMs,
    status: "completed",
    changed: changedFiles.length,
    outcome: "unrated",
  };
  const handoff: Handoff = {
    status: "completed",
    summary: `Deterministic worker completed ${story.wid} without invoking a model.`,
    changes: changedFiles.length > 0 ? changedFiles : ["No file changes were required."],
    verification: ["git status --short", after],
    risks: ["Synthetic local worker does not replace model-driven implementation."],
    next_actions: ["Review the generated worktree commit and replace with Fable-driven work when ready."],
  };
  const pr = story.pr ?? `local://arc-story-queue/${encodeURIComponent(story.wid)}`;

  await callTool(client, "story.complete", {
    id: story.id,
    handoff,
    pr,
    runs: [run],
    outcome: "accepted",
  });
  await streamLine(client, story, "ok", `completed ${story.wid} → review`);
  return { id: story.id, wid: story.wid, pr };
}

/** Pull and process stories. Defaults to a single story, because operators run this as a bridge. */
export async function runWorker(opts: WorkerOptions): Promise<WorkerResult> {
  const log = opts.log ?? (() => undefined);
  const now = opts.now ?? Date.now;
  const transport = new StreamableHTTPClientTransport(new URL(opts.url));
  const client = new Client({ name: "story-queue-worker", version: "0.1.0" });
  await client.connect(transport);

  try {
    const projectId = await ensureProject(client, opts);
    const processed: WorkerResult["stories"] = [];
    do {
      const story = await pullRunnableStory(client, projectId);
      if (!story) {
        log("No queued or reserved story available.");
        break;
      }
      log(`processing ${story.wid} ${story.title}`);
      processed.push(await processStory(client, story, now));
    } while (opts.once === false);

    return { processed: processed.length, stories: processed };
  } finally {
    await client.close();
  }
}

// CLI: node mcp-server/dist/worker.js [--url <u>] [--project <id>] [--repo <owner/name>] [--path <repo>] [--loop]
const invokedAsCli = process.argv[1]?.endsWith("worker.js");
if (invokedAsCli) {
  const args = process.argv.slice(2);
  const get = (flag: string) => {
    const i = args.indexOf(flag);
    return i >= 0 ? args[i + 1] : undefined;
  };

  runWorker({
    url: get("--url") ?? "http://127.0.0.1:7420/mcp",
    projectId: get("--project"),
    repo: get("--repo"),
    path: get("--path"),
    once: !args.includes("--loop"),
    log: (m) => console.log(m),
  })
    .then((result) => {
      console.log(`Done. Processed ${result.processed} story(s).`);
      process.exit(0);
    })
    .catch((err) => {
      console.error("worker failed:", err instanceof Error ? err.message : err);
      process.exit(1);
    });
}
