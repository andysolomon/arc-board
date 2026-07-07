#!/usr/bin/env node
export { startDaemon, type DaemonHandle, type DaemonOptions } from "./server.js";

import { homedir } from "node:os";
import { join } from "node:path";
import { startDaemon } from "./server.js";

// Persist to a real SQLite file so the board survives daemon restarts.
// Override with ARC_SQ_DATA (dir) or the individual ARC_SQ_* env vars.
const dataDir = process.env.ARC_SQ_DATA ?? join(homedir(), ".arc-story-queue");

startDaemon({
  dbPath: process.env.ARC_SQ_DB ?? join(dataDir, "store.db"),
  worktreeRoot: process.env.ARC_SQ_WORKTREES ?? join(dataDir, "worktrees"),
  port: process.env.ARC_SQ_PORT ? Number(process.env.ARC_SQ_PORT) : undefined,
}).then((daemon) => {
  console.log(`arc-story-queue daemon listening on http://127.0.0.1:${daemon.port}/mcp`);
  console.log(`  data dir: ${dataDir}`);
});
