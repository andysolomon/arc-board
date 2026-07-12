import Ajv, { type ValidateFunction } from "ajv";

export const ROUTING_TRACE_V2_CONTRACT = "orchestrator-routing-trace/v2" as const;

export type RoutingTraceV2AliasKind = "executable-route" | "public-surface";

export type LegacyTraceEffort = "none" | "low" | "medium" | "high" | "xhigh" | "max";
export type LegacyTraceFailureClass = "backend_unavailable";
export type LegacyTraceOutageReason = "usage_limit" | "auth" | "missing_binary";
export type LegacyTraceBackend = "codex" | "composer" | "claude";

export type LegacySchema4Trace = {
  schema: 4;
  run_id: string;
  timestamp: string;
  backend: LegacyTraceBackend;
  mode: "analyze" | "implement" | "review";
  model: string;
  sandbox: "read-only" | "workspace-write";
  project: string;
  label: string | null;
  task_class: string | null;
  route_rationale: string | null;
  duration_ms: number;
  status: "completed" | "blocked" | "error";
  exit_code: number;
  changed_files: number | null;
  tokens: {
    input_tokens: number;
    cached_input_tokens: number | null;
    output_tokens: number;
    total_tokens: number;
  } | null;
  budget: unknown;
  error: string | null;
  outcome?: "accepted" | "rejected" | "blocked" | "verification-failed" | "escalated" | null;
  effort?: LegacyTraceEffort;
  failure_class?: LegacyTraceFailureClass;
  outage_reason?: LegacyTraceOutageReason;
  fallback?: { backend: LegacyTraceBackend; model: string };
  fallback_of?: string;
  routingShadow?: Record<string, unknown>;
  routing_shadow_error?: string | null;
};

export type RoutingTraceSidecar = {
  contract: typeof ROUTING_TRACE_V2_CONTRACT;
  schema: number;
  timestamp: string;
  status: LegacySchema4Trace["status"];
  route: {
    requested_public_alias: string | null;
    requested_alias_kind: RoutingTraceV2AliasKind | null;
    canonical_capability_route: string | null;
  };
  models: {
    requested: string | null;
    candidate: string | null;
    attempted: string | null;
    selected: string | null;
  };
  serving: {
    provider: string | null;
    provider_model_id: string | null;
    transport_backend: string | null;
    adapter_id: string | null;
    adapter_version: string | null;
    stable_id: string | null;
  };
  traversal: {
    candidate_index: number | null;
    attempt_index: number | null;
    stack_size: number | null;
    traversal_id: string | null;
  };
  failure: {
    normalized_class: string | null;
    detail: string | null;
    fallback_source: string | null;
    fallback_destination: string | null;
    fallback_reason: string | null;
    terminal_reason: string | null;
  };
  authorization: {
    override_requested: boolean;
    override_applied: boolean;
    explicit_parent_escalation: boolean;
    sol_authorized: boolean;
  };
  lineage: {
    root_run_id: string;
    parent_run_id: string | null;
    run_id: string;
    task_id: string | null;
    depth: number;
    scheduler_id: string | null;
  };
  worktree: {
    checkout_id: string;
  };
  versions: {
    policy: string;
    budget_policy: string;
    registry: number;
    capability_routes: number;
    routing_shadow: number;
    routing_trace: number;
  };
  budgets: {
    root: RoutingTraceBudgetScope;
    dispatch: RoutingTraceBudgetScope;
  };
  legacy: LegacySchema4Trace;
};

export type RoutingTraceBudgetMeasurement = "known" | "unknown";

export type RoutingTraceBudgetDimension = {
  allocated: number | null;
  consumed: number;
  remaining: number | null;
  measurement?: RoutingTraceBudgetMeasurement;
};

export type RoutingTraceBudgetScope = {
  token: RoutingTraceBudgetDimension;
  wall_time_ms: RoutingTraceBudgetDimension;
  call: RoutingTraceBudgetDimension;
  cost: RoutingTraceBudgetDimension;
  concurrency: RoutingTraceBudgetDimension;
};

export type RunTraceViewMode = "v2-aware" | "legacy";

type JsonSchema = Record<string, unknown>;

const nonEmptyString = { type: "string", minLength: 1 } as const;

const budgetDimensionSchema: JsonSchema = {
  type: "object",
  required: ["allocated", "consumed", "remaining"],
  properties: {
    allocated: { type: ["number", "null"], minimum: 0 },
    consumed: { type: "number", minimum: 0 },
    remaining: { type: ["number", "null"] },
    measurement: { enum: ["known", "unknown"] },
  },
  additionalProperties: false,
};

const budgetScopeSchema: JsonSchema = {
  type: "object",
  required: ["token", "wall_time_ms", "call", "cost", "concurrency"],
  properties: {
    token: budgetDimensionSchema,
    wall_time_ms: budgetDimensionSchema,
    call: budgetDimensionSchema,
    cost: budgetDimensionSchema,
    concurrency: budgetDimensionSchema,
  },
  additionalProperties: false,
};

const legacySchema4Schema: JsonSchema = {
  type: "object",
  required: [
    "schema",
    "run_id",
    "timestamp",
    "backend",
    "mode",
    "model",
    "sandbox",
    "project",
    "label",
    "task_class",
    "route_rationale",
    "duration_ms",
    "status",
    "exit_code",
    "changed_files",
    "tokens",
    "budget",
    "error",
  ],
  properties: {
    schema: { const: 4 },
    run_id: nonEmptyString,
    timestamp: nonEmptyString,
    backend: { enum: ["codex", "composer", "claude"] },
    mode: { enum: ["analyze", "implement", "review"] },
    model: nonEmptyString,
    sandbox: { enum: ["read-only", "workspace-write"] },
    project: nonEmptyString,
    label: { type: ["string", "null"] },
    task_class: { type: ["string", "null"] },
    route_rationale: { type: ["string", "null"] },
    duration_ms: { type: "integer", minimum: 0 },
    status: { enum: ["completed", "blocked", "error"] },
    exit_code: { type: "integer" },
    changed_files: { type: ["integer", "null"], minimum: 0 },
    tokens: {
      oneOf: [
        { type: "null" },
        {
          type: "object",
          required: ["input_tokens", "cached_input_tokens", "output_tokens", "total_tokens"],
          properties: {
            input_tokens: { type: "integer", minimum: 0 },
            cached_input_tokens: { type: ["integer", "null"], minimum: 0 },
            output_tokens: { type: "integer", minimum: 0 },
            total_tokens: { type: "integer", minimum: 0 },
          },
          additionalProperties: false,
        },
      ],
    },
    budget: {},
    error: { type: ["string", "null"] },
    outcome: {
      enum: ["accepted", "rejected", "blocked", "verification-failed", "escalated", null],
    },
    effort: { enum: ["none", "low", "medium", "high", "xhigh", "max"] },
    failure_class: { enum: ["backend_unavailable"] },
    outage_reason: { enum: ["usage_limit", "auth", "missing_binary"] },
    fallback: {
      type: "object",
      required: ["backend", "model"],
      properties: {
        backend: { enum: ["codex", "composer", "claude"] },
        model: nonEmptyString,
      },
      additionalProperties: false,
    },
    fallback_of: nonEmptyString,
    routingShadow: { type: "object" },
    routing_shadow_error: { type: ["string", "null"] },
  },
  additionalProperties: false,
};

export const routingTraceSidecarSchema: JsonSchema = {
  $schema: "http://json-schema.org/draft-07/schema#",
  $id: "https://arc.dev/schema/routing-trace-sidecar.json",
  title: "RoutingTraceSidecar",
  type: "object",
  required: [
    "contract",
    "schema",
    "timestamp",
    "status",
    "route",
    "models",
    "serving",
    "traversal",
    "failure",
    "authorization",
    "lineage",
    "worktree",
    "versions",
    "budgets",
    "legacy",
  ],
  properties: {
    contract: { const: ROUTING_TRACE_V2_CONTRACT },
    schema: { const: 2 },
    timestamp: nonEmptyString,
    status: { enum: ["completed", "blocked", "error"] },
    route: {
      type: "object",
      required: ["requested_public_alias", "requested_alias_kind", "canonical_capability_route"],
      properties: {
        requested_public_alias: { type: ["string", "null"] },
        requested_alias_kind: { enum: ["executable-route", "public-surface", null] },
        canonical_capability_route: { type: ["string", "null"] },
      },
      additionalProperties: false,
    },
    models: {
      type: "object",
      required: ["requested", "candidate", "attempted", "selected"],
      properties: {
        requested: { type: ["string", "null"] },
        candidate: { type: ["string", "null"] },
        attempted: { type: ["string", "null"] },
        selected: { type: ["string", "null"] },
      },
      additionalProperties: false,
    },
    serving: {
      type: "object",
      required: [
        "provider",
        "provider_model_id",
        "transport_backend",
        "adapter_id",
        "adapter_version",
        "stable_id",
      ],
      properties: {
        provider: { type: ["string", "null"] },
        provider_model_id: { type: ["string", "null"] },
        transport_backend: { type: ["string", "null"] },
        adapter_id: { type: ["string", "null"] },
        adapter_version: { type: ["string", "null"] },
        stable_id: { type: ["string", "null"] },
      },
      additionalProperties: false,
    },
    traversal: {
      type: "object",
      required: ["candidate_index", "attempt_index", "stack_size", "traversal_id"],
      properties: {
        candidate_index: { type: ["integer", "null"], minimum: 0 },
        attempt_index: { type: ["integer", "null"], minimum: 0 },
        stack_size: { type: ["integer", "null"], minimum: 0 },
        traversal_id: { type: ["string", "null"] },
      },
      additionalProperties: false,
    },
    failure: {
      type: "object",
      required: [
        "normalized_class",
        "detail",
        "fallback_source",
        "fallback_destination",
        "fallback_reason",
        "terminal_reason",
      ],
      properties: {
        normalized_class: { type: ["string", "null"] },
        detail: { type: ["string", "null"] },
        fallback_source: { type: ["string", "null"] },
        fallback_destination: { type: ["string", "null"] },
        fallback_reason: { type: ["string", "null"] },
        terminal_reason: { type: ["string", "null"] },
      },
      additionalProperties: false,
    },
    authorization: {
      type: "object",
      required: [
        "override_requested",
        "override_applied",
        "explicit_parent_escalation",
        "sol_authorized",
      ],
      properties: {
        override_requested: { type: "boolean" },
        override_applied: { type: "boolean" },
        explicit_parent_escalation: { type: "boolean" },
        sol_authorized: { type: "boolean" },
      },
      additionalProperties: false,
    },
    lineage: {
      type: "object",
      required: ["root_run_id", "parent_run_id", "run_id", "task_id", "depth", "scheduler_id"],
      properties: {
        root_run_id: nonEmptyString,
        parent_run_id: { type: ["string", "null"] },
        run_id: nonEmptyString,
        task_id: { type: ["string", "null"] },
        depth: { type: "integer", minimum: 0 },
        scheduler_id: { type: ["string", "null"] },
      },
      additionalProperties: false,
    },
    worktree: {
      type: "object",
      required: ["checkout_id"],
      properties: {
        checkout_id: nonEmptyString,
      },
      additionalProperties: false,
    },
    versions: {
      type: "object",
      required: ["policy", "budget_policy", "registry", "capability_routes", "routing_shadow", "routing_trace"],
      properties: {
        policy: nonEmptyString,
        budget_policy: nonEmptyString,
        registry: { type: "integer", minimum: 0 },
        capability_routes: { type: "integer", minimum: 0 },
        routing_shadow: { type: "integer", minimum: 0 },
        routing_trace: { type: "integer", minimum: 2 },
      },
      additionalProperties: false,
    },
    budgets: {
      type: "object",
      required: ["root", "dispatch"],
      properties: {
        root: budgetScopeSchema,
        dispatch: budgetScopeSchema,
      },
      additionalProperties: false,
    },
    legacy: legacySchema4Schema,
  },
  additionalProperties: false,
};

let ajvInstance: Ajv | null = null;
let sidecarValidator: ValidateFunction | null = null;

function ajv(): Ajv {
  ajvInstance ??= new Ajv({ allErrors: true });
  return ajvInstance;
}

export function isRoutingTraceSidecar(value: unknown): value is RoutingTraceSidecar {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { contract?: unknown }).contract === ROUTING_TRACE_V2_CONTRACT
  );
}

export function validateRoutingTraceSidecar(value: unknown): value is RoutingTraceSidecar {
  sidecarValidator ??= ajv().compile(routingTraceSidecarSchema);
  if (!sidecarValidator(value)) {
    throw new Error(
      `Invalid RoutingTraceSidecar: ${ajv().errorsText(sidecarValidator.errors, { separator: "; " })}`
    );
  }
  return true;
}

export function isLegacySchema4Trace(value: unknown): value is LegacySchema4Trace {
  return typeof value === "object" && value !== null && (value as { schema?: unknown }).schema === 4;
}
