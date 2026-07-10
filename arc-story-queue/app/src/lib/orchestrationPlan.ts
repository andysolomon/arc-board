import type { Story } from "arc-contracts";
import { routeColor, routeLabel, routeModel } from "arc-contracts";

export type PlanStatus = NonNullable<Story["orchestration"]>["status"];

export interface PlanBadge {
  label: string;
  slug: PlanStatus;
}

const BADGE_LABELS: Record<PlanStatus, string> = {
  unplanned: "Unplanned",
  planning: "Planning…",
  planned: "Ready",
  failed: "Plan failed",
};

/** Durable plan state; stories persisted before W-000041 have no orchestration yet. */
export function planStatus(story: Pick<Story, "orchestration">): PlanStatus {
  return story.orchestration?.status ?? "unplanned";
}

/** Queued-card badge copy for a story's orchestration state. */
export function planBadge(story: Pick<Story, "orchestration">): PlanBadge {
  const slug = planStatus(story);
  return { label: BADGE_LABELS[slug], slug };
}

export interface PlanDetailRow {
  label: string;
  slug: string;
  color: string;
  value: string;
}

/** Local wall-clock rendering of the solidified plan's timestamp. */
export function formatPlannedAt(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/**
 * Rows for the drawer's solidified-plan section, color-coded like the
 * Delegation-contract rows. Pure so the drawer section stays unit-testable
 * in the node test env (no JSX / React import).
 */
export function planDetailRows(story: Pick<Story, "orchestration">): PlanDetailRow[] {
  const plan = story.orchestration;
  if (!plan || plan.status !== "planned") return [];
  const model = [routeModel(plan.route), plan.backend].filter(Boolean).join(" · ");
  return [
    { label: "Route", slug: "route", color: routeColor(plan.route), value: routeLabel(plan.route) },
    { label: "Model", slug: "model", color: "#7c9cff", value: model },
    { label: "Mode", slug: "mode", color: "#c084fc", value: plan.mode },
    { label: "Complexity", slug: "complexity", color: "#f5b544", value: plan.complexity },
    { label: "Rationale", slug: "rationale", color: "#3ecf8e", value: plan.rationale },
    { label: "Planned at", slug: "planned-at", color: "#8b93a7", value: formatPlannedAt(plan.plannedAt) },
  ];
}
