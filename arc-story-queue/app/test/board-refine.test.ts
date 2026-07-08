import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BoardStore } from "../src/lib/boardStore";
import { startDaemon, type DaemonHandle } from "../../mcp-server/dist/server.js";

const TEST_PORT = 7432;
const repoId = "test/board-refine";

describe("board story refine actions", () => {
  let daemon: DaemonHandle;
  let store: BoardStore;
  let fixtureDir: string;

  beforeAll(async () => {
    fixtureDir = mkdtempSync(join(tmpdir(), "arc-board-refine-"));
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

    store = new BoardStore(`http://127.0.0.1:${TEST_PORT}/mcp`, { modelComplete: null });
    await store.connect();
    await store.registerAndAttach({
      repo: repoId,
      path: fixtureDir,
      branch: "main",
      model: "vitest",
      pid: process.pid,
    });
  }, 60_000);

  afterAll(async () => {
    await store.close();
    await daemon.close();
    if (fixtureDir && existsSync(fixtureDir)) rmSync(fixtureDir, { recursive: true, force: true });
  }, 60_000);

  it("splits a backlog story with the deterministic fallback and persists a child draft", async () => {
    const story = await store.createDraftNow({
      kind: "feature",
      title: "Refine a large checkout story",
      description: "As a shopper, I want checkout improvements so that buying is faster.",
    });
    const before = store.storiesByColumn("backlog").length;

    const result = await store.refineStory(story.id, "split");

    expect(result.source).toBe("fallback");
    expect(result.note).toMatch(/Fallback used/i);
    expect(result.children).toHaveLength(1);
    expect(result.story.title).toMatch(/part 1/i);
    expect(result.children[0]).toMatchObject({ column: "backlog", draft: true, issue: null });
    expect(store.storiesByColumn("backlog").length).toBe(before + 1);
  });

  it("dedupe fallback reports overlaps without deleting stories", async () => {
    const original = await store.createDraftNow({
      kind: "feature",
      title: "Find duplicate reports",
      description: "Users need duplicate report detection.",
    });
    await store.createDraftNow({
      kind: "feature",
      title: "Find duplicate reports",
      description: "Same request from another intake path.",
    });
    const before = store.storiesByColumn("backlog").length;

    const result = await store.refineStory(original.id, "dedupe");

    expect(result.source).toBe("fallback");
    expect(result.note).toMatch(/possible overlap|possible duplicate/i);
    expect(result.note).toMatch(/Nothing was deleted/i);
    expect(store.storiesByColumn("backlog").length).toBe(before);
  });

  it("uses the harness model when available to tighten criteria", async () => {
    const modelStore = new BoardStore(`http://127.0.0.1:${TEST_PORT}/mcp`, {
      modelComplete: async () =>
        JSON.stringify([
          {
            name: "Saved filters are confirmed",
            given: "a backlog story with loose criteria",
            when: "the user tightens the criteria",
            then: "the drawer shows observable Gherkin steps",
          },
        ]),
    });
    await modelStore.connect();
    await modelStore.registerAndAttach({
      repo: `${repoId}-model`,
      path: fixtureDir,
      branch: "main",
      model: "vitest-model",
      pid: process.pid,
    });
    const story = await modelStore.createDraftNow({
      kind: "feature",
      title: "Tighten saved filters",
      description: "Saved filters need clearer criteria.",
    });

    const result = await modelStore.refineStory(story.id, "tighten");

    expect(result.source).toBe("model");
    expect(result.story.criteria).toEqual(["Saved filters are confirmed"]);
    expect(result.story.scenarios?.[0].steps[2]).toEqual([
      "Then",
      "the drawer shows observable Gherkin steps",
    ]);
    await modelStore.close();
  });
});
