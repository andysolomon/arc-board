import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import Ajv from "ajv";
import { describe, expect, it } from "vitest";
import {
  runRecordSchema,
  routingTraceSidecarSchema,
  validateRunRecord,
  validateRoutingTraceSidecar,
  type LegacySchema4Trace,
  type RoutingTraceSidecar,
  type RunRecord,
} from "arc-contracts";
import { routingTraceV2ToRunRecord } from "../mcp-server/dist/orchestrator-executor.js";

const FIXTURE_DIR = join(dirname(fileURLToPath(import.meta.url)), "fixtures/orchestrator-traces");
const LEGACY_FIXTURE = JSON.parse(readFileSync(join(FIXTURE_DIR, "legacy-schema-4.json"), "utf8")) as LegacySchema4Trace;
const LEGACY_OUTAGE_FIXTURE = JSON.parse(
  readFileSync(join(FIXTURE_DIR, "legacy-schema-4-outage.json"), "utf8")
) as LegacySchema4Trace;
const V2_FIXTURE = JSON.parse(readFileSync(join(FIXTURE_DIR, "routing-trace-v2.json"), "utf8")) as RoutingTraceSidecar;
const V2_OUTAGE_FIXTURE = JSON.parse(
  readFileSync(join(FIXTURE_DIR, "routing-trace-v2-outage.json"), "utf8")
) as RoutingTraceSidecar;
const V2_FALLBACK_FIXTURE = JSON.parse(
  readFileSync(join(FIXTURE_DIR, "routing-trace-v2-fallback-linked.json"), "utf8")
) as RoutingTraceSidecar;
const STANDALONE_SCHEMA = JSON.parse(
  readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "../packages/arc-contracts/schema/routing-trace-sidecar.schema.json"),
    "utf8"
  )
);

function compileValidator(schema: Record<string, unknown>) {
  return new Ajv({ allErrors: true }).compile(schema);
}

describe("board schema compatibility", () => {
  it("keeps RunRecord closed to undeclared fields", () => {
    expect(runRecordSchema.additionalProperties).toBe(false);
    const base = routingTraceV2ToRunRecord(V2_FIXTURE, { storyId: "story-125", repo: "owner/repo" });
    expect(() => validateRunRecord({ ...base, routingTrace: V2_FIXTURE })).toThrow(/Invalid RunRecord/);
  });

  it("validates routing trace sidecars separately from RunRecord", () => {
    expect(routingTraceSidecarSchema.additionalProperties).toBe(false);
    expect(() => validateRoutingTraceSidecar({ ...V2_FIXTURE, extra: true })).toThrow(
      /Invalid RoutingTraceSidecar/
    );
    expect(validateRoutingTraceSidecar(V2_FIXTURE)).toBe(true);
  });

  it("keeps inline and standalone routing trace schemas in parity", () => {
    const inline = compileValidator(routingTraceSidecarSchema);
    const standalone = compileValidator(STANDALONE_SCHEMA);
    const payloads = [V2_FIXTURE, V2_OUTAGE_FIXTURE, V2_FALLBACK_FIXTURE, { ...V2_FIXTURE, extra: true }];
    for (const payload of payloads) {
      const inlineOk = inline(payload) === true;
      const standaloneOk = standalone(payload) === true;
      expect(standaloneOk).toBe(inlineOk);
    }
  });

  it("accepts legacy outage and joined optional TraceRecord/v2 fields", () => {
    expect(validateRoutingTraceSidecar(V2_OUTAGE_FIXTURE)).toBe(true);
    expect(validateRoutingTraceSidecar(V2_FALLBACK_FIXTURE)).toBe(true);
    expect(V2_OUTAGE_FIXTURE.legacy.failure_class).toBe("backend_unavailable");
    expect(V2_OUTAGE_FIXTURE.legacy.routingShadow).toMatchObject({ candidate: "composer-implement" });
    expect(V2_FALLBACK_FIXTURE.legacy.fallback_of).toBe("run-outage-1");
    expect(LEGACY_OUTAGE_FIXTURE.failure_class).toBe("backend_unavailable");
    expect(LEGACY_OUTAGE_FIXTURE.fallback).toEqual({ backend: "claude", model: "opus-4.8" });
  });

  it("rejects unknown legacy embedded properties", () => {
    const broken = {
      ...V2_FIXTURE,
      legacy: { ...V2_FIXTURE.legacy, surprise_field: true },
    };
    expect(() => validateRoutingTraceSidecar(broken)).toThrow(/Invalid RoutingTraceSidecar/);
  });

  it("accepts strict RunRecord projections from both fixtures", () => {
    const v2Record = routingTraceV2ToRunRecord(V2_FIXTURE, { storyId: "story-v2", repo: "owner/repo" });
    expect(validateRunRecord(v2Record)).toBe(true);

    const legacyRecord: RunRecord = {
      id: LEGACY_FIXTURE.run_id,
      storyId: "story-legacy",
      label: LEGACY_FIXTURE.label ?? "legacy",
      repo: "owner/repo",
      route: "codex-implement",
      backend: "Codex CLI",
      model: LEGACY_FIXTURE.model,
      access: "write",
      tokens: LEGACY_FIXTURE.tokens?.total_tokens ?? 0,
      durMs: LEGACY_FIXTURE.duration_ms,
      status: "completed",
      changed: LEGACY_FIXTURE.changed_files ?? 0,
      outcome: LEGACY_FIXTURE.outcome ?? "unrated",
    };
    expect(validateRunRecord(legacyRecord)).toBe(true);
  });
});
