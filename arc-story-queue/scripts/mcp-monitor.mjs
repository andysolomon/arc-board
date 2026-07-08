// Passive live monitor for the arc-story-queue daemon.
//
// Connects as an MCP client, receives every story.update / story.event broadcast
// (fan-out via sendLoggingMessage), and snapshots queue state on an interval.
// Read-only: it never mutates the board — safe to run alongside the app, the
// arc-worker, and live Claude Code sessions.
//
// Usage:
//   node arc-story-queue/scripts/mcp-monitor.mjs
//   MCP_URL=http://127.0.0.1:7420/mcp node arc-story-queue/scripts/mcp-monitor.mjs
//
// Requires the daemon (`npm run daemon`) to be running first.

import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

// Resolve the MCP SDK from the workspace install (deps are hoisted to
// arc-story-queue/node_modules by Bun/npm workspaces). Resolve each entry point
// directly so this works regardless of where the script is invoked from and
// regardless of which build (cjs/esm) the package's exports map points at.
const require_ = createRequire(import.meta.url);
const load = (subpath) => import(pathToFileURL(require_.resolve(subpath)).href);
const { Client } = await load("@modelcontextprotocol/sdk/client/index.js");
const { StreamableHTTPClientTransport } = await load("@modelcontextprotocol/sdk/client/streamableHttp.js");
const { CallToolResultSchema } = await load("@modelcontextprotocol/sdk/types.js");

const URL_ = process.env.MCP_URL ?? "http://127.0.0.1:7420/mcp";
const ts = () => new Date().toISOString().slice(11, 19);

function parse(result) {
  const text = result?.content?.find((c) => c.type === "text")?.text;
  return text ? JSON.parse(text) : null;
}

const transport = new StreamableHTTPClientTransport(new URL(URL_));
const client = new Client({ name: "arc-live-monitor", version: "0.1.0" });

// Catch every server-initiated notification (logging messages carry the broadcasts).
client.fallbackNotificationHandler = async (n) => {
  try {
    if (n.method === "notifications/message") {
      const data = n.params?.data;
      const evt = typeof data === "string" ? JSON.parse(data) : data;
      if (evt?.type === "story.update") {
        const lane = evt.lane ? ` [${evt.lane.route}:${evt.lane.status}]` : "";
        const line = evt.line ? ` ${evt.line.kind}> ${evt.line.text}` : "";
        console.log(`${ts()} 📡 update ${evt.id} (${evt.route})${lane}${line}`);
      } else if (evt?.type === "story.event") {
        console.log(`${ts()} 🔔 event  ${evt.kind} ${evt.wid ?? evt.id}${evt.title ? ` — ${evt.title}` : ""}${evt.column ? ` → ${evt.column}` : ""}`);
      } else {
        console.log(`${ts()} · ${JSON.stringify(evt)}`);
      }
    } else {
      console.log(`${ts()} · ${n.method}`);
    }
  } catch {
    console.log(`${ts()} · (unparsed notification) ${JSON.stringify(n.params ?? {})}`);
  }
};

await client.connect(transport);
console.log(`${ts()} ✅ connected to ${URL_} — watching broadcasts`);

// Ask the server to send info-level logging (the channel the broadcasts ride on).
try { await client.setLoggingLevel?.("info"); } catch {}

// Initial + periodic state snapshot so we see the board, not just deltas.
let lastSig = "";
async function snapshot() {
  try {
    const res = await client.callTool({ name: "stories.list", arguments: {} }, CallToolResultSchema);
    const q = parse(res) ?? [];
    const sig = JSON.stringify(q.map((s) => [s.wid, s.column]));
    if (sig !== lastSig) {
      lastSig = sig;
      const by = (c) => q.filter((s) => s.column === c).map((s) => s.wid).join(", ") || "—";
      console.log(`${ts()} 📊 queued:[${by("queued")}] in_progress:[${by("in_progress")}] review:[${by("review")}] done:[${by("done")}]`);
    }
  } catch (e) {
    console.log(`${ts()} ⚠️ snapshot failed: ${e?.message ?? e}`);
  }
}
await snapshot();
setInterval(snapshot, 5000);

process.on("SIGTERM", async () => { try { await client.close(); } catch {} process.exit(0); });
process.on("SIGINT", async () => { try { await client.close(); } catch {} process.exit(0); });
