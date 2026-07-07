import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Story } from "arc-contracts";
import { startDaemon, type DaemonHandle } from "../mcp-server/dist/server.js";
import { buildIssueBody, runFileAgent, type IssueCreator } from "../mcp-server/dist/file-agent.js";

const TEST_PORT = 7429;
const url = `http://127.0.0.1:${TEST_PORT}/mcp`;
const repoId = "acme/api";

function draftStory(id: string, wid: string): Story {
  return {
    id,
    wid,
    type: "story",
    title: `Draft ${id}`,
    repo: repoId,
    branch: `draft/${id}`,
    worktree: "",
    column: "backlog",
    priority: "med",
    size: "S",
    epic: "",
    taskClass: "feature",
    tags: [],
    description: "Do the thing",
    criteria: ["thing works", "tests pass"],
    draft: true,
    issue: null,
  };
}

describe("file-agent (filing bridge)", () => {
  let daemon: DaemonHandle;
  let fixtureDir: string;

  beforeAll(async () => {
    fixtureDir = mkdtempSync(join(tmpdir(), "arc-file-agent-"));
    execFileSync("git", ["init"], { cwd: fixtureDir });
    execFileSync("git", ["config", "user.email", "t@e.com"], { cwd: fixtureDir });
    execFileSync("git", ["config", "user.name", "T"], { cwd: fixtureDir });
    writeFileSync(join(fixtureDir, "README.md"), "# fixture\n");
    execFileSync("git", ["add", "."], { cwd: fixtureDir });
    execFileSync("git", ["commit", "-m", "init"], { cwd: fixtureDir });

    daemon = await startDaemon({
      port: TEST_PORT,
      host: "127.0.0.1",
      dbPath: join(fixtureDir, "test.db"),
      worktreeRoot: join(fixtureDir, "wt"),
      maxParallel: 2,
    });
  }, 60_000);

  afterAll(async () => {
    await daemon.close();
    if (fixtureDir && existsSync(fixtureDir)) rmSync(fixtureDir, { recursive: true, force: true });
  }, 60_000);

  it("buildIssueBody templates description + criteria deterministically", () => {
    const body = buildIssueBody(draftStory("b", "W-000009"));
    expect(body).toContain("Do the thing");
    expect(body).toContain("Acceptance criteria");
    expect(body).toContain("- [ ] thing works");
    expect(body).toContain("W-000009");
  });

  it("drains only file-requested drafts, creates issues, and files them", async () => {
    // one requested, one not
    daemon.store.upsertStory(draftStory("a", "W-000001"));
    daemon.store.upsertStory(draftStory("b", "W-000002"));
    await daemon.queue.requestFile("a");

    const calls: Array<{ repo: string; title: string }> = [];
    const fakeGh: IssueCreator = async ({ repo, title }) => {
      calls.push({ repo, title });
      return { number: 42, url: `https://github.com/${repo}/issues/42` };
    };

    const filed = await runFileAgent({ url, createIssue: fakeGh });

    expect(calls).toEqual([{ repo: repoId, title: "Draft a" }]);
    expect(filed.map((f) => f.id)).toEqual(["a"]);

    const a = daemon.store.getStory("a");
    expect(a?.draft).toBe(false);
    expect(a?.issue).toBe(`https://github.com/${repoId}/issues/42`);
    // 'b' was never requested → untouched
    expect(daemon.store.getStory("b")?.draft).toBe(true);
    // pull queue drained
    expect(daemon.queue.filePending().map((s) => s.id)).not.toContain("a");
  });

  it("dry-run reports without filing", async () => {
    daemon.store.upsertStory(draftStory("c", "W-000003"));
    await daemon.queue.requestFile("c");

    let created = 0;
    const filed = await runFileAgent({
      url,
      dryRun: true,
      createIssue: async () => {
        created += 1;
        return { number: 1, url: "x" };
      },
    });

    expect(created).toBe(0);
    expect(filed).toHaveLength(0);
    expect(daemon.store.getStory("c")?.draft).toBe(true);
    expect(daemon.queue.filePending().map((s) => s.id)).toContain("c");
  });
});
