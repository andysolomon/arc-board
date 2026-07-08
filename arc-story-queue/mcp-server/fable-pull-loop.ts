import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import type { AnnotateOutcome, Handoff, Project, RunRecord, Story } from "arc-contracts";

/**
 * Fable pull-loop glue.
 *
 * This client does only deterministic queue plumbing for a live Fable/Claude Code
 * session: register the current session, attach its cwd as a project, reserve the
 * next story, and provide helper calls for streaming/completion. It does not run
 * a model; Fable performs all implementation/planning/delegation work in the
 * live session and reports progress back through the daemon.
 */

export interface FablePullLoopOptions {
  url: string;
  path?: string;
  repo?: string;
  branch?: string;
  model?: string;
  pid?: number;
  projectId?: string;
  log?: (message: string) => void;
}

export interface FableAssignment {
  project: Project | { id: string };
  story: Story | null;
  prompt: string;
}

export interface FableUpdateOptions {
  url: string;
  id: string;
  route?: string;
  kind?: "cmd" | "out" | "ok" | "lock" | "unlock";
  text: string;
  laneStatus?: "running" | "done";
}

export interface FableCompleteOptions {
  url: string;
  id: string;
  handoff: Handoff;
  pr: string;
  runs: RunRecord[];
  outcome?: AnnotateOutcome;
}

type ToolResult = { content?: Array<{ type: string; text?: string }>; isError?: boolean };

function parseToolResult<T>(result: unknown): T {
  const r = result as ToolResult;
  const text = r.content?.find((c) => c.type === "text")?.text;
  if (r.isError) throw new Error(text ?? "MCP tool returned an error");
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
    // No origin remote; use a stable local id for development fixtures.
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

async function withClient<T>(url: string, fn: (client: Client) => Promise<T>): Promise<T> {
  const transport = new StreamableHTTPClientTransport(new URL(url));
  const client = new Client({ name: "fable-pull-loop", version: "0.1.0" });
  await client.connect(transport);
  try {
    return await fn(client);
  } finally {
    await client.close();
  }
}

async function callTool<T>(client: Client, name: string, args: Record<string, unknown> = {}): Promise<T> {
  const result = await client.callTool({ name, arguments: args }, CallToolResultSchema);
  return parseToolResult<T>(result);
}

function buildPrompt(project: Project | { id: string }, story: Story | null, url: string): string {
  if (!story) {
    return [
      "# Fable pull loop",
      "",
      `Project: ${project.id}`,
      "No queued story was available. Leave the daemon idle and try again after new filed stories enter Queued.",
    ].join("\n");
  }

  const criteria = story.criteria.length > 0
    ? story.criteria.map((c) => `- ${c}`).join("\n")
    : "- unknown: story has no acceptance criteria";
  const plan = story.plan?.tasks?.length
    ? story.plan.tasks.map((task, i) => `${i + 1}. ${task}`).join("\n")
    : "unknown: no persisted plan; create one in-session before coding if needed";

  return [
    "# Fable story-queue pull loop assignment",
    "",
    `MCP daemon: ${url}`,
    `Project: ${project.id}`,
    `Story: ${story.wid} — ${story.title}`,
    `Repo: ${story.repo}`,
    `Worktree: ${story.worktree}`,
    `Branch: ${story.branch}`,
    `Issue: ${story.issue ?? "unknown"}`,
    "",
    "## Invariant",
    "All model work happens in this live Fable/Claude Code session. The daemon only records deterministic state.",
    "",
    "## Acceptance criteria",
    criteria,
    "",
    "## Current plan",
    plan,
    "",
    "## Required loop",
    "1. Work from the returned worktree (or delegate workers into that worktree).",
    "2. Before meaningful shell/file operations, stream a terminal line with `story.update`.",
    "3. Keep route ids explicit: `fable` for orchestration, write route for implementation, read-only routes for explore/check.",
    "4. When implementation is ready, open or attach a PR, then call `story.complete` with a strict handoff and run records.",
    "",
    "## Direct MCP calls if not using the helper CLI",
    `- story.update: { id: ${JSON.stringify(story.id)}, route: \"fable\", line: { kind: \"out\", text: \"...\" } }`,
    `- story.complete: { id: ${JSON.stringify(story.id)}, handoff, pr, runs, outcome: \"accepted\" }`,
  ].join("\n");
}

/** Register/attach the current Fable session and reserve the next queued story. */
export async function runFablePullLoop(opts: FablePullLoopOptions): Promise<FableAssignment> {
  const log = opts.log ?? (() => undefined);
  const cwd = resolve(opts.path ?? process.cwd());

  return withClient(opts.url, async (client) => {
    let project: Project | { id: string };
    if (opts.projectId) {
      project = { id: opts.projectId };
      log(`using existing project ${opts.projectId}`);
    } else {
      const session = await callTool<{ id: string }>(client, "session.register", {
        repo: opts.repo ?? localRepoId(cwd),
        path: cwd,
        branch: opts.branch ?? localBranch(cwd),
        model: opts.model ?? "fable-live-session",
        pid: opts.pid ?? process.pid,
      });
      project = await callTool<Project>(client, "project.attach", { sessionId: session.id });
      log(`attached ${project.id}`);
    }

    const story = await callTool<Story | null>(client, "queue.next", { projectId: project.id });
    if (story) {
      log(`pulled ${story.wid} ${story.title}`);
      await callTool(client, "story.update", {
        id: story.id,
        route: "fable",
        line: { kind: "out", text: `Fable pulled ${story.wid}; preparing model-driven implementation` },
      });
    } else {
      log("no queued story available");
    }

    return { project, story, prompt: buildPrompt(project, story, opts.url) };
  });
}

/** Stream one progress line from a live Fable session. */
export async function streamFableUpdate(opts: FableUpdateOptions): Promise<{ ok: true }> {
  const route = opts.route ?? "fable";
  return withClient(opts.url, async (client) =>
    callTool<{ ok: true }>(client, "story.update", {
      id: opts.id,
      route,
      line: { kind: opts.kind ?? "out", text: opts.text },
      lane: opts.laneStatus ? { route, status: opts.laneStatus } : undefined,
    })
  );
}

/** Complete a story with the structured handoff produced by the live Fable session. */
export async function completeFableStory(opts: FableCompleteOptions): Promise<{ ok: true }> {
  return withClient(opts.url, async (client) =>
    callTool<{ ok: true }>(client, "story.complete", {
      id: opts.id,
      handoff: opts.handoff,
      pr: opts.pr,
      runs: opts.runs,
      outcome: opts.outcome ?? "accepted",
    })
  );
}

function getArg(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
}

function readJsonFile<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

// CLI:
//   node dist/fable-pull-loop.js pull [--url <u>] [--repo <owner/name>] [--path <repo>] [--model <id>]
//   node dist/fable-pull-loop.js update --id <story> --line <text> [--route fable] [--kind out]
//   node dist/fable-pull-loop.js complete --id <story> --handoff handoff.json --runs runs.json --pr <url>
const invokedAsCli = process.argv[1]?.endsWith("fable-pull-loop.js");
if (invokedAsCli) {
  const [command = "pull", ...args] = process.argv.slice(2);
  const url = getArg(args, "--url") ?? "http://127.0.0.1:7420/mcp";

  const main = async () => {
    if (command === "pull") {
      const assignment = await runFablePullLoop({
        url,
        repo: getArg(args, "--repo"),
        path: getArg(args, "--path"),
        branch: getArg(args, "--branch"),
        model: getArg(args, "--model"),
        projectId: getArg(args, "--project"),
        log: (m) => console.error(m),
      });
      console.log(JSON.stringify(assignment, null, 2));
      return;
    }

    if (command === "update") {
      const id = getArg(args, "--id");
      const text = getArg(args, "--line") ?? getArg(args, "--text");
      if (!id || !text) throw new Error("update requires --id and --line");
      await streamFableUpdate({
        url,
        id,
        text,
        route: getArg(args, "--route"),
        kind: getArg(args, "--kind") as FableUpdateOptions["kind"] | undefined,
        laneStatus: getArg(args, "--lane-status") as FableUpdateOptions["laneStatus"] | undefined,
      });
      console.log(JSON.stringify({ ok: true }));
      return;
    }

    if (command === "complete") {
      const id = getArg(args, "--id");
      const pr = getArg(args, "--pr");
      const handoffPath = getArg(args, "--handoff");
      const runsPath = getArg(args, "--runs");
      if (!id || !pr || !handoffPath || !runsPath) {
        throw new Error("complete requires --id, --pr, --handoff, and --runs");
      }
      await completeFableStory({
        url,
        id,
        pr,
        handoff: readJsonFile<Handoff>(handoffPath),
        runs: readJsonFile<RunRecord[]>(runsPath),
        outcome: (getArg(args, "--outcome") as AnnotateOutcome | undefined) ?? "accepted",
      });
      console.log(JSON.stringify({ ok: true }));
      return;
    }

    throw new Error(`Unknown command: ${command}`);
  };

  main().catch((err) => {
    console.error("fable-pull-loop failed:", err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
