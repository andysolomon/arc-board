import { execFileSync } from "node:child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import type { Story } from "arc-contracts";

/**
 * Filing agent — the deterministic bridge that completes the GitHub filing flow.
 * It drains the daemon's file.pending pull-queue, creates a real GitHub issue per
 * draft via `gh`, and calls story.file with the issue URL. This is NOT a model
 * process: the issue body is templated from the story (like intake.draft), so it
 * upholds "the daemon never runs a model" while still living outside the daemon.
 * A live Fable session can run this same tool, or it can run standalone.
 */

export interface IssueRef {
  number: number;
  url: string;
}

export type IssueCreator = (input: { repo: string; title: string; body: string }) => Promise<IssueRef>;

export interface FileAgentOptions {
  url: string;
  projectId?: string;
  createIssue?: IssueCreator;
  dryRun?: boolean;
  log?: (message: string) => void;
}

export interface FiledResult {
  id: string;
  wid: string;
  issue: string;
}

function parseToolResult<T>(result: unknown): T {
  const r = result as { content?: Array<{ type: string; text?: string }> };
  const text = r.content?.find((c) => c.type === "text")?.text;
  if (!text) throw new Error("No text content in tool result");
  return JSON.parse(text) as T;
}

/** Template a GitHub issue body from a draft story — deterministic, no model. */
export function buildIssueBody(story: Story): string {
  const lines: string[] = [];
  if (story.description) lines.push(story.description, "");
  if (story.criteria.length > 0) {
    lines.push("### Acceptance criteria");
    for (const c of story.criteria) lines.push(`- [ ] ${c}`);
    lines.push("");
  }
  if (story.bug) {
    lines.push(`### Bug (${story.bug.severity})`, `Area: ${story.bug.area}`, "");
    if (story.bug.steps.length > 0) {
      lines.push("Steps:");
      for (const s of story.bug.steps) lines.push(`1. ${s}`);
      lines.push("");
    }
  }
  lines.push(`_Filed from arc-story-queue · ${story.wid} · ${story.taskClass}_`);
  return lines.join("\n");
}

/** Default issue creator: shells out to the authenticated `gh` CLI. */
export const ghCreateIssue: IssueCreator = async ({ repo, title, body }) => {
  const out = execFileSync(
    "gh",
    ["issue", "create", "--repo", repo, "--title", title, "--body", body],
    { encoding: "utf8" }
  );
  const url = out.trim().split("\n").filter(Boolean).pop() ?? "";
  const m = url.match(/\/issues\/(\d+)/);
  if (!m) throw new Error(`Could not parse issue URL from gh output: ${out}`);
  return { number: Number(m[1]), url };
};

/** Drain file.pending → create an issue per draft → story.file. Returns what was filed. */
export async function runFileAgent(opts: FileAgentOptions): Promise<FiledResult[]> {
  const createIssue = opts.createIssue ?? ghCreateIssue;
  const log = opts.log ?? (() => undefined);

  const transport = new StreamableHTTPClientTransport(new URL(opts.url));
  const client = new Client({ name: "file-agent", version: "0.1.0" });
  await client.connect(transport);

  try {
    const pendingResult = await client.callTool(
      { name: "file.pending", arguments: opts.projectId ? { projectId: opts.projectId } : {} },
      CallToolResultSchema
    );
    const pending = parseToolResult<Story[]>(pendingResult);
    log(`${pending.length} draft(s) awaiting filing`);

    const filed: FiledResult[] = [];
    for (const story of pending) {
      const body = buildIssueBody(story);
      if (opts.dryRun) {
        log(`[dry-run] would file ${story.wid} "${story.title}" to ${story.repo}`);
        continue;
      }
      const ref = await createIssue({ repo: story.repo, title: story.title, body });
      await client.callTool(
        { name: "story.file", arguments: { id: story.id, issue: ref.url } },
        CallToolResultSchema
      );
      log(`filed ${story.wid} → ${ref.url}`);
      filed.push({ id: story.id, wid: story.wid, issue: ref.url });
    }
    return filed;
  } finally {
    await client.close();
  }
}

// CLI: node mcp-server/dist/file-agent.js [--url <u>] [--project <id>] [--dry-run]
const invokedAsCli = process.argv[1]?.endsWith("file-agent.js");
if (invokedAsCli) {
  const args = process.argv.slice(2);
  const get = (flag: string) => {
    const i = args.indexOf(flag);
    return i >= 0 ? args[i + 1] : undefined;
  };
  runFileAgent({
    url: get("--url") ?? "http://127.0.0.1:7420/mcp",
    projectId: get("--project"),
    dryRun: args.includes("--dry-run"),
    log: (m) => console.log(m),
  })
    .then((filed) => {
      console.log(`Done. Filed ${filed.length} draft(s).`);
      process.exit(0);
    })
    .catch((err) => {
      console.error("file-agent failed:", err instanceof Error ? err.message : err);
      process.exit(1);
    });
}
