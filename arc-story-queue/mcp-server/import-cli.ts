import { homedir } from "node:os";
import { join } from "node:path";
import { StoryStore } from "./store.js";
import { ghListIssues, importIssuesToStore } from "./github-import.js";

/**
 * Headless GitHub-issue import — the inbound counterpart to `file-agent`.
 * Reuses the same tested logic as the daemon's github.import tool, but writes
 * directly to the persistent store so you can seed/refresh a board without
 * running the daemon or the app.
 *
 *   npm run import -- <owner/repo>
 */
const repo = process.argv[2];
if (!repo || repo.startsWith("-")) {
  console.error("usage: npm run import -- <owner/repo>");
  process.exit(1);
}

const dbPath = process.env.ARC_SQ_DB ?? join(process.env.ARC_SQ_DATA ?? join(homedir(), ".arc-story-queue"), "store.db");
const store = new StoryStore(dbPath);

try {
  const issues = ghListIssues(repo);
  const created = importIssuesToStore({ store, repo, issues });
  console.log(`Imported ${created.length} new (${issues.length} open) issue(s) from ${repo}`);
  console.log(`  -> ${dbPath}`);
  for (const s of created) console.log(`  ${s.wid}  ${s.title}`);
} catch (err) {
  console.error("import failed:", err instanceof Error ? err.message : err);
  process.exit(1);
} finally {
  store.close();
}
