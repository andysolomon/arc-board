import { execFileSync } from "node:child_process";
import { basename, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";

/**
 * Shared daemon client plumbing.
 *
 * The deterministic worker, arc-worker, Fable pull-loop, and file-agent are all
 * thin MCP clients of the story-queue daemon. They differ in *intent* (what tools
 * they call and why) but share the same mechanical concerns: opening a Streamable
 * HTTP transport, parsing tool results (including `isError`), and deriving the
 * local repo identity from git. Those concerns live here once so each adapter
 * keeps only its behavior-specific logic.
 *
 * Executor-specific behavior (streaming shapes, prompts, git commit flows) stays
 * in the adapters — this module is deliberately intent-agnostic.
 */

export type ToolResult = { content?: Array<{ type: string; text?: string }>; isError?: boolean };

/**
 * Parse the JSON text payload out of an MCP tool result. Throws an actionable
 * error when the daemon reports `isError` or returns no text content.
 */
export function parseToolResult<T>(result: unknown): T {
  const r = result as ToolResult;
  const text = r.content?.find((c) => c.type === "text")?.text;
  if (r.isError) throw new Error(text ?? "MCP tool returned an error");
  if (!text) throw new Error("No text content in tool result");
  return JSON.parse(text) as T;
}

/** Call a daemon tool and return its parsed JSON payload. */
export async function callTool<T>(
  client: Client,
  name: string,
  args: Record<string, unknown> = {}
): Promise<T> {
  const result = await client.callTool({ name, arguments: args }, CallToolResultSchema);
  return parseToolResult<T>(result);
}

/** Run a git command in `cwd` and return its trimmed stdout. */
export function runGit(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

/**
 * Derive an `owner/name` repo id from the origin remote, falling back to a stable
 * ownerless `local/<dir>` id when no origin remote is configured.
 */
export function localRepoId(cwd: string): string {
  try {
    const remote = runGit(cwd, ["remote", "get-url", "origin"]);
    const match = remote.match(/[:/]([^/:]+\/[^/]+?)(?:\.git)?$/);
    if (match) return match[1];
  } catch {
    // Fall back to an ownerless local repo id below.
  }
  return `local/${basename(resolve(cwd))}`;
}

/** Current branch name, defaulting to `main` when it cannot be determined. */
export function localBranch(cwd: string): string {
  try {
    return runGit(cwd, ["branch", "--show-current"]) || "main";
  } catch {
    return "main";
  }
}

export interface DaemonClientInfo {
  /** MCP client name reported to the daemon (identifies the adapter). */
  name: string;
  /** Optional client version; defaults to "0.1.0". */
  version?: string;
}

/**
 * Create a not-yet-connected MCP client + transport for the daemon URL. Use this
 * when the caller needs to register notification handlers before connecting or
 * manage the client lifecycle itself (e.g. a long-lived worker); otherwise prefer
 * {@link withDaemonClient}.
 */
export function createDaemonClient(
  url: string,
  info: DaemonClientInfo
): { client: Client; transport: StreamableHTTPClientTransport } {
  const transport = new StreamableHTTPClientTransport(new URL(url));
  const client = new Client({ name: info.name, version: info.version ?? "0.1.0" });
  return { client, transport };
}

/** Connect a daemon client, run `fn`, and always close the client afterwards. */
export async function withDaemonClient<T>(
  url: string,
  info: DaemonClientInfo,
  fn: (client: Client) => Promise<T>
): Promise<T> {
  const { client, transport } = createDaemonClient(url, info);
  await client.connect(transport);
  try {
    return await fn(client);
  } finally {
    await client.close();
  }
}
