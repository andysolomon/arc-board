# Monitoring the arc-story-queue daemon

A small, **read-only** live monitor that connects to the daemon as an MCP client and
prints every board event as it happens — column moves, per-route stream lines, and a
periodic snapshot of which stories sit in each column. It never mutates the board, so
it's safe to run alongside the desktop app, the `arc-worker`, and live Claude Code
sessions.

Use it to watch the autonomous loop (drag → In Progress → `claude -p` → Review) drive
itself, or to debug why a story isn't moving.

## How it works

The daemon fans every `story.update` / `story.event` out to **all** connected MCP
clients as MCP logging notifications (`notifications/message`, via
`sendLoggingMessage` in `mcp-server/sse.ts`). The monitor is just another MCP client:

1. Connects over `StreamableHTTPClientTransport` to the daemon's HTTP endpoint.
2. Registers a `fallbackNotificationHandler` to catch those broadcasts and pretty-print them.
3. Calls `setLoggingLevel("info")` so the daemon streams the info-level channel the broadcasts ride on.
4. Every 5s calls `stories.list` and prints a one-line board snapshot **only when the column layout changed** (so the log stays quiet when idle).

Script: [`arc-story-queue/scripts/mcp-monitor.mjs`](../arc-story-queue/scripts/mcp-monitor.mjs)

## Prerequisites

The daemon must be running first (it serves the MCP endpoint the monitor connects to):

```bash
cd arc-story-queue
npm run daemon        # MCP server at http://127.0.0.1:7420/mcp
```

## Run the monitor

In a **separate** terminal:

```bash
cd arc-story-queue
node scripts/mcp-monitor.mjs
```

Point it at a non-default daemon with `MCP_URL`:

```bash
MCP_URL=http://127.0.0.1:7420/mcp node scripts/mcp-monitor.mjs
```

## Reading the output

```
14:04:07 ✅ connected to http://127.0.0.1:7420/mcp — watching broadcasts
14:04:07 📊 queued:[—] in_progress:[W-000007] review:[W-000009] done:[—]
14:05:12 🔔 event  started W-000007 — Orchestrator imports arc-contracts → in_progress
14:05:14 📡 update W-000007 (composer-implement) [composer-implement:running] cmd> claude -p <story prompt> ...
14:05:31 📡 update W-000007 (codex-check) [codex-check:done] ok> verification complete
14:05:32 🔔 event  review W-000007 → review
14:05:32 📊 queued:[—] in_progress:[—] review:[W-000007, W-000009] done:[—]
```

| Marker | Meaning |
| --- | --- |
| `✅ connected` | MCP session established with the daemon |
| `📊` snapshot | Current stories per column (printed only when the layout changes) |
| `🔔 event` | A `story.event` lifecycle change — `started`, `review`, `merged`, etc., with the target column |
| `📡 update` | A `story.update` — a streamed lane line (`cmd`/`out`/`ok`) plus the route and lane status |
| `⚠️ snapshot failed` | `stories.list` errored (usually the daemon restarted — the monitor keeps trying) |

## Stopping it

`Ctrl-C` (SIGINT) — it closes the MCP session cleanly and exits. If you launched it in
the background, find and kill it:

```bash
ps aux | grep mcp-monitor.mjs | grep -v grep   # note the PID
kill <PID>
```

## Notes & gotchas

- **Read-only.** The monitor only calls `stories.list` and consumes broadcasts — it never
  reserves, moves, or merges anything. Run as many as you like.
- **Daemon restart.** The monitor auto-recovers snapshots after a daemon restart, but the
  broadcast subscription rides on the original MCP session — if the daemon fully restarts,
  restart the monitor to re-subscribe to the event stream.
- **ESM SDK resolution.** The script resolves `@modelcontextprotocol/sdk` from the workspace
  install (deps are hoisted to `arc-story-queue/node_modules`). Run it with the repo's Node;
  no separate `npm install` is needed.
- **Related tooling.** The `arc-worker` (`mcp-server/arc-worker.ts`) subscribes to the same
  `started` broadcasts to *drive* execution; this monitor is the passive, observe-only
  counterpart.
