import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { RoutingTraceSidecar } from "arc-contracts";
import { applyRunTraceView, ingestOrchestratorTrace } from "../mcp-server/dist/orchestrator-executor.js";
import { StoryStore } from "../mcp-server/dist/store.js";

const FIXTURE_DIR = join(dirname(fileURLToPath(import.meta.url)), "fixtures/orchestrator-traces");
const V2_FIXTURE = JSON.parse(readFileSync(join(FIXTURE_DIR, "routing-trace-v2.json"), "utf8")) as RoutingTraceSidecar;

const CONTEXT = { storyId: "story-rollback", repo: "owner/repo" };

describe("board rollback view", () => {
  it("switches reader/view without rewriting sidecar history", () => {
    const store = new StoryStore(":memory:");
    const ingested = ingestOrchestratorTrace(V2_FIXTURE, CONTEXT);
    store.persistRunWithSidecar(ingested.runRecord, ingested.sidecar);

    expect(store.getRunTraceView()).toBe("v2-aware");
    const v2Aware = store.getRuns()[0]!;
    expect(v2Aware.route).toBe("codex-implement");
    expect(v2Aware.model).toBe("composer-2.5");

    store.setRunTraceView("legacy");
    const legacyView = store.getRuns()[0]!;
    expect(legacyView.route).toBe("codex-implement");
    expect(legacyView.model).toBe("composer-2.5");
    expect(legacyView.changed).toBe(4);

    expect(store.listRoutingTraceSidecars()).toHaveLength(1);
    expect(store.getRoutingTraceSidecar("run-v2-1")?.lineage.run_id).toBe("run-v2-1");
    expect(store.getStoredRun("run-v2-1")).toEqual(ingested.runRecord);
  });

  it("replays v2 sidecar events after rollback toggles", () => {
    const store = new StoryStore(":memory:");
    const ingested = ingestOrchestratorTrace(V2_FIXTURE, CONTEXT);
    store.persistRunWithSidecar(ingested.runRecord, ingested.sidecar);
    store.setRunTraceView("legacy");

    const sidecar = store.getRoutingTraceSidecar("run-v2-1");
    expect(sidecar).not.toBeNull();
    const replayed = applyRunTraceView(store.getStoredRun("run-v2-1")!, sidecar, "v2-aware");
    expect(replayed.route).toBe("codex-implement");
    expect(replayed.model).toBe("composer-2.5");
    expect(replayed.backend).toBe("Cursor Agent");

    store.setRunTraceView("v2-aware");
    expect(store.getRuns()[0]).toEqual(replayed);
  });

  it("listRunsWithTrace hides sidecars in legacy mode and replays them in v2-aware", () => {
    const store = new StoryStore(":memory:");
    const ingested = ingestOrchestratorTrace(V2_FIXTURE, CONTEXT);
    store.persistRunWithSidecar(ingested.runRecord, ingested.sidecar);

    const v2AwareJoined = store.listRunsWithTrace()[0]!;
    expect(v2AwareJoined.run.route).toBe("codex-implement");
    expect(v2AwareJoined.routingTrace).toEqual(ingested.sidecar);
    expect(v2AwareJoined.routingTrace).toEqual(store.getRoutingTraceSidecar("run-v2-1"));

    store.setRunTraceView("legacy");
    const legacyJoined = store.listRunsWithTrace()[0]!;
    expect(legacyJoined.run.route).toBe("codex-implement");
    expect(legacyJoined.run.changed).toBe(4);
    expect(legacyJoined.routingTrace).toBeNull();
    expect(store.getRoutingTraceSidecar("run-v2-1")).toEqual(ingested.sidecar);

    store.setRunTraceView("v2-aware");
    const replayedJoined = store.listRunsWithTrace()[0]!;
    expect(replayedJoined.run).toEqual(v2AwareJoined.run);
    expect(replayedJoined.routingTrace).toEqual(ingested.sidecar);
    expect(JSON.stringify(replayedJoined.routingTrace)).toBe(JSON.stringify(ingested.sidecar));
  });
});
