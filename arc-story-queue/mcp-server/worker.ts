import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { Access, Handoff, Project, RouteId, RunRecord, Story } from "arc-contracts";
import { callTool, createDaemonClient, localBranch, localRepoId, runGit } from "./daemon-client.js";

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

async function streamLine(
  client: Client,
  story: Story,
  route: RouteId,
  kind: "cmd" | "out" | "ok" | "lock" | "unlock",
  text: string,
  status: "running" | "done" = "running"
): Promise<void> {
  await callTool(client, "story.update", {
    id: story.id,
    route,
    line: { kind, text },
    lane: { route, status },
  });
}

function runRecord(args: {
  story: Story;
  route: RouteId;
  label: string;
  access: Access;
  changed: number;
  durMs: number;
  outcome?: "accepted" | "escalated" | "rejected" | "unrated";
}): RunRecord {
  return {
    id: `run-${args.story.id}-${args.route}-${Date.now()}`,
    storyId: args.story.id,
    label: args.label,
    repo: args.story.repo,
    route: args.route,
    backend: "Deterministic Worker",
    model: "no-model",
    access: args.access,
    tokens: 0,
    durMs: args.durMs,
    status: "completed",
    changed: args.changed,
    outcome: args.outcome ?? "unrated",
  };
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

  await streamLine(client, story, "codex-explore", "out", `reading contract for ${story.wid}`);
  await streamLine(client, story, "composer-implement", "lock", `⚿ write-lock held for ${worktree}`);
  await streamLine(client, story, "codex-check", "out", "standing by for changed files");

  await streamLine(client, story, "composer-implement", "cmd", `git -C ${worktree} status --short`);
  const before = verificationStatus(worktree);
  await streamLine(client, story, "composer-implement", "out", before);
  await streamLine(client, story, "codex-explore", "ok", "repo shape and acceptance criteria mapped", "done");

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
  await streamLine(client, story, "composer-implement", "out", `wrote ${relativeNotePath}`);

  await streamLine(client, story, "composer-implement", "cmd", `git add ${relativeNotePath}`);
  runGit(worktree, ["add", relativeNotePath]);

  const diffNames = runGit(worktree, ["diff", "--cached", "--name-only"]);
  const changedFiles = diffNames.split("\n").filter(Boolean);
  await streamLine(client, story, "codex-check", "cmd", "git diff --cached --name-only");
  await streamLine(client, story, "codex-check", "out", changedFiles.join("\n") || "no staged files");

  if (changedFiles.length > 0) {
    const message = `${story.wid}: deterministic worker run`;
    await streamLine(client, story, "composer-implement", "cmd", `git commit -m ${JSON.stringify(message)}`);
    runGit(worktree, ["commit", "-m", message]);
    await streamLine(client, story, "composer-implement", "ok", `committed ${changedFiles.length} file(s)`, "done");
  } else {
    await streamLine(client, story, "composer-implement", "ok", "no changes to commit", "done");
  }

  const after = verificationStatus(worktree);
  await streamLine(client, story, "codex-check", "out", after);
  await streamLine(client, story, "codex-check", "ok", "verification lane complete", "done");

  const durMs = Math.max(1, now() - startedAt);
  const runs: RunRecord[] = [
    runRecord({ story, route: "codex-explore", label: "deterministic explore", access: "read-only", changed: 0, durMs }),
    runRecord({ story, route: "composer-implement", label: "deterministic write", access: "write", changed: changedFiles.length, durMs }),
    runRecord({ story, route: "codex-check", label: "deterministic check", access: "read-only", changed: 0, durMs }),
  ];
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
    runs,
    outcome: "accepted",
  });
  return { id: story.id, wid: story.wid, pr };
}

/** Pull and process stories. Defaults to a single story, because operators run this as a bridge. */
export async function runWorker(opts: WorkerOptions): Promise<WorkerResult> {
  const log = opts.log ?? (() => undefined);
  const now = opts.now ?? Date.now;
  const { client, transport } = createDaemonClient(opts.url, { name: "story-queue-worker" });
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
