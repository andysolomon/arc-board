import { describe, expect, it } from "vitest";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { Story } from "arc-contracts";
import {
  orchestratorRunArgs,
  resolveOrchestrationExecution,
  runOrchestratorPipeline,
  type StreamLineFn,
} from "../mcp-server/dist/orchestrator-executor.js";

function story(overrides: Partial<Story> = {}): Story {
  return {
    id: "exec-1",
    wid: "W-000044",
    type: "story",
    title: "Executor honors plan",
    repo: "test/executor",
    branch: "feat/executor",
    worktree: "/tmp/executor-wt",
    column: "in_progress",
    priority: "med",
    size: "S",
    epic: "",
    taskClass: "feature",
    tags: [],
    description: "Use the persisted orchestration plan.",
    criteria: ["planned route drives execution"],
    draft: false,
    issue: "#44",
    ...overrides,
  };
}

function plannedOrchestration(
  route: "codex-implement" | "composer-implement" | "opus-implement" = "codex-implement",
  backend: "codex" | "composer" | "claude" = "codex"
) {
  return {
    status: "planned" as const,
    route,
    backend,
    mode: "implement",
    rationale: "Fixture plan.",
    complexity: "low",
    plannedAt: "2026-07-10T00:00:00.000Z",
    storyDigest: "digest",
  };
}

function mockStreamLine(): { fn: StreamLineFn; lines: Array<{ route: string; kind: string; text: string }> } {
  const lines: Array<{ route: string; kind: string; text: string }> = [];
  const fn: StreamLineFn = async (_client, _story, route, kind, text) => {
    lines.push({ route, kind, text });
  };
  return { fn, lines };
}

function successOrchestratorBin(directory: string, label = "ok-orchestrator"): string {
  const bin = join(directory, label);
  const payload = JSON.stringify({
    status: "completed",
    summary: "worker finished",
    changes: ["file.ts"],
    verification: ["npm test"],
    risks: [],
    next_actions: [],
  });
  writeFileSync(bin, `#!/bin/sh\nprintf '%s\\n' '${payload}'\n`);
  chmodSync(bin, 0o755);
  return bin;
}

describe("resolveOrchestrationExecution", () => {
  it("uses the planned backend, mode, and route", () => {
    const item = story({ orchestration: plannedOrchestration("codex-implement", "codex") });
    expect(resolveOrchestrationExecution(item)).toEqual({
      backend: "codex",
      mode: "implement",
      route: "codex-implement",
      usedFallback: false,
    });
    const { args } = orchestratorRunArgs(item, "codex", "implement", "fable-orchestrator");
    expect(args).toEqual(expect.arrayContaining(["--backend", "codex", "--mode", "implement"]));
  });

  it("falls back to composer/implement when no plan exists", () => {
    const item = story({ orchestration: { status: "unplanned" } });
    expect(resolveOrchestrationExecution(item)).toEqual({
      backend: "composer",
      mode: "implement",
      route: "composer-implement",
      usedFallback: true,
    });
    expect(resolveOrchestrationExecution(story({ orchestration: null }))).toMatchObject({
      backend: "composer",
      mode: "implement",
      route: "composer-implement",
      usedFallback: true,
    });
  });

  it("fails fast when the persisted route is not registered", () => {
    const item = story({
      orchestration: {
        ...plannedOrchestration(),
        route: "gpt-9-mega" as "codex-implement",
      },
    });
    expect(() => resolveOrchestrationExecution(item)).toThrow(/route.*not registered/);
  });
});

describe("runOrchestratorPipeline", () => {
  it("builds the orchestrator command from the planned route and records the route used", async () => {
    const directory = mkdtempSync(join(tmpdir(), "arc-orchestrator-planned-"));
    const worktree = join(directory, "wt");
    mkdirSync(worktree);
    const bin = successOrchestratorBin(directory);
    const item = story({ worktree, orchestration: plannedOrchestration("codex-implement", "codex") });
    const { fn, lines } = mockStreamLine();

    try {
      const outcome = await runOrchestratorPipeline({} as Client, item, fn, { bin });
      expect(outcome.route).toBe("codex-implement");
      expect(outcome.runRecord.route).toBe("codex-implement");
      expect(outcome.runRecord.backend).toBe("Codex CLI");
      expect(lines.some((line) => line.kind === "cmd" && line.text.includes("--backend codex --mode implement"))).toBe(true);
      expect(lines.some((line) => line.route === "codex-implement" && line.kind === "lock")).toBe(true);
      expect(lines.some((line) => line.text.includes("delegating W-000044 to codex-implement"))).toBe(true);
      expect(lines.some((line) => line.text.includes("falling back"))).toBe(false);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("logs the composer/implement fallback when no orchestration plan exists", async () => {
    const directory = mkdtempSync(join(tmpdir(), "arc-orchestrator-fallback-"));
    const worktree = join(directory, "wt");
    mkdirSync(worktree);
    const bin = successOrchestratorBin(directory);
    const item = story({ worktree, orchestration: { status: "unplanned" } });
    const { fn, lines } = mockStreamLine();

    try {
      const outcome = await runOrchestratorPipeline({} as Client, item, fn, { bin });
      expect(outcome.route).toBe("composer-implement");
      expect(outcome.runRecord.route).toBe("composer-implement");
      expect(lines.some((line) => line.kind === "cmd" && line.text.includes("--backend composer --mode implement"))).toBe(true);
      expect(
        lines.some(
          (line) =>
            line.route === "fable" &&
            line.kind === "out" &&
            line.text.includes("no orchestration plan") &&
            line.text.includes("composer/implement")
        )
      ).toBe(true);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("rejects invalid persisted routes before spawning the orchestrator", async () => {
    const directory = mkdtempSync(join(tmpdir(), "arc-orchestrator-invalid-"));
    const bin = join(directory, "should-not-run");
    writeFileSync(bin, "#!/bin/sh\necho should-not-run >&2\nexit 9\n");
    chmodSync(bin, 0o755);
    const item = story({
      orchestration: {
        ...plannedOrchestration(),
        route: "gpt-9-mega" as "codex-implement",
      },
    });
    const { fn } = mockStreamLine();

    try {
      await expect(runOrchestratorPipeline({} as Client, item, fn, { bin })).rejects.toThrow(/not registered/);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
