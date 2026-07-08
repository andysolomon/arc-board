import {
  routeAccess as contractRouteAccess,
  routeColor as contractRouteColor,
  routeLabel as contractRouteLabel,
  routeModel as contractRouteModel,
  type Access,
  type Column,
  type RouteId,
  type Story,
} from "arc-contracts";

export const BOARD_COLUMNS: Column[] = ["backlog", "queued", "in_progress", "review", "done"];

export const COLUMN_LABELS: Record<Column, string> = {
  backlog: "Backlog",
  queued: "Queued",
  in_progress: "In Progress",
  review: "Review",
  done: "Done",
};

export function routeColor(route: string): string {
  return contractRouteColor(route);
}

export function routeLabel(route: RouteId | string): string {
  return contractRouteLabel(route);
}

export function routeModel(route: RouteId | string): string {
  return contractRouteModel(route);
}

export function routeAccess(route: RouteId | string): Access {
  return contractRouteAccess(route);
}

export function priorityColor(priority: Story["priority"]): string {
  if (priority === "high") return "var(--sq-danger)";
  if (priority === "med") return "var(--sq-running)";
  return "var(--sq-text-4)";
}

export function columnDotColor(column: Column): string {
  const map: Record<Column, string> = {
    backlog: "var(--sq-text-3)",
    queued: "var(--sq-queued)",
    in_progress: "var(--sq-running)",
    review: "var(--sq-review)",
    done: "var(--sq-done)",
  };
  return map[column];
}
