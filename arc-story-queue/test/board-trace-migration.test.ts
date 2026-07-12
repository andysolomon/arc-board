import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { LegacySchema4Trace, RoutingTraceSidecar } from "arc-contracts";
import {
  legacySchema4ToRunRecord,
  resolveRoutingTraceV2Model,
  resolveRoutingTraceV2Route,
  routingTraceV2ToRunRecord,
  SUPPORTED_CANONICAL_CAPABILITY_ROUTES,
  traceInputToRunRecord,
  traceInputsToRunRecords,
} from "../mcp-server/dist/orchestrator-executor.js";

const FIXTURE_DIR = join(dirname(fileURLToPath(import.meta.url)), "fixtures/orchestrator-traces");
const LEGACY_FIXTURE = JSON.parse(readFileSync(join(FIXTURE_DIR, "legacy-schema-4.json"), "utf8")) as LegacySchema4Trace;
const V2_FIXTURE = JSON.parse(readFileSync(join(FIXTURE_DIR, "routing-trace-v2.json"), "utf8")) as RoutingTraceSidecar;
const V2_FALLBACK_FIXTURE = JSON.parse(
  readFileSync(join(FIXTURE_DIR, "routing-trace-v2-fallback-linked.json"), "utf8")
) as RoutingTraceSidecar;

const CONTEXT = { storyId: "story-125", repo: "owner/repo" };

describe("board trace migration dual-read", () => {
  it("projects legacy schema-4 with an explicit caller route", () => {
    const record = legacySchema4ToRunRecord(LEGACY_FIXTURE, { ...CONTEXT, route: "codex-implement" });
    expect(record.id).toBe("run-legacy-1");
    expect(record.route).toBe("codex-implement");
    expect(record.model).toBe("gpt-5.6-terra");
    expect(record.backend).toBe("Codex CLI");
    expect(record.outcome).toBe("accepted");
  });

  it("refuses legacy schema-4 without an explicit route", () => {
    expect(() => traceInputToRunRecord(LEGACY_FIXTURE, CONTEXT)).toThrow(/explicit route/);
  });

  it("projects v2 using requested_public_alias and models.selected", () => {
    const record = routingTraceV2ToRunRecord(V2_FIXTURE, CONTEXT);
    expect(record.id).toBe("run-v2-1");
    expect(record.route).toBe("codex-implement");
    expect(record.model).toBe("composer-2.5");
    expect(record.backend).toBe("Cursor Agent");
    expect(record.label).toBe("W-000074-v2");
  });

  it("does not infer v2 route from legacy backend×mode", () => {
    expect(resolveRoutingTraceV2Route(V2_FIXTURE)).toBe("codex-implement");
    expect(V2_FIXTURE.legacy.backend).toBe("composer");
    expect(V2_FIXTURE.legacy.mode).toBe("implement");
  });

  it("does not infer v2 model from legacy backend×mode or display label", () => {
    expect(resolveRoutingTraceV2Model(V2_FIXTURE)).toBe("composer-2.5");
    expect(V2_FIXTURE.models.requested).toBe("gpt-5.6-terra");
    expect(V2_FIXTURE.legacy.model).toBe("composer-2.5");
  });

  it("preserves mixed legacy and v2 fixture order", () => {
    const records = traceInputsToRunRecords([LEGACY_FIXTURE, V2_FIXTURE], {
      ...CONTEXT,
      route: "codex-implement",
    });
    expect(records.map((record) => record.id)).toEqual(["run-legacy-1", "run-v2-1"]);
    expect(records[0]?.route).toBe("codex-implement");
    expect(records[1]?.route).toBe("codex-implement");
    expect(records[1]?.model).toBe("composer-2.5");
  });

  it("rejects v2 records with unsupported route identity", () => {
    const brokenAlias: RoutingTraceSidecar = {
      ...V2_FIXTURE,
      route: {
        requested_public_alias: "unknown-route",
        requested_alias_kind: "executable-route",
        canonical_capability_route: null,
      },
    };
    expect(() => resolveRoutingTraceV2Route(brokenAlias)).toThrow(/unsupported route identity/);

    const brokenCanonical: RoutingTraceSidecar = {
      ...V2_FIXTURE,
      route: {
        requested_public_alias: null,
        requested_alias_kind: null,
        canonical_capability_route: "missing.capability.v9",
      },
    };
    expect(() => resolveRoutingTraceV2Route(brokenCanonical)).toThrow(/unsupported canonical capability route/);
  });

  it("maps canonical capability routes to registered board routes only", () => {
    expect(SUPPORTED_CANONICAL_CAPABILITY_ROUTES).toEqual([
      "explore.read-only.v1",
      "implement.workspace-write.v1",
      "check.read-only.v1",
      "taste-review.read-only.v1",
    ]);

    const cases: Array<[string, string]> = [
      ["explore.read-only.v1", "codex-explore"],
      ["implement.workspace-write.v1", "composer-implement"],
      ["check.read-only.v1", "codex-check"],
      ["taste-review.read-only.v1", "opus-review"],
    ];
    for (const [canonical, route] of cases) {
      const trace: RoutingTraceSidecar = {
        ...V2_FIXTURE,
        route: {
          requested_public_alias: null,
          requested_alias_kind: null,
          canonical_capability_route: canonical,
        },
      };
      expect(resolveRoutingTraceV2Route(trace)).toBe(route);
    }
  });

  it("resolves fallback-linked v2 traces from canonical explore identity", () => {
    const record = routingTraceV2ToRunRecord(V2_FALLBACK_FIXTURE, CONTEXT);
    expect(record.id).toBe("run-fallback-1");
    expect(record.route).toBe("codex-explore");
    expect(record.model).toBe("opus-4.8");
    expect(V2_FALLBACK_FIXTURE.legacy.fallback_of).toBe("run-outage-1");
    expect(V2_FALLBACK_FIXTURE.legacy.backend).toBe("claude");
    expect(V2_FALLBACK_FIXTURE.legacy.mode).toBe("analyze");
  });
});
