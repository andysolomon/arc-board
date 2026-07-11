import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Story } from "arc-contracts";
import {
  assertMergeRemediationStory,
  buildMergeRemediationTaskContract,
  MergeRemediation,
  mergeRemediationPrSelector,
  mergeRemediationInputSchema,
  runMergeRemediationPipeline,
} from "../mcp-server/dist/merge-remediation.js";
import { QueueManager } from "../mcp-server/dist/queue.js";
import { SessionRegistry } from "../mcp-server/dist/registry.js";
import { SseHub } from "../mcp-server/dist/sse.js";
import { StoryStore } from "../mcp-server/dist/store.js";

const directories: string[] = [];

afterEach(() => {
  while (directories.length) rmSync(directories.pop()!, { recursive: true, force: true });
});

function story(overrides: Partial<Story> = {}): Story {
  const worktree = mkdtempSync(join(tmpdir(), "arc-remediate-wt-"));
  directories.push(worktree);
  return {
    id: "remediate-1",
    wid: "W-000055",
    type: "story",
    title: "Remediate a blocked merge",
    repo: "acme/arc-board",
    branch: "feat/W-000055",
    worktree,
    column: "review",
    priority: "med",
    size: "S",
    epic: "board",
    taskClass: "feature",
    tags: [],
    description: "Repair a structured merge failure.",
    criteria: [],
    draft: false,
    issue: "#115",
    pr: "https://github.com/acme/arc-board/pull/115",
    ...overrides,
  };
}

function resultBin(result: Record<string, unknown>): string {
  const directory = mkdtempSync(join(tmpdir(), "arc-remediate-bin-"));
  directories.push(directory);
  const bin = join(directory, "orchestrator");
  writeFileSync(bin, `#!/bin/sh\nprintf '%s\\n' '${JSON.stringify(result)}'\n`);
  chmodSync(bin, 0o755);
  return bin;
}

function queueFixture(item: Story) {
  const store = new StoryStore(":memory:");
  const queue = new QueueManager(
    { worktreeRoot: join(tmpdir(), "arc-remediate-queue") },
    { store, registry: new SessionRegistry(), sse: new SseHub() }
  );
  store.upsertStory(item);
  return { store, queue };
}

const completeResult = {
  status: "completed",
  summary: "Fixed the merge blockage.",
  changes: ["src/fix.ts"],
  verification: ["npm test"],
  risks: [],
  next_actions: ["Retry merge"],
};

describe("story.remediateMerge contract and dispatch", () => {
  it("validates only remediable structured merge failures", () => {
    expect(mergeRemediationInputSchema.parse({ id: "story", code: "checks_failed" })).toEqual({ id: "story", code: "checks_failed" });
    expect(() => mergeRemediationInputSchema.parse({ id: "story", code: "checks_pending" })).toThrow();
    expect(() => mergeRemediationInputSchema.parse({ id: "story", code: "timeout" })).toThrow();
  });

  it("forces composer/implement, streams activity, and requires Retry merge in the worker handoff", async () => {
    const item = story();
    const lines: Array<{ route: string; kind: string; text: string; status?: string }> = [];
    const outcome = await runMergeRemediationPipeline(
      item,
      async (route, kind, text, status) => { lines.push({ route, kind, text, status }); },
      { bin: resultBin(completeResult) }
    );

    expect(outcome.runRecord.route).toBe("composer-implement");
    expect(lines.some((line) => line.route === "composer-implement" && line.kind === "cmd" && line.text.includes("--backend composer --mode implement"))).toBe(true);
    expect(lines.some((line) => line.kind === "lock")).toBe(true);
    expect(lines.some((line) => line.kind === "unlock")).toBe(true);
    expect(new Set(lines.filter((line) => line.status === "done").map((line) => line.route))).toEqual(
      new Set(["composer-implement", "fable"])
    );
    const contract = buildMergeRemediationTaskContract(item);
    expect(contract).toContain("gh pr view 115");
    expect(contract).toContain("Do not merge the PR");
    expect(contract).toContain("Do not force-push any branch");
    expect(contract).toContain("Never push, rewrite, or force-push main");
    expect(contract).toContain('exact string "Retry merge"');
  });

  it("rejects an otherwise valid worker result that omits Retry merge and releases the write lock", async () => {
    const item = story();
    const lines: Array<{ kind: string }> = [];
    await expect(
      runMergeRemediationPipeline(item, async (_route, kind) => { lines.push({ kind }); }, {
        bin: resultBin({ ...completeResult, next_actions: [] }),
      })
    ).rejects.toThrow(/Retry merge/);
    expect(lines.some((line) => line.kind === "unlock")).toBe(true);
    expect(lines.at(-1)?.kind).toBe("out");
  });

  it("dispatches only an eligible review story and preserves its review column and worktree", async () => {
    const item = story();
    const { store, queue } = queueFixture(item);
    const update = vi.spyOn(queue, "update");
    const remediation = new MergeRemediation(queue, store, { bin: resultBin(completeResult) });

    const returned = await remediation.remediate(item.id, "behind_base");
    expect(returned.column).toBe("review");
    expect(returned.worktree).toBe(item.worktree);
    expect(store.getStory(item.id)).toMatchObject({ column: "review", worktree: item.worktree });
    expect(store.getHandoff(item.id)?.next_actions).toContain("Retry merge");
    expect(store.getRunsForStory(item.id)).toEqual([expect.objectContaining({ route: "composer-implement" })]);
    expect(update).toHaveBeenCalled();
  });

  it("atomically rejects a second remediation and keeps merge from removing the remediation-owned worktree", async () => {
    const item = story();
    const { store, queue } = queueFixture(item);
    const originalUpdate = queue.update.bind(queue);
    let releaseFirstUpdate!: () => void;
    const firstUpdate = new Promise<void>((resolve) => { releaseFirstUpdate = resolve; });
    let first = true;
    vi.spyOn(queue, "update").mockImplementation(async (args) => {
      if (first) {
        first = false;
        await expect(queue.merge(item.id)).rejects.toThrow(/merge remediation/);
        await firstUpdate;
      }
      return originalUpdate(args);
    });
    const remediation = new MergeRemediation(queue, store, { bin: resultBin(completeResult) });

    const initial = remediation.remediate(item.id, "checks_failed");
    await Promise.resolve();
    await expect(remediation.remediate(item.id, "checks_failed")).rejects.toThrow(/already running/);
    releaseFirstUpdate();
    await expect(initial).resolves.toMatchObject({ id: item.id, column: "review", worktree: item.worktree });
  });

  it("releases only the matching worktree lock owner", () => {
    const { queue } = queueFixture(story());
    expect(queue.acquireWrite("/tmp/owner-safe", "remediation-a")).toBe(true);
    expect(queue.releaseWrite("/tmp/owner-safe", "remediation-b")).toBe(false);
    expect(queue.writeLockHolder("/tmp/owner-safe")).toBe("remediation-a");
    expect(queue.releaseWrite("/tmp/owner-safe", "remediation-a")).toBe(true);
  });

  it("accepts only numeric PR representations or a matching GitHub pull URL", () => {
    expect(mergeRemediationPrSelector("acme/arc-board", "115")).toBe("115");
    expect(mergeRemediationPrSelector("acme/arc-board", "#115")).toBe("115");
    expect(mergeRemediationPrSelector("acme/arc-board", "https://github.com/acme/arc-board/pull/115")).toBe("115");
    expect(() => mergeRemediationPrSelector("acme/arc-board", "#115 --repo other/repo")).toThrow(/invalid GitHub PR/);
    expect(() => mergeRemediationPrSelector("acme/arc-board", "https://github.com/other/repo/pull/115")).toThrow(/invalid GitHub PR/);
    expect(() => buildMergeRemediationTaskContract(story({ repo: "acme/arc board" }))).toThrow(/invalid GitHub repository/);
  });

  it("persists a blocked handoff and run before reporting the worker's blocked result", async () => {
    const item = story();
    const { store, queue } = queueFixture(item);
    const remediation = new MergeRemediation(queue, store, {
      bin: resultBin({ ...completeResult, status: "blocked", summary: "Blocked by repository policy." }),
    });

    await expect(remediation.remediate(item.id, "branch_policy")).rejects.toThrow("Blocked by repository policy.");
    expect(store.getHandoff(item.id)).toMatchObject({ status: "blocked", next_actions: ["Retry merge"] });
    expect(store.getRunsForStory(item.id)).toEqual([expect.objectContaining({ route: "composer-implement", outcome: "blocked" })]);
  });

  it("safely rejects unknown, non-review, and no-worktree stories", async () => {
    const item = story();
    const { store, queue } = queueFixture(item);
    const remediation = new MergeRemediation(queue, store, { bin: resultBin(completeResult) });
    await expect(remediation.remediate("missing", "unknown")).rejects.toThrow("Unknown story");

    store.upsertStory({ ...item, id: "not-review", column: "backlog" });
    await expect(remediation.remediate("not-review", "unknown")).rejects.toThrow("Only review stories");

    store.upsertStory({ ...item, id: "no-worktree", worktree: "" });
    await expect(remediation.remediate("no-worktree", "unknown")).rejects.toThrow("has no worktree");
    expect(() => assertMergeRemediationStory({ ...item, worktree: "" })).toThrow("has no worktree");
  });
});
